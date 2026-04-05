# Changelog

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
