# homebridge-kia-connect-k5

Homebridge plugin for Kia Connect (US API) focused on Kia K5 support.

It exposes lock controls, engine start/stop, climate profile triggers, fuel level, and optional door/hood/trunk sensors in HomeKit.

## Features

- Dynamic platform plugin (`KiaConnect`)
- Multi-vehicle support (same Kia account)
- Door lock and unlock from HomeKit
- Engine switch:
  - ON: starts the first climate profile (or a safe default profile if none is configured)
  - OFF: sends remote stop
- Climate profiles as one-shot HomeKit switches
- Fuel level as HomeKit Battery service
- Optional contact sensors for doors, hood, and trunk
- Session persistence with remember token (`rmtoken`) to reduce OTP prompts
- Local OTP entry page during authentication

## Requirements

- Homebridge `>=1.3.5`
- Node.js `>=16`
- Kia Connect account credentials
- At least one vehicle VIN (17 characters)

## Installation

### From source (local development)

```bash
npm install
npm run build
```

For iterative development on a development machine:

```bash
npm run watch
```

## Homebridge Configuration

Add this platform config to your Homebridge config (or use the Homebridge UI fields generated from `config.schema.json`):

```json
{
  "platform": "KiaConnect",
  "name": "Kia Connect",
  "email": "your-kia-email@example.com",
  "password": "your-kia-password",
  "otpPort": 38581,
  "vehicles": [
    {
      "name": "My K5",
      "vin": "KNAG24J80P5XXXXXX",
      "refreshIntervalSeconds": 3600,
      "showDoorSensors": true,
      "climateProfiles": [
        {
          "name": "Winter Warmup",
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
          "name": "Summer Cooldown",
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

## OTP Login Flow

When a new login is required, the plugin starts a local OTP HTTP endpoint on `otpPort`.

- Browser method:
  - `http://<homebridge-host>:38581/kia-otp`
- Query-string method:
  - `http://<homebridge-host>:38581/kia-otp?code=123456`
- Curl method:
  - `curl "http://localhost:38581/kia-otp?code=123456"`

If the remember token expires, OTP is required again.

## Raspberry Pi Homebridge OS Testing Guide

This section is for testing on a Raspberry Pi running Homebridge OS.

### 1) Prepare the plugin package on your dev machine

From this project directory:

```bash
npm ci
npm run build
npm pack
```

This creates a tarball like `homebridge-kia-connect-k5-1.0.0.tgz`.

### 2) Copy package to Raspberry Pi

Copy the tarball to the Pi (replace host/user as needed):

```bash
scp homebridge-kia-connect-k5-1.0.0.tgz homebridge@homebridge.local:/tmp/
```

### 3) Install on Homebridge OS

SSH into Homebridge:

```bash
ssh homebridge@homebridge.local
```

Install the tarball globally for Homebridge:

```bash
sudo npm install -g --unsafe-perm /tmp/homebridge-kia-connect-k5-1.0.0.tgz
```

### 4) Configure plugin in Homebridge UI

- Open Homebridge UI (`http://homebridge.local:8581` by default)
- Go to Plugins or Config
- Add platform `KiaConnect` with:
  - email
  - password
  - otpPort (default `38581`)
  - at least one vehicle VIN
- Save and restart Homebridge

### 5) Complete OTP on first authentication

From a device on the same network, open:

- `http://homebridge.local:38581/kia-otp`

Enter the 6-digit code and wait for success confirmation.

If `homebridge.local` does not resolve, use the Pi IP:

- `http://<PI_IP>:38581/kia-otp`

### 6) Validate behavior in logs

In Homebridge UI logs, confirm messages similar to:

- OTP server listening
- authentication successful
- vehicle registered or restored
- periodic status refresh

Then test in Apple Home:

- Lock and unlock the car
- Turn Engine switch ON/OFF
- Trigger climate profile switches
- Check fuel level
- Verify door sensors (if enabled)

### 7) Regression checklist after restart

Restart Homebridge and verify:

- Vehicle accessory restores from cache
- Commands still execute
- OTP is not required again unless token expired

## VS Code Remote SSH Dev Environment (Raspberry Pi)

You can develop directly on your Raspberry Pi Homebridge OS instance using VS Code Remote - SSH.

### 1) Enable SSH on Homebridge OS

- In Homebridge UI, open Terminal settings and enable SSH.
- From your Mac, verify access:

```bash
ssh homebridge@homebridge.local
```

### 2) Connect from VS Code

- Install extension: Remote - SSH
- Add a host entry in your SSH config:

```sshconfig
Host homebridge-pi
  HostName homebridge.local
  User homebridge
```

- In VS Code, run: Remote-SSH: Connect to Host... and select `homebridge-pi`.

### 3) Clone plugin source on the Pi

In the VS Code remote terminal:

```bash
mkdir -p ~/dev
cd ~/dev
git clone <your-repo-url> homebridge-kia-connect-k5
cd homebridge-kia-connect-k5
npm ci
npm run build
```

### 4) Link plugin into Homebridge runtime

From plugin directory:

```bash
sudo npm link
```

Then link it in Homebridge app directory:

```bash
cd /var/lib/homebridge
sudo npm link homebridge-kia-connect-k5
sudo hb-service restart
```

### 5) Fast edit-build-test loop

From plugin source directory:

```bash
npm run watch
```

After meaningful changes, restart Homebridge service:

```bash
sudo hb-service restart
```

Check Homebridge UI logs and verify command behavior in Apple Home.

### 6) Reliable fallback if linking is problematic

If `npm link` behaves unexpectedly on your Pi, use package install flow instead:

```bash
cd ~/dev/homebridge-kia-connect-k5
npm pack
sudo npm install -g --unsafe-perm ./homebridge-kia-connect-k5-1.0.0.tgz
sudo hb-service restart
```

Tip: Replace the tarball filename with the version you generated.

## Local Smoke Test (SSH Workspace)

For this repository, a local Homebridge test config is included at `.homebridge-dev/config.json`.

1) Edit credentials and vehicle values:

- `email`
- `password`
- `vehicles[0].vin`

2) Build and run Homebridge against this plugin source path:

```bash
npm run dev:smoke
```

This command:

- compiles TypeScript to `dist/`
- starts Homebridge in debug + insecure mode
- uses `.homebridge-dev` as user storage
- loads plugins only from this repository path

3) Verify in output:

- plugin registration (`KiaConnect`)
- accessory registration/restoration
- OTP server start when fresh login is needed

4) Submit OTP from another device on your network:

```bash
http://<pi-ip>:38581/kia-otp
```

5) Stop the smoke test with Ctrl+C.

## Build And Install

### Build a distributable package

From the project directory:

```bash
npm run build
npm pack
```

This creates a tarball like:

```bash
homebridge-kia-connect-k5-1.0.0.tgz
```

### Install the built package on Homebridge

If you are installing on the same Homebridge Pi where you built the package:

```bash
cd /home/pi/homebridge-kia-connect
sudo npm install -g --unsafe-perm ./homebridge-kia-connect-k5-1.0.0.tgz
sudo hb-service restart
```

If you built elsewhere, copy the tarball to the Homebridge machine and install it there:

```bash
scp homebridge-kia-connect-k5-1.0.0.tgz homebridge@homebridge.local:/tmp/
ssh homebridge@homebridge.local
sudo npm install -g --unsafe-perm /tmp/homebridge-kia-connect-k5-1.0.0.tgz
sudo hb-service restart
```

After installation:

- open the Homebridge UI
- confirm the `KiaConnect` platform is installed
- add or update the platform config
- restart Homebridge if required
- complete OTP if prompted

## Install From Source

If you want Homebridge to run directly from your working tree while you edit code:

```bash
cd /home/pi/homebridge-kia-connect
sudo npm link
cd /var/lib/homebridge
sudo npm link homebridge-kia-connect-k5
sudo hb-service restart
```

This is the fastest loop for active development on the Pi.

## Publish To npm

The package is set up to publish only the runtime files needed by Homebridge.

### Validate before publishing

```bash
npm run build
npm publish --dry-run
```

### Publish

```bash
npm login
npm publish
```

If you need a new version first:

```bash
npm version patch
npm publish
```

Use `patch`, `minor`, or `major` depending on the release.

### Release checklist

- run `npm run lint`
- run `npm run build`
- run `npm run dev:smoke` for a quick local verification
- run `npm publish --dry-run`
- publish with `npm publish`

## Troubleshooting

- Missing credentials:
  - Ensure `email` and `password` are present in config.
- VIN not found:
  - Confirm VIN is exactly 17 characters and belongs to the same Kia account.
- OTP page unreachable:
  - Check port conflicts and firewall rules, or change `otpPort`.
- Frequent wake/polling concerns:
  - Increase `refreshIntervalSeconds` (minimum is 300; default is 3600).

## Development Scripts

```bash
npm run build      # compile TypeScript to dist/
npm run lint       # run ESLint
npm run watch      # build + link + nodemon for development
npm run dev:homebridge  # run local Homebridge against this repo
npm run dev:smoke       # build + run local Homebridge smoke test
```

## License

Apache-2.0
