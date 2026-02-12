# Calibration Feature (Drop-in)

Minimal calibration module with a single visible button. It captures ~20 seconds of ECG samples, stores raw samples in SQLite in fixed-duration chunks (2s), sends the full signal to a calibration API, and stores the cleanest 10-second segment as the "calibration signal".

## Files
- `CalibrationButton.tsx` — single-button UI
- `useCalibration.ts` — capture + API + storage
- `calibrationService.ts` — API client (placeholder URL)
- `calibrationStore.ts` — SQLite persistence
- `types.ts` — options/response types

## Required dependency
- `react-native-sqlite-storage`

## API contract (placeholder URL)
Default URL (replace later):
```
https://example.com/v1/calibration/assess
```

Request body:
```
{
  "sample_rate_hz": 500,
  "duration_s": 20,
  "format": "int16_le_base64",
  "samples_base64": "<base64 int16>"
}
```

Response body:
```
{
  "clean": true,
  "clean_segment": {
    "start_index": 2500,
    "sample_rate_hz": 500,
    "samples_int16": [ ... 5000 values ... ]
  }
}
```

## Local storage (SQLite)
Calibration data is stored in SQLite as:
- `calib_session` — single scratch session (recording/ended/accepted/rejected)
- `calib_chunk` — fixed-duration chunks (2s) with base64 int16 bytes
- `baseline_reference` — accepted baseline metadata + clean 10s segment

Chunk format (per row):
`session_id, chunk_index, start_ts_ms, end_ts_ms, sample_count, data_b64, checksum`

Baseline reference:
`baseline_session_id, accepted_at_ms, fs, lead_count, quality_summary_json, signal_start_index, signal_b64, signal_sample_count`

## UI feedback
The button shows:
- Recording countdown (20s) + packet count
- Chunk preview (index, sample_count, base64 prefix)
- A summary of the export payload (total samples + sha256)

## Integration snippet
Use an existing BLE connection, then render the button.
```tsx
import { useState } from "react";
import { BleStreamWidget } from "../ble-stream";
import { CalibrationButton } from "./src/features/calibration";

export function CalibrationScreen() {
  const [connectedDevice, setConnectedDevice] = useState<any | null>(null);

  return (
    <>
      <BleStreamWidget
        options={{
          serviceUUID: "12345678-1234-1234-1234-1234567890ab",
          characteristicUUID: "87654321-4321-4321-4321-abcdefabcdef",
        }}
        onConnectionChange={setConnectedDevice}
      />
      <CalibrationButton
        connectedDevice={connectedDevice}
        options={{
          serviceUUID: "12345678-1234-1234-1234-1234567890ab",
          characteristicUUID: "87654321-4321-4321-4321-abcdefabcdef",
          sampleRateHz: 500,
          durationSec: 20,
          chunkDurationSec: 2,
          apiUrl: "https://example.com/v1/calibration/assess"
        }}
      />
    </>
  );
}
```
