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
 *  • Switch "Engine" — (only when NO climate profiles configured) bare
 *                      engine start/stop.
 *  • Switch per climate profile — triggers a remote start with those
 *                      settings; stays ON while the engine is running from
 *                      that profile.  Turning it OFF stops the engine.
 *                      Switching to a different profile starts it fresh.
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
  /** Name of the profile whose switch is currently showing ON (engine running or starting). */
  private activeProfileName: string | null = null;
  /** True while a climate START command is in-flight (prevents pushUpdates from clearing activeProfileName). */
  private climateCommandInFlight = false;

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
        // Fire-and-forget: respond to HomeKit immediately so it doesn't time out.
        this.enqueueCommand(async () => {
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

    // ── Engine switch (bare start — only when no profiles are configured) ──
    if (config.climateProfiles.length === 0) {
      this.engineService =
        accessory.getServiceById(this.Service.Switch, `${config.vin}:engine`) ??
        accessory.addService(this.Service.Switch, 'Engine', `${config.vin}:engine`);
      setServiceName(this.engineService, Characteristic, 'Engine');

      this.engineService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.pendingEngineTarget ?? this.status?.isEngineOn ?? false)
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
          // Fire-and-forget: respond to HomeKit immediately so it doesn't time out.
          this.enqueueCommand(async () => {
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
      // Remove stale engine service if user later adds profiles.
      this.engineService = null;
      const stale = accessory.getServiceById(this.Service.Switch, `${config.vin}:engine`);
      if (stale) accessory.removeService(stale);
    }

    // ── Climate profile switches ──────────────────────────────────────────
    // Each switch stays ON while the engine is running under that profile.
    // Turning a switch ON starts the engine; turning it OFF stops it.
    // Switching to a different profile while one is running replaces it.
    for (const profile of config.climateProfiles) {
      const subtype = `profile:${config.vin}:${profile.name}`;
      const svc =
        accessory.getServiceById(this.Service.Switch, subtype) ??
        accessory.addService(this.Service.Switch, profile.name, subtype);
      setServiceName(svc, Characteristic, profile.name);

      svc
        .getCharacteristic(Characteristic.On)
        // Reports ON whenever this profile is the active/starting one — regardless
        // of whether the engine has confirmed on yet.  Keeping HAP's cache in sync
        // with activeProfileName prevents updateCharacteristic(true) in pushUpdates
        // from appearing as a change and triggering a spurious SET from controllers.
        .onGet(() => this.activeProfileName === profile.name)
        .onSet(async (value: CharacteristicValue) => {
          const shouldStart = value === true || value === 1;

          if (shouldStart) {
            // Already the active/starting profile — drop duplicate SETs (HomeKit
            // often sends more than one from phone + hub at the same time).
            if (this.activeProfileName === profile.name) {
              log.debug(`[${config.name}] Profile "${profile.name}" already active or starting, ignoring.`);
              return;
            }
            // Switch any previously-active profile switch to OFF.
            if (this.activeProfileName !== null && this.activeProfileName !== profile.name) {
              const prev = this.profileServices.get(this.activeProfileName);
              prev?.updateCharacteristic(Characteristic.On, false);
            }
            this.activeProfileName = profile.name;
            this.climateCommandInFlight = true;
            // Fire-and-forget: respond to HomeKit immediately.
            this.enqueueCommand(async () => {
              log.info(`[${config.name}] Climate profile "${profile.name}" triggered`);
              try {
                await client.startClimate(profile);
                await this.refresh();
              } catch (err) {
                log.error(`[${config.name}] Climate profile "${profile.name}" failed:`, err);
                // Revert switch to off on failure.
                if (this.activeProfileName === profile.name) this.activeProfileName = null;
                svc.updateCharacteristic(Characteristic.On, false);
              } finally {
                this.climateCommandInFlight = false;
              }
            });
          } else {
            // Turning OFF: only stop the engine if this is the active profile.
            if (this.activeProfileName !== profile.name) {
              log.debug(`[${config.name}] Profile "${profile.name}" is not active, ignoring OFF.`);
              return;
            }
            this.activeProfileName = null;
            // Fire-and-forget: respond to HomeKit immediately.
            this.enqueueCommand(async () => {
              log.info(`[${config.name}] Engine stop (profile "${profile.name}" off)`);
              try {
                await client.stopClimate();
                await this.refresh();
              } catch (err) {
                log.error(`[${config.name}] Engine stop failed:`, err);
                // Revert: engine might still be on — push real state.
                svc.updateCharacteristic(
                  Characteristic.On,
                  this.status?.isEngineOn ?? false,
                );
              }
            });
          }
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

    // Engine switch (bare-start mode — only present when no profiles configured)
    this.engineService?.updateCharacteristic(Characteristic.On, this.status.isEngineOn);

    // Profile switches — sync ON/OFF to real engine state.
    if (this.profileServices.size > 0) {
      if (!this.status.isEngineOn) {
        // Only clear activeProfileName when no start command is in-flight.
        // If the engine hasn't confirmed on yet we don't want to drop the
        // active profile (and allow duplicate starts) just because the status
        // momentarily shows engine-off while the command is still running.
        if (!this.climateCommandInFlight) {
          this.activeProfileName = null;
        }
        for (const [name, svc] of this.profileServices) {
          // Keep the in-flight profile switch ON so Home shows it as starting.
          if (name !== this.activeProfileName) {
            svc.updateCharacteristic(Characteristic.On, false);
          }
        }
      } else if (this.activeProfileName !== null) {
        // Engine is on: ensure the active profile switch shows ON.
        // If onGet already returns true (activeProfileName matches), this is a
        // no-op in HAP — no change notification, no spurious SET from controllers.
        const activeSvc = this.profileServices.get(this.activeProfileName);
        activeSvc?.updateCharacteristic(Characteristic.On, true);
      }
    }

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
    if (this.pendingLockTarget !== null) {
      return this.pendingLockTarget
        ? Characteristic.LockTargetState.SECURED
        : Characteristic.LockTargetState.UNSECURED;
    }
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
