# homebridge-kia-connect-us

Homebridge plugin for Kia Connect (US API). Works with any vehicle on a US Kia Connect account.

> **Note:** The package is named `homebridge-kia-connect-us` because `homebridge-kia-connect` is already taken on npm by a different project.

## Features

- Lock and unlock from HomeKit
- Remote engine start / stop
- Climate profiles as grouped HomeKit switches with automatic timeout reset after the configured run duration
- Separate engine-running indicator service for quick status checks
- Fuel level as a HomeKit Battery service
- Optional combined openings sensor that shows open when any door, the hood, or the trunk is open
- Multi-vehicle support (all vehicles on the same Kia account)
- Session persistence via remember token — minimises OTP prompts
- Local web page for OTP entry during first login

## Requirements

- Homebridge `>=1.3.5`
- Node.js `>=16`
- US Kia Connect account
- VIN for each vehicle to control (17 characters)

## Installation

Install via the Homebridge UI (search for `homebridge-kia-connect-us`) or manually:

```bash
npm install -g homebridge-kia-connect-us
```

A sanitized sample Homebridge config is included at `examples/homebridge-config.sample.json`.

## Configuration

Add the platform to your Homebridge config, or use the UI form generated from the plugin schema:

```json
{
  "platform": "KiaConnect",
  "name": "Kia Connect",
  "email": "your-kia-email@example.com",
  "password": "your-kia-password",
  "otpPort": 38581,
  "vehicles": [
    {
      "name": "My Kia",
      "vin": "5XXXX0000XX000000",
      "refreshIntervalSeconds": 3600,
      "showDoorSensors": false,
      "climateProfiles": [
        {
          "name": "Heat",
          "temperature": 74,
          "duration": 10,
          "defrost": true,
          "rearWindowHeat": true,
          "sideMirrorHeat": true,
          "steeringWheelHeat": 2,
          "driverSeat": "high-heat",
          "passengerSeat": "medium-heat",
          "rearLeftSeat": "low-heat",
          "rearRightSeat": "low-heat"
        },
        {
          "name": "Cool",
          "temperature": 66,
          "duration": 10,
          "defrost": false,
          "rearWindowHeat": false,
          "sideMirrorHeat": false,
          "steeringWheelHeat": 0,
          "driverSeat": "high-cool",
          "passengerSeat": "medium-cool",
          "rearLeftSeat": "off",
          "rearRightSeat": "off"
        }
      ]
    }
  ]
}
```

### Configuration reference

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | yes | Kia Connect account email |
| `password` | string | yes | Kia Connect account password |
| `otpPort` | number | no | Port for the local OTP page (default `38581`) |
| `vehicles[].name` | string | yes | Display name in HomeKit |
| `vehicles[].vin` | string | yes | 17-character VIN |
| `vehicles[].refreshIntervalSeconds` | number | no | How often to poll vehicle status (default `3600`, minimum `300`) |
| `vehicles[].showDoorSensors` | boolean | no | Expose one combined contact sensor for all doors, hood, and trunk (default `false`) |
| `vehicles[].climateProfiles` | array | no | Named remote-start presets; each becomes a grouped HomeKit switch named `<vehicle> <profile>` and turns back off after its configured duration |

## HomeKit Behavior

- The main vehicle accessory stays grouped around the lock so it keeps the secure, car-like presentation in Home.
- Each climate profile is exposed as a switch named `<vehicle name> <profile name>`. This makes Siri phrase matching more reliable than a bare child switch name like `Heat`.
- A separate occupancy sensor named `<vehicle name> Engine Running` indicates whether the engine is currently on.
- If `showDoorSensors` is enabled, HomeKit shows one contact sensor named `<vehicle name> Openings` that goes open when any door, the hood, or the trunk is open.

### Siri Tips

- Prefer short profile names like `Heat`, `Cool`, or `Defrost`.
- Say the full generated name, for example: `Turn on 2022 K5 Heat`.
- If Siri is still inconsistent, create Home scenes such as `Warm up car` or `Cool down car` that toggle the profile switches. Siri usually resolves scene names more reliably than grouped child services.

#### Climate profile seat levels

`"off"` · `"low-heat"` · `"medium-heat"` · `"high-heat"` · `"low-cool"` · `"medium-cool"` · `"high-cool"`

## OTP Login Flow

The first time the plugin connects (and any time the remember token expires), Kia requires a one-time password sent to your registered email or phone.

The plugin starts a small local HTTP server on `otpPort` to accept the code:

| Method | URL |
|---|---|
| Browser form | `http://<homebridge-host>:38581/kia-otp` |
| Query string | `http://<homebridge-host>:38581/kia-otp?code=123456` |
| curl | `curl "http://localhost:38581/kia-otp?code=123456"` |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Plugin does not start | Check that `email` and `password` are set in config |
| VIN not found | Confirm the VIN is exactly 17 characters and is on the same Kia account |
| OTP page unreachable | Check for port conflicts or firewall rules; change `otpPort` if needed |
| Vehicle polled too often | Raise `refreshIntervalSeconds` (minimum 300) |

## Development

```bash
npm run build        # compile TypeScript → dist/
npm run lint         # ESLint
npm run watch        # build + npm link + nodemon (live reload)
npm run dev:smoke    # build + run local Homebridge against this repo
```

## Deploying Changes

### Deploy to the local Homebridge instance on this machine

This repo is already linked into the global Homebridge plugin install on this system, so deploying a code change locally is just:

```bash
npm run lint
npm run build
sudo systemctl restart homebridge
```

That rebuilds `dist/` in this repo and then restarts Homebridge so it loads the new code.

### Fresh manual install on another Homebridge host

```bash
npm install -g homebridge-kia-connect-us
sudo systemctl restart homebridge
```

### Update an existing manual install from npm

```bash
npm install -g homebridge-kia-connect-us@latest
sudo systemctl restart homebridge
```

### Publishing

```bash
npm run lint && npm run build && npm publish --dry-run  # validate
npm version patch                                        # bump version if needed
npm publish
```

## License

Apache-2.0
