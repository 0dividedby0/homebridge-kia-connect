# Changelog

## [1.1.4] - 2026-05-05

### Changed
- **Homebridge 2 compatibility metadata** — explicitly marked the plugin as supporting Homebridge `^1.6.0 || ^2.0.0` so Homebridge UI can recognize it as v2-ready.
- **Runtime support matrix** — updated the declared Node.js support range to current Homebridge-supported releases.
- **Development dependency alignment** — updated the local Homebridge dev dependency to the current stable line used for regular testing.

### Added
- **Homebridge 2 beta smoke test** — added CI coverage that installs `homebridge@beta`, builds the plugin, and verifies the platform loads successfully.
- **Local smoke config** — added a minimal `.homebridge-smoke` config and `smoke:homebridge` script for quick local load checks without real Kia credentials.

## [1.1.3] - 2026-04-18

### Added
- **Engine running indicator** — added a separate HomeKit occupancy sensor so engine state is visible even when climate profile switches are off.

### Changed
- **Climate profile switch naming** — profile switches are now exposed as `<vehicle name> <profile name>` to improve Siri matching while keeping them grouped under the main vehicle accessory.
- **Door status presentation** — replaced the individual front/rear/hood/trunk contact sensors with a single combined openings sensor that reports open if any door, the hood, or the trunk is open.

### Fixed
- **Climate profile switches staying ON too long** — profile switches now auto-reset to OFF after the configured remote-start duration so HomeKit better reflects the end of the session.

## [1.1.2] - 2026-04-04

### Fixed
- **Rear window defrost / steering wheel heat not working** — `heatingAccessory.rearWindow` does not exist in the Kia NA API schema and was silently ignored. Moved rear window heat to the correct top-level `remoteClimate.heating1` field. The previous 1.1.0 attempt at this fix was masked by a concurrent `airCtrl: true → 1` type error that caused a hard 9001 rejection; this release keeps `airCtrl` as a boolean and only corrects the field placement.

## [1.1.1] - 2026-04-04

### Fixed
- **API error 9001 "Incorrect request payload format"** — the 1.1.0 refactor inadvertently changed `airCtrl: true` to `airCtrl: 1` (API expects a boolean) and introduced a top-level `heating1` field that does not exist in the Kia NA API schema. Reverted the `remoteClimate` body to the accepted structure.

## [1.1.0] - 2026-04-04

### Fixed
- **"No Response" / infinite retry loop** — `onSet` handlers were awaiting commands that can take 30–90 seconds, causing HomeKit to time out, show "No Response", and repeatedly re-queue the same command. All handlers now fire-and-forget into the serial command queue and return immediately.
- **Engine cannot be turned off after a climate profile start** — The separate Engine switch was removed when climate profiles were configured, leaving no way to stop the car. Profile switches now stay ON while the engine is running from that profile; turning the switch OFF stops the engine. Triggering a different profile while one is active turns the old switch OFF and starts the new one.
- **Rear window defrost not working** — The API request body used `heatingAccessory.rearWindow` which does not exist in the Kia NA API. Changed to the correct top-level `heating1` field.
- **Steering wheel heat not working** — The API request body included a spurious `steeringWheelStep` field inside `heatingAccessory` that caused the request to be rejected. Removed.
- **Lock switch loses pending state** — `getLockTargetState()` now returns the in-flight `pendingLockTarget` value while a lock or unlock command is in progress, so HomeKit correctly shows the transitioning state instead of reverting prematurely.

### Changed
- Climate profile switches now persist ON while the engine is running (previously they were momentary and auto-reset to OFF after 1.5 s).
- The Engine switch is now only shown when no climate profiles are configured. With profiles, the active profile switch serves as the engine indicator.

## [1.0.0] - Initial release
