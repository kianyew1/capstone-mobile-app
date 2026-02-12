# BLE Stream Demo (Phone Test)

This folder provides a minimal screen that renders `BleStreamWidget` and the `CalibrationButton` so you can test on a phone quickly.

## 1) Add the demo screen to your app
In your main app entry (e.g., `mobile-app/App.tsx`), replace the app content with:

```tsx
import React from "react";
  import { BleStreamDemoScreen } from "./src/features/ble-stream-demo/DemoScreen";

export default function App() {
  return <BleStreamDemoScreen />;
}
```

## 2) Install dependencies (if not already)
```bash
cd mobile-app
npm install
```

## 3) Run on your Android phone (USB debugging)
1. Enable **Developer Options** → **USB Debugging** on your phone.
2. Connect the phone via USB and accept the debugging prompt.
3. Verify:
   ```bash
   adb devices
   ```
4. Run:
   ```bash
   npx react-native run-android
   ```

## 4) Fast iteration
Once installed:
```bash
npx react-native start
```
Then on your phone: shake → **Reload**.

## 5) Match UUIDs
Ensure these match your BLE sender:
- `serviceUUID`
- `characteristicUUID`

They are defined inside `DemoScreen.tsx`.
