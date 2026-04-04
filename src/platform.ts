import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { AuthManager } from './kia/auth';
import { KiaClient } from './kia/client';
import { VehicleAccessory } from './accessories/VehicleAccessory';
import { VehicleConfig } from './kia/types';

export class KiaConnectPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly cachedAccessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => {
      this.discoverVehicles();
    });
  }

  /** Homebridge calls this for every accessory it restores from cache. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  private discoverVehicles(): void {
    const email = this.config.email as string | undefined;
    const password = this.config.password as string | undefined;
    const vehicles = (this.config.vehicles ?? []) as VehicleConfig[];
    const otpPort = (this.config.otpPort as number | undefined) ?? 38581;

    if (!email || !password) {
      this.log.error('[Kia] Missing email or password in config. Plugin will not start.');
      return;
    }

    if (vehicles.length === 0) {
      this.log.warn('[Kia] No vehicles configured. Add at least one vehicle in the plugin settings.');
      return;
    }

    // One AuthManager shared across all vehicles on the same account.
    const storagePath = this.api.user.storagePath();
    const auth = new AuthManager(email, password, storagePath, otpPort, this.log);

    for (const vehicleConfig of vehicles) {
      if (!vehicleConfig.vin || vehicleConfig.vin.length !== 17) {
        this.log.error(`[Kia] Vehicle "${vehicleConfig.name}" has an invalid VIN — skipping.`);
        continue;
      }

      // Normalise optional fields.
      const config: VehicleConfig = {
        name: vehicleConfig.name ?? vehicleConfig.vin,
        vin: vehicleConfig.vin,
        refreshIntervalSeconds: vehicleConfig.refreshIntervalSeconds ?? 3600,
        showDoorSensors: vehicleConfig.showDoorSensors ?? false,
        climateProfiles: vehicleConfig.climateProfiles ?? [],
      };

      const client = new KiaClient(config.vin, auth, this.log);
      const uuid = this.api.hap.uuid.generate(config.vin);

      const existing = this.cachedAccessories.find((a) => a.UUID === uuid);
      if (existing) {
        this.log.info(`[Kia] Restoring "${config.name}" from cache.`);
        existing.displayName = config.name;
        this.api.updatePlatformAccessories([existing]);
        new VehicleAccessory(this, existing, client, config);
      } else {
        this.log.info(`[Kia] Registering new vehicle: ${config.name} (${config.vin})`);
        const accessory = new this.api.platformAccessory(config.name, uuid);
        accessory.context.vin = config.vin;
        new VehicleAccessory(this, accessory, client, config);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // Remove accessories for VINs no longer in config.
    const configuredUuids = new Set(vehicles.map((v) => this.api.hap.uuid.generate(v.vin)));
    const stale = this.cachedAccessories.filter((a) => !configuredUuids.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`[Kia] Removing ${stale.length} stale accessory/accessories.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
