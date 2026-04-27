# PulseSense ECG Capstone Repository

This repository contains the full software stack used in the project:

- `capstone-ecgapp/` - Expo React Native mobile app for onboarding, Bluetooth pairing, calibration, session capture, and session summary.
- `backend/` - FastAPI backend for calibration ingestion, live session buffering, session storage, review artifact generation, and static review image generation.
- `ecg-review-web/` - Vite React review UI for live session preview and backend-generated static comparison plots.
- `hardware-code/` - Arduino firmware for the XIAO nRF52840 + ADS1298 ECG hardware.
- `signal-processing-intense/` - notebooks and generated artifacts used to derive and validate the mean-beat / vectorcardiography workflow.

The repository is a monorepo. The mobile app, backend, firmware, and offline notebooks are related but are not interchangeable. The operational product path is:

1. firmware streams ECG packets over BLE,
2. mobile app captures calibration and session data,
3. backend stores raw binaries and processed artifacts in Supabase,
4. review web loads live preview data and static comparison plots,
5. notebooks remain the offline research / reproducibility workspace.

## What each part is responsible for

### Mobile app

The mobile app is the runtime client used during capture. It handles:

- onboarding,
- Bluetooth permissions and pairing,
- 20-second calibration capture,
- live run-session capture,
- chunked upload to the backend,
- final session upload,
- local SQLite packet buffering during a run.

Important current detail: the app triggers backend session analysis jobs, but the session summary insight cards still come from the mock service in `capstone-ecgapp/services/api-service.ts`. The upload flow is real; the post-run insight copy is not yet wired to real backend-derived metrics.

### Backend

The backend is the operational center of the system. It currently:

- accepts raw calibration payloads,
- scores calibration quality,
- stores calibration binaries,
- creates session records,
- accepts chunked live session uploads,
- keeps a live preview buffer for the web dashboard,
- persists live preview state to Supabase,
- finalizes raw session uploads,
- generates review artifacts per channel,
- generates static mean-beat / vectorcardiography comparison images for the review web.

### Review web

The review web is intentionally thin. It does not compute plots in the browser. It:

- loads backend-generated static review manifests and images on `/`,
- loads live preview data and SSE events on `/session`,
- relies on the backend for all ECG processing.

### Hardware firmware

The firmware samples the ADS1298 and streams BLE notification packets. The current packet contract is:

- 231 bytes per packet,
- 3-byte status word,
- 25 samples of CH2,
- 25 samples of CH3,
- 25 samples of CH4,
- 3-byte elapsed-time field,
- all samples encoded as signed 24-bit big-endian ADS1298 counts.

### Offline notebooks

The notebooks in `signal-processing-intense/` are the research workspace where the project’s mean-beat and vectorcardiography workflow was developed and demonstrated. The final static review logic in `backend/app.py` is derived from this notebook work, but the notebooks are not imported directly by the production backend.

## Repository map

```text
.
|- README.md
|- QUICK_START.md
|- backend/
|- capstone-ecgapp/
|- ecg-review-web/
|- hardware-code/
|- signal-processing-intense/
`- showcase_display.zip
```

`showcase_display.zip` is an archived standalone exhibition display deliverable and is not part of the core runtime stack documented below.

## Prerequisites

Install these on a new machine before attempting handover setup:

- Node.js 18+
- npm
- Python 3.12+
- Android Studio + Android SDK if the mobile app will be run on Android
- Xcode if the mobile app will be run on iOS
- Arduino IDE / compatible toolchain if the firmware will be rebuilt

## Fastest ways to get running

### 1. Review an existing record locally

This is the fastest full-stack verification path if Supabase already contains recordings.

```powershell
cd C:\src\capstone-ecgapp
npm install
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd ..
npm run dev:review
```

Then open:

- review web: `http://127.0.0.1:5173`
- backend health: `http://127.0.0.1:8001/health`

### 2. Run the mobile app against a local backend

- start the backend first,
- configure the mobile app `.env`,
- run `npm run android` or `npm run ios` inside `capstone-ecgapp/`.

For Android USB debugging with a local backend, `adb reverse tcp:8001 tcp:8001` is often the simplest option.

### 3. Reproduce the offline signal-processing workflow

Open the notebooks in `signal-processing-intense/`, starting with:

- `average-beat.ipynb`
- `step-by-step-signal-processing.ipynb`
- `plot.ipynb`

## Backend configuration

The backend expects Supabase credentials in environment variables. Either naming style below works because the code checks both:

- `SUPABASE_URL` or `EXPO_PUBLIC_SUPABASE_URL`
- `SUPABASE_ANON_KEY` or `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_STORAGE_BUCKET` or `EXPO_PUBLIC_SUPABASE_STORAGE_BUCKET`
- optional `BASE_URL` for generated absolute URLs; default is `http://127.0.0.1:8001`

The backend writes to these Supabase tables. The client-facing setup notes for this are in `DATABASE-README.md`.

The backend writes to these Supabase tables:

- `ecg_recordings`
- `ecg_session_chunks`
- `ecg_live_preview`
- `ecg_processed_records`
- `ecg_processed_artifacts`

It also writes binary and JSON/PNG artifacts into the configured storage bucket.

## Current data flow

### Calibration

1. Mobile app records roughly 20 seconds of BLE packets.
2. App posts raw bytes to `POST /calibration_completion`.
3. Backend decodes and resamples packets to 500 Hz.
4. Backend runs calibration quality checks on CH2 and stores the raw calibration `.bin`.
5. Backend returns cleaned preview series for CH2/CH3/CH4 and the `calibration_object_key`.

### Session capture

1. Mobile app starts a session with `POST /session/start`.
2. BLE packets are appended to local SQLite in the app.
3. During the run, packets are sent to `POST /add_to_session` in 20-packet chunks.
4. Backend updates live preview buffers and persists preview snapshots.
5. When the run ends, the full raw payload is sent to `POST /end_session`.
6. Backend stores the session `.bin` and starts review artifact generation.

### Static review generation

1. Review web loads a record ID.
2. Backend generates or loads a static manifest under `review-static/<record_id>/manifest.json`.
3. Backend computes CH4-anchored mean beats and comparison plots per 20-second window.
4. Review web displays backend-generated PNGs only.

## Handover notes the client should know

- The mobile app and backend assume the XIAO ECG firmware packet format described in `hardware-code/README.md`.
- The review web dev server proxies `/api/*` to `http://127.0.0.1:8001`. If the backend runs elsewhere, update `ecg-review-web/vite.config.ts`.
- The static review implementation currently assumes CH4 is the anchor lead for segmentation boundaries.
- The mobile run summary UI still uses mock insight text from `capstone-ecgapp/services/api-service.ts`, even though capture/upload is real.
- `signal-processing-intense/` should be treated as the reproducibility workspace, not as deployable application code.

## Remaining handover blindspots

These are the main things a client or new maintainer should know before assuming the repository is fully productionized:

- The mobile post-run summary cards still use mock content from `capstone-ecgapp/services/api-service.ts`; capture and upload are real, but that summary layer is not yet truly backend-driven.
- The backend currently uses the Supabase anon key pattern, so `schema.sql` intentionally creates broad database and storage policies for compatibility. This is convenient for handover, but not a hardened production-security posture.
- The root `npm run dev:review` script is Windows-oriented because it uses `.venv\Scripts\python.exe` in `package.json`. macOS/Linux users should start backend and review web separately unless that script is adjusted.
- Automated test coverage is minimal. The backend currently has an import smoke test, not a comprehensive integration test suite. A smooth client handover still depends on a real calibration + session + review dry run.
- The review web assumes the static-review generation pipeline and Supabase storage artifacts are working. If manifests or PNG objects are missing, the UI will not be useful until backend processing succeeds.

## Documentation map

This repository now keeps one primary README per major folder:

- `README.md` - repository-level overview and handover guide
- `QUICK_START.md` - shortest path to running the main pieces
- `backend/README.md` - backend setup, environment, endpoints, and storage model
- `capstone-ecgapp/README.md` - mobile app setup and operational behavior
- `ecg-review-web/README.md` - review web routes and usage
- `hardware-code/README.md` - firmware and packet protocol
- `signal-processing-intense/README.md` - notebook workspace and generated artifacts
- `DATABASE-README.md` - Supabase tables, storage expectations, and client setup checklist
- `schema.sql` - Supabase bootstrap SQL for the current backend contract
