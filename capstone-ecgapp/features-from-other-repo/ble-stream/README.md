# BLE Stream Feature (Drop‑in)

This feature is designed to be copied into another app with minimal friction.

## Files
- `BleStreamWidget.tsx` — UI component (pair + disconnect)
- `useBleStream.ts` — hook that orchestrates BLE scan + connect
- `bleService.ts` — BLE service wrapper (permissions, scan, connect)
- `types.ts` — types for devices and options

## One‑time native setup (Android)
Add these permissions to `android/app/src/main/AndroidManifest.xml`:
```
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```

## Required dependencies
- `react-native-ble-plx`

## Integration snippet
```tsx
import { BleStreamWidget } from "./src/features/ble-stream";

<BleStreamWidget
  options={{
    serviceUUID: "12345678-1234-1234-1234-1234567890ab",
    characteristicUUID: "87654321-4321-4321-4321-abcdefabcdef",
    scanTimeoutMs: 12000,
  }}
  onConnectionChange={(device) => {
    // device is null when disconnected
  }}
/>
```

## Behavior
- Tap **Pair with ECG device** to auto-connect to the first device advertising the service UUID.
- Tap **Disconnect from ECG device** to disconnect.
- Captions show the service/characteristic UUIDs being matched.
