# Quick Start

Use this file when you need the shortest path to get the repository working on a new machine.

For architecture and detailed handover notes, read `README.md` first.

## 1. Start the backend

```powershell
cd C:\src\capstone-ecgapp\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
fastapi dev app.py --host 127.0.0.1 --port 8001
```

Verify:

```powershell
Invoke-RestMethod http://127.0.0.1:8001/health
```

## 2. Start the review web

Open a second terminal:

```powershell
cd C:\src\capstone-ecgapp\ecg-review-web
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

Open `http://127.0.0.1:5173`.

If you already have valid Supabase records, this is the fastest path to verify the backend + review workflow.

## 3. Start the mobile app

Open a third terminal:

```powershell
cd C:\src\capstone-ecgapp\capstone-ecgapp
npm install
```

Create or update `.env` with at least:

```text
EXPO_PUBLIC_APP_ENV=DEV
EXPO_PUBLIC_MOCK_MODE=PROD
EXPO_PUBLIC_BACKEND_BASE_URL=http://127.0.0.1:8001
```

For Android device testing over USB, you will usually want:

```powershell
adb reverse tcp:8001 tcp:8001
```

Then run:

```powershell
npm run android
```

Use `EXPO_PUBLIC_MOCK_MODE=DEV` if you need simulated Bluetooth in development.

## 4. Know the key folders

- `backend/` - FastAPI service and Supabase integration
- `capstone-ecgapp/` - Expo mobile app
- `ecg-review-web/` - review UI
- `hardware-code/` - firmware
- `signal-processing-intense/` - notebooks and generated analysis artifacts

Before trying a real client setup, apply `schema.sql` in Supabase and read `DATABASE-README.md` for the required tables, policies, and storage bucket.

## 5. Read these next

- `backend/README.md`
- `capstone-ecgapp/README.md`
- `ecg-review-web/README.md`
- `hardware-code/README.md`
- `signal-processing-intense/README.md`
- `DATABASE-README.md`
- `schema.sql`

## 6. Handover cautions

- Apply `schema.sql` before testing a fresh client Supabase project.
- The mobile summary screen still contains mock insight content even though calibration and session upload are real.
- If `npm run dev:review` fails on a non-Windows machine, start the backend and review web in separate terminals instead.
- Do one full real dry run: calibration -> run session -> end session -> load the resulting `ecg_recordings.id` in the review web.
