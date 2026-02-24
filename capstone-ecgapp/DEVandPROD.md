# DEV and PROD Setup

## What Changes

The mobile app chooses backend URL and Bluetooth mock mode via env flags.
The FastAPI server is not changed by this.
Mock mode only toggles whether the app uses simulated Bluetooth data.
When mock mode is off, the app attempts real BLE connections (it does not
guarantee a device is available or connected).

## DEV (local backend)

Use local backend over HTTP:

```bash
# .env
EXPO_PUBLIC_APP_ENV=DEV
EXPO_PUBLIC_MOCK_MODE=DEV
# Optional but recommended: set exact backend host + port
# EXPO_PUBLIC_BACKEND_BASE_URL=http://192.168.1.12:8001
```

How DEV backend URL is selected:

- If `EXPO_PUBLIC_BACKEND_BASE_URL` is set, that value is used.
- Otherwise Android tries Expo host IP with `:8001`.
- Android emulator fallback is `http://10.0.2.2:8001`.
- iOS fallback is `http://127.0.0.1:8001`.

For Android physical device with USB, you can also keep localhost and use reverse:

```bash
adb reverse tcp:8001 tcp:8001
```

Run the app:

```bash
npm run android --dev
```

Tip: if you see `Network request failed`, set `EXPO_PUBLIC_BACKEND_BASE_URL`
to your machine LAN IP and ensure backend listens on `0.0.0.0`.

## PROD

Use hosted backend:

```bash
# .env
EXPO_PUBLIC_APP_ENV=PROD
EXPO_PUBLIC_MOCK_MODE=DEV
```

Run the app:

```bash
npm run android --dev
```

PROD backend URL used by the app:

- `https://capstone-mobile-app.onrender.com`

## Mock Mode Flag Behavior

- `EXPO_PUBLIC_MOCK_MODE=DEV`: mock ON in dev builds, mock OFF in prod builds.
- `EXPO_PUBLIC_MOCK_MODE=PROD`: mock OFF in dev builds, mock ON in prod builds.

If mock is OFF, the app will try to use real Bluetooth (permissions + device
required). If mock is ON, it streams simulated ECG data and does not require
hardware.
