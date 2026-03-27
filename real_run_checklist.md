# Real Run Checklist

This checklist is for the real end-to-end setup you described:
- backend already deployed on Render
- app already built and installed on the phone
- local `ecg-review-web` used only for visualization
- phone connected to the real BLE hardware

---

## 1. What must be true before you start

### Backend
- Your Render backend is up and reachable.
- The backend health endpoint responds successfully.
- The backend is using the correct Supabase environment variables.
- The backend bucket and tables are the same ones your mobile app expects.

### Mobile app build
The installed mobile app must have been built with the correct environment assumptions baked into it.

From the repo, the app runtime config is:
- PROD backend URL: `https://capstone-mobile-app.onrender.com`
  - `capstone-ecgapp/config/runtime-config.ts`
- PROD mode uses the hosted backend automatically.

For real hardware, the installed build should effectively be:
- `EXPO_PUBLIC_APP_ENV=PROD`
- `EXPO_PUBLIC_MOCK_MODE=DEV`

Why:
- `APP_ENV=PROD` makes the app use the hosted Render backend.
- `MOCK_MODE=DEV` means mock is OFF in production builds, so the app will use real BLE.

If the installed app was built with mock ON, or DEV backend settings, stop here and rebuild the app first.

### Local review web
The local `ecg-review-web` must point to the hosted backend, not `127.0.0.1:8001`.

Right now in this repo the Vite proxy is still:
- `ecg-review-web/vite.config.ts`
- target: `http://127.0.0.1:8001`

So before using the review web against Render, change that target to your Render backend URL.

Recommended edit:
```ts
server: {
  proxy: {
    "/api": {
      target: "https://capstone-mobile-app.onrender.com",
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api/, ""),
    },
  },
},
```

Then restart Vite.

---

## 2. Build the mobile app APK explicitly

Use this if you need to build and install the Android app yourself before the real run.

### 2.1 Prepare the mobile app environment

From:
- `capstone-ecgapp/`

make sure the production backend and real BLE behavior are what get baked into the build.

Recommended `.env` values for a real run:

```bash
EXPO_PUBLIC_APP_ENV=PROD
EXPO_PUBLIC_MOCK_MODE=DEV
```

Why:
- `APP_ENV=PROD` makes the app use:
  - `https://capstone-mobile-app.onrender.com`
- `MOCK_MODE=DEV` means:
  - mock ON in dev builds
  - mock OFF in production builds

So for the installed production APK, mock is OFF and the app uses real Bluetooth.

### 2.2 Install dependencies

```powershell
cd C:\src\capstone-ecgapp\capstone-ecgapp
npm install
```

### 2.3 Build a locally installable APK

For a straightforward APK file on your machine, use the native Android build.

#### Option A: Debug APK (simplest for direct install/testing)

```powershell
cd C:\src\capstone-ecgapp\capstone-ecgapp\android
.\gradlew assembleDebug
```

Output APK:
- `capstone-ecgapp/android/app/build/outputs/apk/debug/app-debug.apk`

This is the simplest path if your goal is just to get the app onto the phone and test the full real workflow.

#### Option B: Release APK

```powershell
cd C:\src\capstone-ecgapp\capstone-ecgapp\android
.\gradlew assembleRelease
```

Output APK:
- `capstone-ecgapp/android/app/build/outputs/apk/release/app-release.apk`

Use this only if your Android signing setup is already in place and working.

### 2.4 Install the APK on the phone

Enable on the phone:
- Developer Options
- USB debugging

Then connect the phone by USB and run:

```powershell
adb devices
adb install -r C:\src\capstone-ecgapp\capstone-ecgapp\android\app\build\outputs\apk\debug\app-debug.apk
```

If you built a release APK, install the release file instead.

### 2.5 Alternative: build and install directly

If you do not need the standalone APK file first and just want the app installed onto a connected phone:

```powershell
cd C:\src\capstone-ecgapp\capstone-ecgapp
npm run android
```

That uses:
- `expo run:android`

This path is useful for a USB-connected test device, but it is not the same as explicitly keeping an APK artifact.

### 2.6 Verify the installed app is the correct one

After install, confirm:
- the app opens normally
- it is the latest build
- it uses the hosted backend
- it is not in mock mode

If there is any doubt, rebuild after clearing the previous app from the phone.

---

## 3. Preflight checklist

Run through this before touching the hardware.

### Backend preflight
- [ ] Open Render backend health URL in browser or terminal.
- [ ] Confirm health returns OK.
- [ ] Confirm backend logs are visible in Render dashboard.
- [ ] Confirm Supabase Storage bucket contains prior calibration/session files as expected.

### Local machine preflight
- [ ] In `ecg-review-web/vite.config.ts`, proxy target points to the Render backend URL.
- [ ] `npm install` has already been run in `ecg-review-web`.
- [ ] You are ready to run local Vite only, not the local backend.

### Phone preflight
- [ ] Bluetooth is ON.
- [ ] Location permission / Nearby Devices permission is granted if required by Android.
- [ ] The installed app is the production-configured build.
- [ ] Mock mode is effectively OFF in the installed build.

### Hardware preflight
- [ ] ECG hardware is powered.
- [ ] Electrodes/leads are connected properly.
- [ ] The BLE device is advertising.
- [ ] The firmware you intend to use is the one actually flashed onto the board.

---

## 4. Start the local review web

From repo root:

```powershell
cd ecg-review-web
npm run dev
```

Expected result:
- Vite starts locally, typically on `http://127.0.0.1:5173`
- `/api/...` requests from the browser are proxied to the hosted Render backend

Important:
- Do **not** use `npm run dev:review` for this workflow, because that also tries to start a local backend.
- For this real run workflow, only the local frontend should run on your computer.

---

## 5. Verify the review web is hitting the hosted backend

Open:
- `http://127.0.0.1:5173`

Then verify one of these:
- browser devtools network shows `/api/...` requests succeeding
- or your Render backend logs show incoming `GET /review/...` or `GET /session/live/visual`

If the review web still tries to call `127.0.0.1:8001`, your Vite proxy change did not take effect.

---

## 6. Start the mobile workflow

On the phone:
1. Open the app.
2. Go through BLE connection flow.
3. Connect to the real ECG device.
4. Confirm the device is connected before calibration.

What to look for:
- no mock-mode indicators
- BLE device name is the real hardware
- the app does not behave like synthetic mode

---

## 7. Run calibration

On the phone:
1. Press calibration.
2. Keep the signal stable during the full capture period.
3. Let it complete.

Expected backend behavior:
- `POST /calibration_completion`
- backend evaluates the raw payload
- if suitable, calibration object is stored

What you should confirm:
- calibration returns successfully in the app
- the returned preview looks reasonable
- calibration is marked successful before starting a session

If calibration fails:
- do not proceed to session
- fix electrode placement / signal quality first

---

## 8. Start session run

On the phone:
1. Start the run/session.
2. Keep the device connected and signal stable.

Expected backend behavior:
- `POST /session/start`
- app receives a `record_id`
- app begins periodic live session uploads to:
  - `POST /add_to_session`

Expected local review-web behavior:
- open the live session page:
  - `http://127.0.0.1:5173/session`
- if needed, add the explicit record id:
  - `http://127.0.0.1:5173/session?recordId=<record_id>`

Recommended:
- use the explicit `recordId` URL once the session has started
- this avoids ambiguity if multiple sessions exist

---

## 9. Monitor live view on the computer

Open the live page locally:
- `http://127.0.0.1:5173/session?recordId=<record_id>`

Expected view:
- CH2 live graph
- CH3 live graph
- CH4 live graph
- 3D vectorcardiography live panel
- status cards for:
  - buffer size
  - heart rate

What to confirm:
- live view is receiving hosted-backend data
- heart rate updates
- graphs move continuously
- no repeated fetch failures in browser console
- no 500s in Render logs for `/add_to_session`

---

## 10. End session cleanly

On the phone:
1. Stop/end the session.
2. Allow the app to finish the upload flow.

Expected backend behavior:
- full session upload to:
  - `POST /end_session`
- backend stores session raw data
- backend processing / processed review artifacts become available

Do not close the app immediately after pressing stop.
Wait until the upload is confirmed complete.

---

## 11. Review the finished session locally

On the computer, open:
- `http://127.0.0.1:5173/`

Use the review UI to inspect:
- CH2 / CH3 / CH4
- 2D Vectorcardiography
- 3D Vectorgraphy

Expected:
- the local review frontend fetches from the hosted backend
- completed session appears in review endpoints
- artifacts load successfully

---

## 12. Exact recommended step order

Use this exact sequence on run day.

1. Confirm Render backend health is OK.
2. Confirm `ecg-review-web/vite.config.ts` targets the Render backend.
3. Start local Vite:
   ```powershell
   cd ecg-review-web
   npm run dev
   ```
4. Open `http://127.0.0.1:5173` on the computer.
5. If needed, build and install the correct APK onto the phone.
6. On the phone, open the installed app.
7. Connect to the real BLE device.
8. Run calibration and wait for success.
9. Start the session.
10. Get the `record_id` from app logs if needed.
11. Open:
    - `http://127.0.0.1:5173/session?recordId=<record_id>`
12. Monitor the live view during the session.
13. End the session from the phone.
14. Wait for upload completion.
15. Return to `http://127.0.0.1:5173/` and review the final results.

---

## 13. What to check if something fails

### Case A: Phone cannot reach backend
Check:
- app build is really PROD-configured
- Render URL is correct
- phone internet connection is working
- Render backend is not sleeping/failing

### Case B: Review web works locally but shows no data
Check:
- Vite proxy target is really the Render backend
- browser devtools network requests under `/api/...`
- Render logs for matching inbound requests
- session `record_id` is correct

### Case C: Calibration succeeds but session live view fails
Check:
- Render logs for:
  - `/session/start`
  - `/add_to_session`
- browser console on `ecg-review-web`
- phone app logs for backend POST failures

### Case D: Review fetch fails with missing object errors
Check:
- processed artifact rows vs actual storage objects
- Render logs now print the exact storage fetch URL and object key
- if needed, reload once to allow regeneration

---

## 14. Minimal terminal commands

### Build debug APK
```powershell
cd C:\src\capstone-ecgapp\capstone-ecgapp\android
.\gradlew assembleDebug
```

### Install debug APK
```powershell
adb install -r C:\src\capstone-ecgapp\capstone-ecgapp\android\app\build\outputs\apk\debug\app-debug.apk
```

### Start local review web only
```powershell
cd C:\src\capstone-ecgapp\ecg-review-web
npm run dev
```

### Optional: test hosted backend health from terminal
```powershell
Invoke-RestMethod https://capstone-mobile-app.onrender.com/health
```

---

## 15. Final readiness checklist

- [ ] Render backend health OK
- [ ] Render backend logs accessible
- [ ] `ecg-review-web` proxy points to Render backend
- [ ] Correct APK built or app installed directly to phone
- [ ] Local Vite frontend started
- [ ] Phone app build is PROD backend + real BLE
- [ ] BLE hardware powered and advertising
- [ ] Calibration completed successfully
- [ ] Session started and `record_id` known
- [ ] Live view opened locally with correct `recordId`
- [ ] Session ended cleanly and upload completed
- [ ] Final review page loads completed data
