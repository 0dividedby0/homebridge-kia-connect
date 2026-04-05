# Local Homebridge Deployment

Steps to build and install the plugin into the local Homebridge instance running at `/var/lib/homebridge`.

## Prerequisites

- Node.js ≥ 16 and npm available on the Pi
- Homebridge installed via the official package (plugin directory: `/var/lib/homebridge/node_modules`)
- Working directory: `/home/pi/homebridge-kia-connect`

## Steps

### 1. Bump the version

Edit `package.json` and increment the version field:

```json
"version": "1.1.0"
```

Follow [semver](https://semver.org/): patch for bug fixes, minor for new features, major for breaking changes.

### 2. Build

```bash
npm run build
```

This runs `rimraf ./dist && tsc`, writing compiled output to `dist/`.

### 3. Install into Homebridge

```bash
sudo npm install --prefix /var/lib/homebridge .
```

This copies the package (including `dist/` and `config.schema.json`) into `/var/lib/homebridge/node_modules/homebridge-kia-connect-us` and updates its `package.json`.

### 4. Verify the installed version

```bash
cat /var/lib/homebridge/node_modules/homebridge-kia-connect-us/package.json | grep '"version"'
```

### 5. Restart Homebridge

```bash
sudo systemctl restart homebridge
```

Homebridge will reload the plugin on startup. Check the Homebridge UI or `journalctl -u homebridge -f` for log output.

## Quick one-liner (steps 2–3 combined)

```bash
npm run build && sudo npm install --prefix /var/lib/homebridge .
```
