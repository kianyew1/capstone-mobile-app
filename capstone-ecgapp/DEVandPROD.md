# DEV and PROD Setup

## What Changes

The mobile app chooses backend URL and Bluetooth mock mode via env flags.
The FastAPI server is not changed by this.
Mock mode only toggles whether the app uses simulated Bluetooth data.
When mock mode is off, the app attempts real BLE connections (it does not
guarantee a device is available or connected).

## DEV (physical device with USB + reverse)

Use local backend over HTTP:

```bash
# .env
EXPO_PUBLIC_APP_ENV=DEV
EXPO_PUBLIC_MOCK_MODE=DEV
```

Android reverse (so the device can reach your localhost):

```bash
adb reverse tcp:8001 tcp:8001
```

Run the app:

```bash
npm run android --dev
```

DEV backend URL used by the app:

- `http://127.0.0.1:8001`

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
