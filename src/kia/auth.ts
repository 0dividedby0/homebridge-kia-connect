import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import { Logger } from 'homebridge';
import { StoredToken, OTPRequest } from './types';
import { KIA_API_BASE, KIA_API_HOST, SESSION_TTL_MS } from '../settings';

const TOKEN_FILENAME = 'kia-token.json';

/**
 * Manages Kia Connect session lifecycle:
 *  - Loads/saves the rmtoken (remember token) to disk so OTP prompts are rare.
 *  - Transparently renews the session using the stored rmtoken when it expires.
 *  - Falls back to a full OTP flow when the rmtoken itself has expired.
 *  - Serves a tiny local HTTP page on `otpPort` for convenient OTP entry.
 *  - Serialises concurrent callers so only one auth flow runs at a time.
 */
export class AuthManager {
  private token: StoredToken | null = null;
  private deviceId = '';
  private readonly tokenFile: string;

  /** Serialise concurrent getValidSession() calls. */
  private sessionPromise: Promise<StoredToken> | null = null;

  /** Resolves when the user submits an OTP code via the HTTP endpoint. */
  private otpResolve: ((code: string) => void) | null = null;
  private otpServer: http.Server | null = null;

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly storagePath: string,
    private readonly otpPort: number,
    private readonly log: Logger,
  ) {
    this.tokenFile = path.join(storagePath, TOKEN_FILENAME);
  }

  /**
   * Returns a valid StoredToken, refreshing or re-authenticating as needed.
   * Concurrent calls share the same in-flight promise.
   */
  async getValidSession(): Promise<StoredToken> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.resolveSession().finally(() => {
        this.sessionPromise = null;
      });
    }
    return this.sessionPromise;
  }

  /** Call when an API response indicates the session has been invalidated mid-flight. */
  invalidateSession(): void {
    if (this.token) {
      this.token.validUntil = 0;
    }
  }

  // ─── Private: session resolution ──────────────────────────────────────────

  private async resolveSession(): Promise<StoredToken> {
    if (!this.token) {
      this.token = await this.loadToken();
    }

    if (this.token) {
      this.deviceId = this.token.deviceId;

      if (Date.now() < this.token.validUntil) {
        return this.token; // session still valid
      }

      if (this.token.refreshToken) {
        try {
          const refreshed = await this.refreshWithRmtoken(this.token);
          if (refreshed) {
            this.token = refreshed;
            await this.saveToken(this.token);
            this.log.debug('[Kia Auth] Session renewed with stored rmtoken.');
            return this.token;
          }
        } catch (err) {
          this.log.debug('[Kia Auth] rmtoken refresh failed, falling back to OTP flow.', err);
        }
      }
    }

    // Full OTP authentication required.
    const newToken = await this.runOtpFlow();
    this.token = newToken;
    await this.saveToken(this.token);
    return this.token;
  }

  // ─── Private: API calls ────────────────────────────────────────────────────

  private buildHeaders(overrides: Record<string, string> = {}): Record<string, string> {
    if (!this.deviceId) {
      this.deviceId = crypto.randomUUID().toUpperCase();
    }
    const clientUuid = this.uuidV5(KIA_API_HOST, this.deviceId);
    const offsetHours = String(Math.round(-new Date().getTimezoneOffset() / 60));

    return {
      'content-type': 'application/json;charset=utf-8',
      'accept': 'application/json',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
      'accept-charset': 'utf-8',
      'apptype': 'L',
      'appversion': '7.22.0',
      'clientid': 'SPACL716-APL',
      'clientuuid': clientUuid,
      'from': 'SPA',
      'host': KIA_API_HOST,
      'language': '0',
      'offset': offsetHours,
      'ostype': 'iOS',
      'osversion': '15.8.5',
      'phonebrand': 'iPhone',
      'secretkey': 'sydnat-9kykci-Kuhtep-h5nK',
      'to': 'APIGW',
      'tokentype': 'A',
      'user-agent': 'KIAPrimo_iOS/37 CFNetwork/1335.0.3.4 Darwin/21.6.0',
      'date': new Date().toUTCString(),
      'deviceid': this.deviceId,
      ...overrides,
    };
  }

  /**
   * Initial login attempt.
   * Returns a StoredToken if no OTP is needed, or an OTPRequest if OTP is required.
   */
  private async initialLogin(rmtoken?: string): Promise<StoredToken | OTPRequest> {
    const body = {
      deviceKey: this.deviceId,
      deviceType: 2,
      userCredential: { userId: this.email, password: this.password },
      tncFlag: 1,
    };
    const extraHeaders: Record<string, string> = {};
    if (rmtoken) {
      extraHeaders['rmtoken'] = rmtoken;
    }

    const res = await axios.post(`${KIA_API_BASE}prof/authUser`, body, {
      headers: this.buildHeaders(extraHeaders),
    });

    const sid = res.headers['sid'] as string | undefined;
    if (sid) {
      return {
        accessToken: sid,
        refreshToken: rmtoken ?? '',
        validUntil: Date.now() + SESSION_TTL_MS,
        deviceId: this.deviceId,
      };
    }

    const payload = res.data?.payload as Record<string, unknown> | undefined;
    if (payload?.otpKey) {
      return {
        otpKey: payload.otpKey as string,
        requestId: (res.headers['xid'] as string | undefined) ?? '',
        hasEmail: Boolean(payload.hasEmail),
        hasSms: Boolean(payload.hasPhone),
        email: payload.email as string | undefined,
        sms: payload.phone as string | undefined,
        rmTokenExpired: Boolean(payload.rmTokenExpired),
      };
    }

    throw new Error(`[Kia Auth] Unexpected login response: ${JSON.stringify(res.data)}`);
  }

  /**
   * Attempt a session refresh using the stored rmtoken.
   * Returns null if the rmtoken has expired (triggering a full OTP flow instead).
   */
  private async refreshWithRmtoken(existing: StoredToken): Promise<StoredToken | null> {
    const result = await this.initialLogin(existing.refreshToken);
    if ('accessToken' in result) {
      return result;
    }
    // OTPRequest returned → rmtoken expired
    return null;
  }

  private async sendOtp(otpRequest: OTPRequest, notifyType: 'EMAIL' | 'SMS'): Promise<void> {
    await axios.post(
      `${KIA_API_BASE}cmm/sendOTP`,
      {},
      {
        headers: this.buildHeaders({
          otpkey: otpRequest.otpKey,
          notifytype: notifyType,
          xid: otpRequest.requestId,
        }),
      },
    );
  }

  private async verifyOtp(
    otpRequest: OTPRequest,
    code: string,
  ): Promise<{ sid: string; rmtoken: string }> {
    const res = await axios.post(
      `${KIA_API_BASE}cmm/verifyOTP`,
      { otp: code },
      {
        headers: this.buildHeaders({
          otpkey: otpRequest.otpKey,
          xid: otpRequest.requestId,
        }),
      },
    );

    const sid = res.headers['sid'] as string | undefined;
    const rmtoken = res.headers['rmtoken'] as string | undefined;
    if (!sid || !rmtoken) {
      throw new Error(
        `[Kia Auth] OTP verification missing credentials. Status: ${JSON.stringify(res.data)}`,
      );
    }
    return { sid, rmtoken };
  }

  private async finalLogin(sid: string, rmtoken: string): Promise<string> {
    const body = {
      deviceKey: this.deviceId,
      deviceType: 2,
      userCredential: { userId: this.email, password: this.password },
    };
    const res = await axios.post(`${KIA_API_BASE}prof/authUser`, body, {
      headers: this.buildHeaders({ sid, rmtoken }),
    });

    const finalSid = res.headers['sid'] as string | undefined;
    if (!finalSid) {
      throw new Error(`[Kia Auth] Final login produced no session. Response: ${JSON.stringify(res.data)}`);
    }
    return finalSid;
  }

  // ─── Private: OTP flow ─────────────────────────────────────────────────────

  private async runOtpFlow(): Promise<StoredToken> {
    this.log.info('[Kia Auth] Starting authentication…');

    const result = await this.initialLogin();
    if ('accessToken' in result) {
      this.log.info('[Kia Auth] Logged in without OTP (no 2FA on this account).');
      return result;
    }

    const otpRequest = result;
    if (otpRequest.rmTokenExpired) {
      this.log.warn('[Kia Auth] Stored session token has expired — a new OTP is required.');
    }

    // Prefer email; fall back to SMS.
    const notifyType = otpRequest.hasEmail ? 'EMAIL' : 'SMS';
    const destination = otpRequest.hasEmail
      ? (otpRequest.email ?? 'your email')
      : (otpRequest.sms ?? 'your phone');

    this.log.info(`[Kia Auth] Sending OTP to ${destination} via ${notifyType}…`);
    await this.sendOtp(otpRequest, notifyType);

    const code = await this.collectOtpCode();

    this.log.info('[Kia Auth] Verifying OTP…');
    const { sid, rmtoken } = await this.verifyOtp(otpRequest, code);

    this.log.info('[Kia Auth] Completing login…');
    const finalSid = await this.finalLogin(sid, rmtoken);

    this.log.info('[Kia Auth] Authentication successful. Session and rmtoken saved.');
    return {
      accessToken: finalSid,
      refreshToken: rmtoken,
      validUntil: Date.now() + SESSION_TTL_MS,
      deviceId: this.deviceId,
    };
  }

  /**
   * Starts a small HTTP server and waits for the user to submit their OTP code.
   *
   * The user can:
   *   • Open  http://<host>:<PORT>/kia-otp  in a browser and type the code.
   *   • Or run: curl "http://localhost:<PORT>/kia-otp?code=123456"
   *
   * Times out after 5 minutes.
   */
  private collectOtpCode(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stopOtpServer();
        reject(new Error('[Kia Auth] OTP entry timed out after 5 minutes.'));
      }, 5 * 60 * 1000);

      this.log.warn(
        '[Kia Auth] OTP sent! ' +
        `Enter your code at: http://localhost:${this.otpPort}/kia-otp?code=XXXXXX`,
      );
      this.log.warn(
        `[Kia Auth] Or in a terminal: curl "http://localhost:${this.otpPort}/kia-otp?code=YOUR_CODE"`,
      );

      this.otpServer = http.createServer((req, res) => {
        const rawUrl = req.url ?? '/';
        let parsed: URL;
        try {
          parsed = new URL(rawUrl, `http://localhost:${this.otpPort}`);
        } catch {
          res.writeHead(400).end('Bad request');
          return;
        }

        if (parsed.pathname !== '/kia-otp') {
          res.writeHead(302, { location: '/kia-otp' }).end();
          return;
        }

        const code = parsed.searchParams.get('code') ?? '';
        const isValid = /^\d{6}$/.test(code);

        const html = (content: string): string =>
          '<!DOCTYPE html><html><head><meta charset="utf-8">' +
          '<title>Kia OTP</title>' +
          '<style>body{font-family:system-ui;max-width:400px;margin:80px auto;padding:0 20px}</style>' +
          `</head><body>${content}</body></html>`;

        if (!isValid) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
            html(`
              <h2>🔑 Enter your Kia OTP code</h2>
              <p>A 6-digit code was sent to your registered email or phone.</p>
              <form method="get" action="/kia-otp">
                <input name="code" placeholder="123456" maxlength="6"
                       inputmode="numeric" autocomplete="one-time-code" autofocus
                       style="font-size:2rem;width:160px;letter-spacing:0.3rem;text-align:center" />
                <br><br>
                <button type="submit" style="font-size:1.2rem;padding:8px 24px">Submit</button>
              </form>
              ${code ? '<p style="color:red">Code must be exactly 6 digits.</p>' : ''}
            `),
          );
          return;
        }

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
          html('<h2>✅ OTP accepted!</h2><p>Authentication completing — you can close this tab.</p>'),
        );

        clearTimeout(timeout);
        this.stopOtpServer();
        resolve(code);
      });

      this.otpServer.once('error', (err) => {
        clearTimeout(timeout);
        this.stopOtpServer();
        reject(
          new Error(
            `[Kia Auth] Could not start OTP server on port ${this.otpPort}: ${(err as Error).message}. ` +
            'Change \'otpPort\' in config if the port is already in use.',
          ),
        );
      });

      this.otpServer.listen(this.otpPort, () => {
        this.log.info(`[Kia Auth] OTP server listening on port ${this.otpPort}.`);
      });
    });
  }

  private stopOtpServer(): void {
    this.otpServer?.close();
    this.otpServer = null;
  }

  // ─── Private: token persistence ───────────────────────────────────────────

  private async loadToken(): Promise<StoredToken | null> {
    try {
      const raw = await fs.readFile(this.tokenFile, 'utf8');
      return JSON.parse(raw) as StoredToken;
    } catch {
      return null;
    }
  }

  private async saveToken(token: StoredToken): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.tokenFile), { recursive: true });
      await fs.writeFile(this.tokenFile, JSON.stringify(token, null, 2), 'utf8');
    } catch (err) {
      this.log.error('[Kia Auth] Failed to persist token:', err);
    }
  }

  // ─── Private: UUID v5 ─────────────────────────────────────────────────────

  /**
   * UUID v5 (SHA-1, DNS namespace) — matches Python's uuid.uuid5(uuid.NAMESPACE_DNS, name).
   * Used to generate a consistent clientuuid from the deviceId.
   */
  private uuidV5(namespace: string, name: string): string {
    // NAMESPACE_DNS = 6ba7b810-9dad-11d1-80b4-00c04fd430c8
    const nsBytes = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
    const nameBytes = Buffer.from(name, 'utf8');
    const hash = crypto
      .createHash('sha1')
      .update(Buffer.concat([nsBytes, nameBytes]))
      .digest();

    hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
    hash[8] = (hash[8] & 0x3f) | 0x80; // variant

    void namespace; // the namespace is already baked into nsBytes
    return [
      hash.slice(0, 4).toString('hex'),
      hash.slice(4, 6).toString('hex'),
      hash.slice(6, 8).toString('hex'),
      hash.slice(8, 10).toString('hex'),
      hash.slice(10, 16).toString('hex'),
    ].join('-');
  }
}
