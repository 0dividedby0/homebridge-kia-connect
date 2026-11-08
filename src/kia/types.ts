// ─── Persisted auth state ────────────────────────────────────────────────────

export interface StoredToken {
  /** Kia session ID (sid) — expires in ~23 hours */
  accessToken: string;
  /** Remember token (rmtoken) — allows renewing session without OTP */
  refreshToken: string;
  /** Epoch ms when the access token expires */
  validUntil: number;
  /** Device ID generated on first login; must stay constant for rmtoken to work */
  deviceId: string;
}

// ─── OTP flow ────────────────────────────────────────────────────────────────

export interface OTPRequest {
  otpKey: string;
  requestId: string;
  hasEmail: boolean;
  hasSms: boolean;
  email?: string;
  sms?: string;
  rmTokenExpired: boolean;
}

// ─── Vehicle ──────────────────────────────────────────────────────────────────

export interface ApiVehicle {
  /** Session-specific vehicle key (vehicleKey) — changes per session */
  key: string;
  /** Additional UUID-like vehicle keys exposed by the garage list response */
  keyCandidates: string[];
  /** Stable vehicle identifier */
  identifier: string;
  /** VIN candidates exposed by the garage list response */
  vinCandidates: string[];
  name: string;
  model: string;
}

export interface VehicleStatus {
  isEngineOn: boolean;
  isLocked: boolean;
  fuelLevel: number;
  isFuelLow: boolean;
  isAirOn: boolean;
  /** Present only for EV/PHEV vehicles that report `evStatus`. */
  ev?: {
    /** High-voltage battery state of charge, 0–100. */
    batteryLevel: number;
    isCharging: boolean;
    isPluggedIn: boolean;
  };
  doors: {
    frontLeft: boolean;
    frontRight: boolean;
    rearLeft: boolean;
    rearRight: boolean;
    hood: boolean;
    trunk: boolean;
  };
  lastUpdatedAt: Date;
}

// ─── Climate profiles ─────────────────────────────────────────────────────────

export type SeatLevel =
  | 'off'
  | 'low-heat'
  | 'medium-heat'
  | 'high-heat'
  | 'low-cool'
  | 'medium-cool'
  | 'high-cool';

export interface ClimateProfile {
  name: string;
  /** Fahrenheit integer 62–82, or "LOW"/"HIGH" */
  temperature: number;
  /** Run duration in minutes (2–10) */
  duration: number;
  defrost: boolean;
  rearWindowHeat: boolean;
  sideMirrorHeat: boolean;
  /** 0 = off, 1 = low, 2 = high */
  steeringWheelHeat: 0 | 1 | 2;
  driverSeat: SeatLevel;
  passengerSeat: SeatLevel;
  rearLeftSeat: SeatLevel;
  rearRightSeat: SeatLevel;
}

// ─── Plugin config ────────────────────────────────────────────────────────────

export interface VehicleConfig {
  name: string;
  vin: string;
  refreshIntervalSeconds: number;
  showDoorSensors: boolean;
  climateProfiles: ClimateProfile[];
}

// ─── Raw API shapes (minimal — only fields we use) ───────────────────────────

export interface GvlVehicleSummary {
  vehicleIdentifier: string;
  vehicleKey: string;
  nickName: string;
  modelName: string;
  vin?: string;
  vinNumber?: string;
  vinNo?: string;
  vehicle?: {
    vin?: string;
  };
  vehicleDetail?: {
    vehicle?: {
      vin?: string;
    };
  };
}

export interface GviResponse {
  status: { statusCode: number; errorType: number; errorCode: number };
  payload: {
    vehicleInfoList: Array<{
      vinKey: string;
      vehicleConfig: {
        vehicleDetail: {
          vehicle: {
            vin: string;
          };
        };
      };
      lastVehicleInfo: {
        vehicleStatusRpt: {
          vehicleStatus: {
            engine: boolean;
            doorLock: boolean;
            fuelLevel: number;
            lowFuelLight: boolean;
            evStatus?: {
              /** State of charge, 0–100. */
              batteryStatus?: number;
              batteryCharge?: boolean;
              /** 0 = unplugged; non-zero = plugged in. */
              batteryPlugin?: number;
            };
            climate: {
              airCtrl: boolean;
            };
            doorStatus: {
              frontLeft: number;
              frontRight: number;
              backLeft: number;
              backRight: number;
              hood: number;
              trunk: number;
            };
            syncDate: { utc: string };
          };
        };
      };
    }>;
  };
}
