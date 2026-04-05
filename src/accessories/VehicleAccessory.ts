import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { KiaConnectPlatform } from '../platform';
import { KiaClient } from '../kia/client';
import { ClimateProfile, VehicleConfig, VehicleStatus } from '../kia/types';

/**
 * VehicleAccessory
 *
 * Exposes the following HomeKit services per configured vehicle:
 *
 *  • LockMechanism  — lock / unlock
 *  • Switch "Engine" — shows live engine state; turning it on starts the
 *                      first climate profile (or a bare start if none are
 *                      configured); turning it off stops the engine.
 *  • Switch per climate profile (momentary) — triggers a remote start with
 *                      those specific settings; auto-resets to OFF so it
 *                      always acts as a one-shot command rather than
 *                      tracking state.
 *  • Battery        — fuel level + low-fuel warning
 *  • ContactSensor × 6 — individual door, hood, trunk sensors
 *                       (only when showDoorSensors = true)
 */
export class VehicleAccessory {
  private readonly Service: typeof Service;
  private status: VehicleStatus | null = null;
  private commandQueue: Promise<void> = Promise.resolve();
  private pendingLockTarget: boolean | null = null;
  private pendingEngineTarget: boolean | null = null;

  // Service references
  private readonly lockService: Service;
  private readonly engineService: Service | null;
  private readonly profileServices: Map<string, Service> = new Map();
  private readonly batteryService: Service;
  private readonly doorServices: Map<string, Service> = new Map();

  constructor(
    private readonly platform: KiaConnectPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: KiaClient,
    private readonly config: VehicleConfig,
  ) {
    this.Service = platform.api.hap.Service;
    const { Characteristic } = platform.api.hap;
    const log = platform.log;

    // ── Accessory information ─────────────────────────────────────────────
    const info =
      accessory.getService(this.Service.AccessoryInformation) ??
      accessory.addService(this.Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Kia')
      .setCharacteristic(Characteristic.Model, 'Vehicle')
      .setCharacteristic(Characteristic.SerialNumber, config.vin)
      .setCharacteristic(Characteristic.Name, config.name);

    // ── Lock mechanism ────────────────────────────────────────────────────
    this.lockService =
      accessory.getServiceById(this.Service.LockMechanism, `${config.vin}:lock`) ??
      accessory.getService(this.Service.LockMechanism) ??
      accessory.addService(this.Service.LockMechanism, 'Doors', `${config.vin}:lock`);
    setServiceName(this.lockService, Characteristic, 'Doors');

    this.lockService
      .getCharacteristic(Characteristic.LockCurrentState)
      .onGet(() => this.getLockCurrentState());

    this.lockService
      .getCharacteristic(Characteristic.LockTargetState)
      .onGet(() => this.getLockTargetState())
      .onSet(async (value) => {
        const shouldLock = value === 1;
        if (this.pendingLockTarget === shouldLock) {
          log.debug(`[${config.name}] Ignoring duplicate lock target write.`);
          return;
        }
        if (this.pendingLockTarget === null && this.status?.isLocked === shouldLock) {
          log.debug(`[${config.name}] Lock target already matches current state.`);
          return;
        }

        this.pendingLockTarget = shouldLock;
        await this.enqueueCommand(async () => {
          log.info(`[${config.name}] Lock target → ${shouldLock ? 'LOCK' : 'UNLOCK'}`);
          try {
            if (shouldLock) {
              await client.lock();
            } else {
              await client.unlock();
            }
            await this.refresh();
          } catch (err) {
            log.error(`[${config.name}] Lock/unlock failed:`, err);
          } finally {
            if (this.pendingLockTarget === shouldLock) {
              this.pendingLockTarget = null;
            }
          }
        });
      });

    // ── Engine switch (tracks real engine state) ──────────────────────────
    if (config.climateProfiles.length === 0) {
      this.engineService =
        accessory.getServiceById(this.Service.Switch, `${config.vin}:engine`) ??
        accessory.addService(this.Service.Switch, 'Engine', `${config.vin}:engine`);
      setServiceName(this.engineService, Characteristic, 'Engine');

      this.engineService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.status?.isEngineOn ?? false)
        .onSet(async (value: CharacteristicValue) => {
          const shouldStart = value === true || value === 1;
          if (this.pendingEngineTarget === shouldStart) {
            log.debug(`[${config.name}] Ignoring duplicate engine target write.`);
            return;
          }
          if (this.pendingEngineTarget === null && this.status?.isEngineOn === shouldStart) {
            log.debug(`[${config.name}] Engine target already matches current state.`);
            return;
          }

          this.pendingEngineTarget = shouldStart;
          await this.enqueueCommand(async () => {
            log.info(`[${config.name}] Engine → ${shouldStart ? 'START' : 'STOP'}`);
            try {
              if (shouldStart) {
                await client.startClimate(bareStartProfile());
              } else {
                await client.stopClimate();
              }
              await this.refresh();
            } catch (err) {
              log.error(`[${config.name}] Engine start/stop failed:`, err);
              // Revert the switch to the actual state so HomeKit isn't out of sync.
              this.engineService?.updateCharacteristic(
                Characteristic.On,
                this.status?.isEngineOn ?? false,
              );
            } finally {
              if (this.pendingEngineTarget === shouldStart) {
                this.pendingEngineTarget = null;
              }
            }
          });
        });
    } else {
      this.engineService = null;
      const staleEngineService = accessory.getServiceById(this.Service.Switch, `${config.vin}:engine`);
      if (staleEngineService) {
        accessory.removeService(staleEngineService);
      }
    }

    // ── Climate profile switches (momentary triggers) ─────────────────────
    for (const profile of config.climateProfiles) {
      const subtype = `profile:${config.vin}:${profile.name}`;
      const svc =
        accessory.getServiceById(this.Service.Switch, subtype) ??
        accessory.addService(this.Service.Switch, profile.name, subtype);
      setServiceName(svc, Characteristic, profile.name);

      svc
        .getCharacteristic(Characteristic.On)
        .onGet(() => false) // always reports off; it's a trigger
        .onSet(async (value: CharacteristicValue) => {
          if (!value) return; // ignore the auto-reset write
          await this.enqueueCommand(async () => {
            log.info(`[${config.name}] Climate profile "${profile.name}" triggered`);

            // Auto-reset the switch to OFF after a short delay so it
            // behaves as a momentary button rather than a persistent toggle.
            setTimeout(() => {
              svc.updateCharacteristic(Characteristic.On, false);
            }, 1_500);

            try {
              await client.startClimate(profile);
              await this.refresh();
            } catch (err) {
              log.error(`[${config.name}] Climate profile "${profile.name}" failed:`, err);
            }
          });
        });

      this.profileServices.set(profile.name, svc);
    }

    // ── Battery / fuel ────────────────────────────────────────────────────
    this.batteryService =
      accessory.getServiceById(this.Service.Battery, `${config.vin}:battery`) ??
      accessory.addService(this.Service.Battery, 'Fuel Level', `${config.vin}:battery`);
    setServiceName(this.batteryService, Characteristic, 'Fuel Level');

    this.batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .onGet(() => this.status?.fuelLevel ?? 0);

    this.batteryService
      .getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() =>
        this.status?.isFuelLow
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );

    this.batteryService
      .getCharacteristic(Characteristic.ChargingState)
      .onGet(() => Characteristic.ChargingState.NOT_CHARGEABLE);

    // ── Door sensors (optional) ───────────────────────────────────────────
    if (config.showDoorSensors) {
      const doorDefs: Array<{ key: keyof VehicleStatus['doors']; label: string }> = [
        { key: 'frontLeft', label: 'Front Left Door' },
        { key: 'frontRight', label: 'Front Right Door' },
        { key: 'rearLeft', label: 'Rear Left Door' },
        { key: 'rearRight', label: 'Rear Right Door' },
        { key: 'hood', label: 'Hood' },
        { key: 'trunk', label: 'Trunk' },
      ];
      for (const { key, label } of doorDefs) {
        const subtype = `door:${config.vin}:${key}`;
        const svc =
          accessory.getServiceById(this.Service.ContactSensor, subtype) ??
          accessory.addService(this.Service.ContactSensor, label, subtype);
        setServiceName(svc, Characteristic, label);
        svc
          .getCharacteristic(Characteristic.ContactSensorState)
          .onGet(() =>
            this.status?.doors[key]
              ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
              : Characteristic.ContactSensorState.CONTACT_DETECTED,
          );
        this.doorServices.set(key, svc);
      }
    }

    // ── Initial refresh + polling loop ────────────────────────────────────
    this.startPolling();
  }

  // ─── Status refresh ────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    try {
      this.status = await this.client.getStatus();
      this.platform.log.debug(
        `[${this.config.name}] Status refreshed:`,
        JSON.stringify(this.status),
      );
      this.pushUpdates();
    } catch (err) {
      this.platform.log.error(`[${this.config.name}] Status refresh failed:`, err);
    }
  }

  /**
   * Serializes remote command execution for a vehicle so Kia only sees one
   * in-flight command at a time.
   */
  private enqueueCommand(task: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      await task();
    };
    const queued = this.commandQueue.then(run, run);
    this.commandQueue = queued.catch(() => undefined);
    return queued;
  }

  /** Push latest status to all characteristics so HomeKit reflects reality. */
  private pushUpdates(): void {
    if (!this.status) return;
    const { Characteristic } = this.platform.api.hap;

    // Lock
    this.lockService.updateCharacteristic(
      Characteristic.LockCurrentState,
      this.getLockCurrentState(),
    );
    this.lockService.updateCharacteristic(
      Characteristic.LockTargetState,
      this.getLockTargetState(),
    );

    // Engine
    this.engineService?.updateCharacteristic(Characteristic.On, this.status.isEngineOn);

    // Battery
    this.batteryService.updateCharacteristic(
      Characteristic.BatteryLevel,
      this.status.fuelLevel,
    );
    this.batteryService.updateCharacteristic(
      Characteristic.StatusLowBattery,
      this.status.isFuelLow
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );

    // Door sensors
    if (this.config.showDoorSensors) {
      for (const [key, svc] of this.doorServices) {
        const isOpen = this.status.doors[key as keyof VehicleStatus['doors']];
        svc.updateCharacteristic(
          Characteristic.ContactSensorState,
          isOpen
            ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : Characteristic.ContactSensorState.CONTACT_DETECTED,
        );
      }
    }
  }

  private startPolling(): void {
    const intervalMs = Math.max(this.config.refreshIntervalSeconds, 300) * 1_000;
    this.platform.log.info(
      `[${this.config.name}] Starting status polling every ${this.config.refreshIntervalSeconds}s.`,
    );
    // Initial fetch runs shortly after construction so it doesn't block the constructor.
    setTimeout(() => this.refresh(), 2_000);
    setInterval(() => this.refresh(), intervalMs);
  }

  // ─── Characteristic getters ────────────────────────────────────────────────

  private getLockCurrentState(): CharacteristicValue {
    const { Characteristic } = this.platform.api.hap;
    if (!this.status) return Characteristic.LockCurrentState.UNKNOWN;
    return this.status.isLocked
      ? Characteristic.LockCurrentState.SECURED
      : Characteristic.LockCurrentState.UNSECURED;
  }

  private getLockTargetState(): CharacteristicValue {
    const { Characteristic } = this.platform.api.hap;
    if (!this.status) return Characteristic.LockTargetState.SECURED;
    return this.status.isLocked
      ? Characteristic.LockTargetState.SECURED
      : Characteristic.LockTargetState.UNSECURED;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal climate settings for a bare engine start (no heat/cool). */
function bareStartProfile(): ClimateProfile {
  return {
    name: 'Default',
    temperature: 72,
    duration: 10,
    defrost: false,
    rearWindowHeat: false,
    sideMirrorHeat: false,
    steeringWheelHeat: 0,
    driverSeat: 'off',
    passengerSeat: 'off',
    rearLeftSeat: 'off',
    rearRightSeat: 'off',
  };
}

function setServiceName(
  service: Service,
  characteristic: KiaConnectPlatform['api']['hap']['Characteristic'],
  name: string,
): void {
  service.setCharacteristic(characteristic.Name, name);
  if ('ConfiguredName' in characteristic) {
    service.setCharacteristic(characteristic.ConfiguredName, name);
  }
}
