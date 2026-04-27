# Mobile App

This folder contains the Expo React Native mobile client used during data capture.

## What the app currently does

The app is responsible for the runtime capture workflow:

1. onboarding,
2. permissions,
3. Bluetooth pairing,
4. calibration capture,
5. session capture,
6. local packet persistence during a session,
7. final upload and session-summary display.

It is not a thin shell. The app owns BLE, local buffering, onboarding state, and the session timer/state machine.

## Main folders

- `app/` - Expo Router screens
- `components/` - app and UI components
- `config/` - runtime environment and mock-mode switches
- `services/` - BLE, backend, packet, and storage services
- `stores/` - Zustand stores for app, Bluetooth, and session state
- `assets/` - static assets and mock assets

## Key screens

- `app/(onboarding)/welcome.tsx`
- `app/(onboarding)/account.tsx`
- `app/(onboarding)/permissions.tsx`
- `app/(onboarding)/bluetooth.tsx`
- `app/calibration.tsx`
- `app/run-session.tsx`
- `app/run-summary.tsx`
- `app/(tabs)/index.tsx`
- `app/(tabs)/explore.tsx`
- `app/(tabs)/settings.tsx`

## Key services

- `services/bluetooth-service.ts` - BLE scanning, connection, and ECG notifications
- `services/backend-ecg.ts` - session start, chunk upload, final upload
- `services/calibration-quality.ts` - calibration upload call
- `services/session-packet-storage.ts` - local SQLite session packet buffer
- `services/session-analysis.ts` - starts backend analysis jobs
- `services/api-service.ts` - currently mock summary/insight data

## Important current implementation details

### Bluetooth

The app uses `react-native-ble-plx` and expects the ECG firmware UUIDs hardcoded in `services/bluetooth-service.ts`:

- service UUID: `12345678-1234-1234-1234-1234567890ab`
- characteristic UUID: `87654321-4321-4321-4321-abcdefabcdef`

Mock mode can replace the real BLE stream when enabled.

### Calibration flow

`app/calibration.tsx` records approximately 20 seconds of packets, skips one warmup packet, and sends the raw bytes to the backend via `services/calibration-quality.ts`.

The backend returns:

- a quality percentage,
- a suitability flag,
- CH2/CH3/CH4 preview arrays,
- a `calibration_object_key`,
- an optional `record_id`.

Those values are stored in the app store and used later when starting a real session.

### Session flow

`app/run-session.tsx`:

- starts a backend record with `POST /session/start`,
- stores every packet locally in SQLite,
- sends 20-packet chunks to `POST /add_to_session`,
- records session state in Zustand,
- prepares a pending upload reference for the summary screen.

`app/run-summary.tsx`:

- loads the persisted session packet capture from SQLite,
- uploads the full raw payload with `POST /end_session`,
- triggers backend analysis with `POST /session_analysis/start`,
- shows a summary UI.

### Important caveat: summary insights are still mocked

The summary screen currently calls `getSessionAnalysis()` from `services/api-service.ts`, which returns mock insights and heart-rate zone data. That means:

- calibration upload is real,
- session upload is real,
- backend analysis job trigger is real,
- summary insight cards are still mock content.

This should be made explicit during handover so the client does not assume the mobile summary is already wired to the backend review artifacts.

## Environment variables

Create `capstone-ecgapp/.env`.

Common local-development setup:

```text
EXPO_PUBLIC_APP_ENV=DEV
EXPO_PUBLIC_MOCK_MODE=PROD
EXPO_PUBLIC_BACKEND_BASE_URL=http://127.0.0.1:8001
```

### Meanings

- `EXPO_PUBLIC_APP_ENV=DEV` - app targets a local backend URL strategy
- `EXPO_PUBLIC_APP_ENV=PROD` - app uses the hardcoded production backend URL in `config/runtime-config.ts`
- `EXPO_PUBLIC_MOCK_MODE=DEV` - mock Bluetooth is on in development builds
- `EXPO_PUBLIC_MOCK_MODE=PROD` - mock Bluetooth is off in development builds
- `EXPO_PUBLIC_BACKEND_BASE_URL` - explicit override for local backend address

## Running locally

Install dependencies:

```powershell
cd C:\src\capstone-ecgapp\capstone-ecgapp
npm install
```

Run on Android:

```powershell
npm run android
```

Run on iOS:

```powershell
npm run ios
```

Run web preview:

```powershell
npm run web
```

## Device and build notes

- BLE functionality requires native builds; Expo Go is not the target workflow here.
- Android cleartext traffic is enabled in `app.json` so a local HTTP backend can be used during development.
- Android physical-device testing often needs `adb reverse tcp:8001 tcp:8001`.
- iOS requires the Bluetooth and location usage descriptions already configured in `app.json`.

## Persistence and state

### Zustand stores

- `stores/app-store.ts` - onboarding, user, permissions, paired device, calibration result
- `stores/bluetooth-store.ts` - scan/connection state
- `stores/session-store.ts` - active session state and local history

### Local SQLite

`services/session-packet-storage.ts` stores session packets to `session_packets.db` so the app can survive temporary interruptions before final upload.

## Useful handover checks

Before handing the app to a new developer or client team, verify these paths:

1. onboarding completes,
2. real or mock BLE connection succeeds,
3. calibration reaches backend and returns a preview,
4. session starts and chunks upload during capture,
5. final session upload succeeds,
6. a new `ecg_recordings.id` can be reviewed in `ecg-review-web`.
