# Features From Other Repo - Findings

This folder is a direct copy of the drop-in features from the other repo. It now exists at:
`capstone-ecgapp/features-from-other-repo/`.

## What is here
- `ble-stream/` - BLE connect/disconnect feature with a minimal widget + hook + service wrapper.
- `ble-stream-demo/` - A demo screen that renders BLE connect + calibration button together.
- `calibration/` - Calibration feature: record ~20s of samples, chunked SQLite storage, placeholder API call, store accepted baseline segment.
- `index.html` - Project plan/spec doc (architecture, BLE plan, data model, analysis plan).
- `xiao_nrf52840_ble_int16_stream.ino` - BLE peripheral code for the Xiao nRF52840.

## Feature details
### BLE Stream
- Entry points:
  - `ble-stream/index.ts`
  - `ble-stream/BleStreamWidget.tsx`
  - `ble-stream/useBleStream.ts`
  - `ble-stream/bleService.ts`
- Behavior:
  - Press **Pair with ECG device** to auto-connect to the first device matching the configured service UUID.
  - Press **Disconnect from ECG device** to disconnect.
  - Uses `react-native-ble-plx`.

### Calibration
- Entry points:
  - `calibration/index.ts`
  - `calibration/CalibrationButton.tsx`
  - `calibration/useCalibration.ts`
  - `calibration/calibrationStore.ts`
- Behavior:
  - Records ~20 seconds of ECG samples.
  - Stores chunks in SQLite with base64 little-endian int16 encoding.
  - Calls a placeholder API and expects `{ clean: boolean, clean_segment }`.
  - If API is invalid, returns a fake response (currently forces retry).
- Note: The README snippet in `calibration/README.md` still shows `chunkDurationSec: 12` in the example. The description states 2s chunks. Treat the snippet as outdated.

### BLE Stream Demo
- `ble-stream-demo/DemoScreen.tsx` renders:
  - `BleStreamWidget`
  - `CalibrationButton`

## Dependencies required (not added here)
- `react-native-ble-plx` (already in teammate repo)
- `react-native-sqlite-storage` (not in teammate repo yet)

## How this fits into the Expo app
The current app already has:
- BLE service in `services/bluetooth-service.ts`
- BLE UI in `components/device-connection-card.tsx`
- Onboarding BLE screen in `app/(onboarding)/bluetooth.tsx`

The copied features are self-contained and can replace or wrap the existing BLE service/UI.
There are two clean integration options:
1) **Direct import from this folder**
   - Use `features-from-other-repo/ble-stream` and `features-from-other-repo/calibration` as drop-in modules.
2) **Move into a canonical features path**
   - Create `src/features/ble-stream` and `src/features/calibration`, then move these files for long-term use.

## Practical integration path (recommended)
- Keep current BLE service as-is for now.
- Replace the onboarding BLE screen UI with `BleStreamWidget` to validate connect/disconnect reliability.
- Add `CalibrationButton` to the calibration screen once BLE is stable.
- Decide if we should delete or refactor the existing `services/bluetooth-service.ts` to avoid two BLE stacks.

## Known mismatches to resolve
- Existing BLE service has scan UI and pairing persistence; the drop-in feature auto-connects by UUID.
- The demo screen uses raw React Native components; the Expo app uses reusables + nativewind.

## Next steps I can do for you
- Wire `BleStreamWidget` into the Expo onboarding screen.
- Add a new `features/` directory and move these modules with updated imports.
- Replace the old BLE service with the new one (or align them).
- Add `react-native-sqlite-storage` and wiring for calibration storage.

---
If you want me to proceed, tell me which integration option you want (direct import vs move into `src/features/`).
