import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as https from 'https';
import * as crypto from 'crypto';
import { backOff } from 'exponential-backoff';
import { Logger } from 'homebridge';
import { AuthManager } from './auth';
import {
  ApiVehicle,
  ClimateProfile,
  GviResponse,
  GvlVehicleSummary,
  SeatLevel,
  StoredToken,
  VehicleStatus,
} from './types';
import { KIA_API_BASE, KIA_API_HOST } from '../settings';

/**
 * Thin wrapper around the Kia Connect mobile API.
 *
 * All public methods handle session renewal transparently — if a request
 * fails with an invalid-session error the session is invalidated, a new one
 * is obtained, and the call is retried once.
 *
 * The vehicle key (vinKey) is session-specific.  It is resolved once per
 * session and cached; the cache is automatically invalidated whenever the
 * access token changes.
 */
export class KiaClient {
  private readonly http: AxiosInstance;
  private readonly httpsAgent: https.Agent;

  /** Cached (vehicleKey) resolved for the configured VIN, keyed by accessToken. */
  private cachedVehicleKey: string | null = null;
  private cachedVehicleKeyForToken: string | null = null;

  constructor(
    private readonly vin: string,
    private readonly auth: AuthManager,
    private readonly log: Logger,
  ) {
    // Prefer IPv4 for Kia endpoints. Some networks get Cloudflare-blocked on IPv6.
    this.httpsAgent = new https.Agent({ keepAlive: true, family: 4 });
    this.http = axios.create({
      httpsAgent: this.httpsAgent,
      timeout: 20_000,
    });
  }

  // ─── Public: vehicle status ───────────────────────────────────────────────

  async getStatus(): Promise<VehicleStatus> {
    const raw = await this.withSession((token, vehicleKey) =>
      this.fetchGvi(token, vehicleKey),
    );
    return this.parseStatus(raw);
  }

  // ─── Public: remote commands ──────────────────────────────────────────────

  async lock(): Promise<void> {
    const xid = await this.withSession((token, vehicleKey) =>
      this.remoteGet(token, vehicleKey, 'rems/door/lock'),
    );
    await this.pollTransaction(xid);
  }

  async unlock(): Promise<void> {
    const xid = await this.withSession((token, vehicleKey) =>
      this.remoteGet(token, vehicleKey, 'rems/door/unlock'),
    );
    await this.pollTransaction(xid);
  }

  async startClimate(profile: ClimateProfile): Promise<void> {
    const xid = await this.withSession((token, vehicleKey) =>
      this.remoteStartClimate(token, vehicleKey, profile),
    );
    await this.pollTransaction(xid);
  }

  async stopClimate(): Promise<void> {
    const xid = await this.withSession((token, vehicleKey) =>
      this.remoteGet(token, vehicleKey, 'rems/stop'),
    );
    await this.pollTransaction(xid);
  }

  // ─── Private: session + retry wrapper ────────────────────────────────────

  private async withSession<T>(
    fn: (token: StoredToken, vehicleKey: string) => Promise<T>,
  ): Promise<T> {
    try {
      const token = await this.auth.getValidSession();
      const vehicleKey = await this.resolveVehicleKey(token);
      return await fn(token, vehicleKey);
    } catch (err) {
      if (this.isSessionError(err)) {
        this.log.debug('[Kia] Session expired mid-request — re-authenticating…');
        this.auth.invalidateSession();
        const newToken = await this.auth.getValidSession();
        const newKey = await this.resolveVehicleKey(newToken);
        return fn(newToken, newKey);
      }
      if (this.isRemoteBusyError(err)) {
        this.log.debug('[Kia] Vehicle reports another remote command in progress — retrying once…');
        await new Promise<void>((resolve) => setTimeout(resolve, 4_000));
        const retryToken = await this.auth.getValidSession();
        const retryKey = await this.resolveVehicleKey(retryToken);
        return fn(retryToken, retryKey);
      }
      throw err;
    }
  }

  // ─── Private: vehicle key resolution ──────────────────────────────────────

  private async resolveVehicleKey(token: StoredToken): Promise<string> {
    if (
      this.cachedVehicleKeyForToken === token.accessToken &&
      this.cachedVehicleKey !== null
    ) {
      return this.cachedVehicleKey;
    }

    this.log.debug('[Kia] Resolving vehicle key for VIN', this.vin);
    const vehicles = await this.fetchVehicleList(token);

    for (const v of vehicles) {
      let gvi: GviResponse;
      try {
        gvi = await this.fetchGvi(token, v.key);
      } catch {
        continue;
      }
      const vehicleVin =
        gvi.payload?.vehicleInfoList?.[0]?.vehicleConfig?.vehicleDetail?.vehicle?.vin;
      if (vehicleVin === this.vin) {
        this.cachedVehicleKey = v.key;
        this.cachedVehicleKeyForToken = token.accessToken;
        this.log.debug('[Kia] Vehicle key resolved:', v.key);
        return v.key;
      }
    }

    throw new Error(
      `[Kia] VIN ${this.vin} not found among ${vehicles.length} vehicle(s) on this account.`,
    );
  }

  // ─── Private: raw API calls ────────────────────────────────────────────────

  private authedHeaders(
    token: StoredToken,
    vehicleKey: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const offsetHours = String(Math.round(-new Date().getTimezoneOffset() / 60));
    const clientUuid = this.uuidV5(KIA_API_HOST, token.deviceId);

    return {
      'sid': token.accessToken,
      'vinkey': vehicleKey,
      'content-type': 'application/json;charset=utf-8',
      'accept': 'application/json',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
      'accept-charset': 'utf-8',
      'apptype': 'L',
      'appversion': '7.22.0',
      'clientid': 'SPACL716-APL',
      'from': 'SPA',
      'host': KIA_API_HOST,
      'language': '0',
      'ostype': 'iOS',
      'osversion': '15.8.5',
      'phonebrand': 'iPhone',
      'secretkey': 'sydnat-9kykci-Kuhtep-h5nK',
      'to': 'APIGW',
      'tokentype': 'A',
      'user-agent': 'KIAPrimo_iOS/37 CFNetwork/1335.0.3.4 Darwin/21.6.0',
      'date': new Date().toUTCString(),
      'offset': offsetHours,
      'deviceid': token.deviceId,
      'clientuuid': clientUuid,
      ...extra,
    };
  }

  private sessionHeaders(token: StoredToken, extra: Record<string, string> = {}): Record<string, string> {
    const offsetHours = String(Math.round(-new Date().getTimezoneOffset() / 60));
    const clientUuid = this.uuidV5(KIA_API_HOST, token.deviceId);

    return {
      'sid': token.accessToken,
      'content-type': 'application/json;charset=utf-8',
      'accept': 'application/json',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
      'accept-charset': 'utf-8',
      'apptype': 'L',
      'appversion': '7.22.0',
      'clientid': 'SPACL716-APL',
      'from': 'SPA',
      'host': KIA_API_HOST,
      'language': '0',
      'ostype': 'iOS',
      'osversion': '15.8.5',
      'phonebrand': 'iPhone',
      'secretkey': 'sydnat-9kykci-Kuhtep-h5nK',
      'to': 'APIGW',
      'tokentype': 'A',
      'user-agent': 'KIAPrimo_iOS/37 CFNetwork/1335.0.3.4 Darwin/21.6.0',
      'date': new Date().toUTCString(),
      'offset': offsetHours,
      'deviceid': token.deviceId,
      'clientuuid': clientUuid,
      ...extra,
    };
  }

  private async fetchVehicleList(token: StoredToken): Promise<ApiVehicle[]> {
    const res = await this.http.get<{
      payload: { vehicleSummary: GvlVehicleSummary[] };
    }>(`${KIA_API_BASE}ownr/gvl`, {
      headers: this.sessionHeaders(token),
    });
    this.assertOk(res);
    return (res.data.payload.vehicleSummary ?? []).map((s) => ({
      key: s.vehicleKey,
      identifier: s.vehicleIdentifier,
      name: s.nickName,
      model: s.modelName,
    }));
  }

  private async fetchGvi(token: StoredToken, vehicleKey: string): Promise<GviResponse> {
    const body = {
      vehicleConfigReq: {
        airTempRange: '0',
        maintenance: '0',
        seatHeatCoolOption: '0',
        vehicle: '1',
        vehicleFeature: '0',
      },
      vehicleInfoReq: {
        drivingActivty: '0',
        dtc: '0',
        enrollment: '0',
        functionalCards: '0',
        location: '0',
        vehicleStatus: '1',
        weather: '0',
      },
      vinKey: [vehicleKey],
    };
    const res = await this.http.post<GviResponse>(`${KIA_API_BASE}cmm/gvi`, body, {
      headers: this.authedHeaders(token, vehicleKey),
    });
    this.assertOk(res);
    return res.data;
  }

  /**
   * Sends a GET-based remote command (lock, unlock, stop climate).
   * Returns the transaction Xid header.
   */
  private async remoteGet(
    token: StoredToken,
    vehicleKey: string,
    endpoint: string,
  ): Promise<string> {
    const res = await this.http.get(`${KIA_API_BASE}${endpoint}`, {
      headers: this.authedHeaders(token, vehicleKey),
    });
    this.assertOk(res);
    const xid = res.headers['xid'] as string | undefined;
    if (!xid) {
      throw new Error(`[Kia] No transaction ID returned from ${endpoint}`);
    }
    return xid;
  }

  private async remoteStartClimate(
    token: StoredToken,
    vehicleKey: string,
    profile: ClimateProfile,
  ): Promise<string> {
    const temp = profile.temperature < 62
      ? 'LOW'
      : profile.temperature > 82
        ? 'HIGH'
        : String(profile.temperature);

    const body: Record<string, unknown> = {
      remoteClimate: {
        airTemp: { unit: 1, value: temp },
        airCtrl: true,
        defrost: profile.defrost,
        heatingAccessory: {
          rearWindow: profile.rearWindowHeat ? 1 : 0,
          sideMirror: profile.sideMirrorHeat ? 1 : 0,
          steeringWheel: profile.steeringWheelHeat > 0 ? 1 : 0,
          steeringWheelStep: profile.steeringWheelHeat,
        },
        ignitionOnDuration: { unit: 4, value: profile.duration },
      },
    };

    // Only include seat settings if at least one seat is configured.
    if (
      profile.driverSeat !== 'off' ||
      profile.passengerSeat !== 'off' ||
      profile.rearLeftSeat !== 'off' ||
      profile.rearRightSeat !== 'off'
    ) {
      (body['remoteClimate'] as Record<string, unknown>)['heatVentSeat'] = {
        driverSeat: seatSetting(profile.driverSeat),
        passengerSeat: seatSetting(profile.passengerSeat),
        rearLeftSeat: seatSetting(profile.rearLeftSeat),
        rearRightSeat: seatSetting(profile.rearRightSeat),
      };
    }

    const res = await this.http.post(`${KIA_API_BASE}rems/start`, body, {
      headers: this.authedHeaders(token, vehicleKey),
    });
    this.assertOk(res);
    const xid = res.headers['xid'] as string | undefined;
    if (!xid) {
      throw new Error('[Kia] No transaction ID returned from rems/start');
    }
    return xid;
  }

  // ─── Private: transaction polling ─────────────────────────────────────────

  /**
   * Polls `cmm/gts` using exponential back-off until the vehicle confirms the
   * command has been executed (all payload values === 0) or we give up.
   */
  private async pollTransaction(xid: string): Promise<void> {
    this.log.debug('[Kia] Polling transaction', xid);
    await backOff(
      async () => {
        const token = await this.auth.getValidSession();
        const vehicleKey = await this.resolveVehicleKey(token);
        const res = await this.http.post(
          `${KIA_API_BASE}cmm/gts`,
          { xid },
          { headers: this.authedHeaders(token, vehicleKey) },
        );

        this.assertOk(res);

        const payloadRaw = res.data?.payload;
        if (!payloadRaw || typeof payloadRaw !== 'object' || Array.isArray(payloadRaw)) {
          this.log.debug('[Kia] Transaction complete:', xid);
          return;
        }

        const payload = payloadRaw as Record<string, number>;
        const done = Object.keys(payload).length === 0 || Object.values(payload).every((v) => v === 0);

        if (!done) {
          this.log.debug('[Kia] Transaction still pending:', xid, payload);
          throw new Error('pending'); // triggers backOff to retry
        }

        this.log.debug('[Kia] Transaction complete:', xid);
      },
      {
        numOfAttempts: 10,
        startingDelay: 5_000,
        timeMultiple: 1.5,
        jitter: 'full',
      },
    );
  }

  // ─── Private: helpers ──────────────────────────────────────────────────────

  private assertOk(res: AxiosResponse): void {
    const status = res.data?.status as
      | { statusCode: number; errorType: number; errorCode: number; errorMessage: string }
      | undefined;
    if (!status) return;
    if (status.statusCode === 0) return;

    // Session errors (1003, 1005 with errorType 1) — bubble up for retry.
    if (status.statusCode === 1 && status.errorType === 1 && [1003, 1005].includes(status.errorCode)) {
      const err = new Error(`[Kia] Session invalid (${status.errorCode}): ${status.errorMessage}`);
      (err as NodeJS.ErrnoException).code = 'KIA_SESSION_INVALID';
      throw err;
    }

    if (status.statusCode === 1 && status.errorType === 1 && status.errorCode === 1125) {
      const err = new Error(`[Kia] Remote command busy (${status.errorCode}): ${status.errorMessage}`);
      (err as NodeJS.ErrnoException).code = 'KIA_REMOTE_BUSY';
      throw err;
    }

    throw new Error(
      `[Kia] API error ${status.errorCode}: ${status.errorMessage ?? JSON.stringify(status)}`,
    );
  }

  private isSessionError(err: unknown): boolean {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const body = typeof err.response?.data === 'string' ? err.response.data : '';
      if (status === 403 && body.includes('Cloudflare')) {
        throw new Error(
          '[Kia] Cloudflare blocked the request after authentication. ' +
          'This is usually network-related (IPv6 path, VPN, DNS/proxy filtering). ' +
          'Try disabling VPN/proxy and forcing IPv4 egress from this host.',
        );
      }
    }

    return (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === 'KIA_SESSION_INVALID'
    );
  }

  private isRemoteBusyError(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === 'KIA_REMOTE_BUSY'
    );
  }

  // ─── Private: status parsing ───────────────────────────────────────────────

  private parseStatus(raw: GviResponse): VehicleStatus {
    const vs =
      raw.payload.vehicleInfoList[0].lastVehicleInfo.vehicleStatusRpt.vehicleStatus;

    const syncUtc = vs.syncDate?.utc ?? '';
    const lastUpdatedAt = syncUtc
      ? new Date(
        `${syncUtc.slice(0, 4)}-${syncUtc.slice(4, 6)}-${syncUtc.slice(6, 8)}` +
            `T${syncUtc.slice(8, 10)}:${syncUtc.slice(10, 12)}:${syncUtc.slice(12, 14)}Z`,
      )
      : new Date();

    return {
      isEngineOn: vs.engine ?? false,
      isLocked: vs.doorLock ?? true,
      fuelLevel: vs.fuelLevel ?? 0,
      isFuelLow: vs.lowFuelLight ?? false,
      isAirOn: vs.climate?.airCtrl ?? false,
      doors: {
        frontLeft: vs.doorStatus.frontLeft !== 0,
        frontRight: vs.doorStatus.frontRight !== 0,
        rearLeft: vs.doorStatus.backLeft !== 0,
        rearRight: vs.doorStatus.backRight !== 0,
        hood: vs.doorStatus.hood !== 0,
        trunk: vs.doorStatus.trunk !== 0,
      },
      lastUpdatedAt,
    };
  }

  /** UUID v5 (SHA-1, DNS namespace) to match Kia app header format. */
  private uuidV5(namespace: string, name: string): string {
    const nsBytes = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
    const nameBytes = Buffer.from(name, 'utf8');
    const hash = crypto
      .createHash('sha1')
      .update(Buffer.concat([nsBytes, nameBytes]))
      .digest();

    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;

    const hex = hash.subarray(0, 16).toString('hex');
    return (
      `${hex.slice(0, 8)}-` +
      `${hex.slice(8, 12)}-` +
      `${hex.slice(12, 16)}-` +
      `${hex.slice(16, 20)}-` +
      `${hex.slice(20, 32)}`
    ).toUpperCase();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seatSetting(level: SeatLevel): Record<string, number> {
  switch (level) {
  case 'high-heat':   return { heatVentType: 1, heatVentLevel: 4, heatVentStep: 1 };
  case 'medium-heat': return { heatVentType: 1, heatVentLevel: 3, heatVentStep: 2 };
  case 'low-heat':    return { heatVentType: 1, heatVentLevel: 2, heatVentStep: 3 };
  case 'high-cool':   return { heatVentType: 2, heatVentLevel: 4, heatVentStep: 1 };
  case 'medium-cool': return { heatVentType: 2, heatVentLevel: 3, heatVentStep: 2 };
  case 'low-cool':    return { heatVentType: 2, heatVentLevel: 2, heatVentStep: 3 };
  default:            return { heatVentType: 0, heatVentLevel: 1, heatVentStep: 0 };
  }
}
