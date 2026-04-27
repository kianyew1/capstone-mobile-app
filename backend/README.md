# Backend

This folder contains the FastAPI backend used by the mobile app and the review web.

## Responsibilities

The backend currently handles five distinct jobs:

1. calibration ingestion and quality scoring,
2. live session chunk ingestion and preview buffering,
3. final session upload and raw binary storage,
4. processed review artifact generation,
5. static comparison image generation for the review web.

## Main files

- `app.py` - FastAPI application and almost all ECG processing logic
- `supabase.py` - REST + storage helpers for Supabase
- `ui_previews.py` - live preview state helpers
- `requirements.txt` - Python dependencies
- `tests/test_imports.py` - basic import smoke test

## Python and dependencies

- Python `3.12+`
- Dependencies from `requirements.txt`

Create a local environment and install dependencies:

```powershell
cd C:\src\capstone-ecgapp\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

For a fresh client database, apply the repo-root `schema.sql` first, then follow the environment setup below.

## Environment variables

The backend requires Supabase credentials and storage bucket configuration.

Required:

- `SUPABASE_URL` or `EXPO_PUBLIC_SUPABASE_URL`
- `SUPABASE_ANON_KEY` or `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_STORAGE_BUCKET` or `EXPO_PUBLIC_SUPABASE_STORAGE_BUCKET`

Optional:

- `BASE_URL` - defaults to `http://127.0.0.1:8001`

## Run locally

```powershell
fastapi dev app.py --host 127.0.0.1 --port 8001
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8001/health
```

## Supabase dependencies

### Tables used

- `ecg_recordings`
- `ecg_session_chunks`
- `ecg_live_preview`
- `ecg_processed_records`
- `ecg_processed_artifacts`

### Storage usage

The configured storage bucket is used for:

- raw calibration binaries: `calibration/<run_id>.bin`
- raw session binaries: `session/<session_id>.bin`
- processed JSON artifacts: `processed/<record_id>/...`
- static review manifests and PNGs: `review-static/<record_id>/...`

## Runtime flows

### Calibration flow

`POST /calibration_completion`

- expects raw packet bytes in the body,
- validates packet framing and elapsed-time data,
- decodes ADS1298 packets,
- resamples to 500 Hz,
- scores CH2 signal quality,
- stores the raw calibration binary,
- optionally inserts an `ecg_recordings` row when `X-User-Id` is supplied,
- returns cleaned preview arrays for CH2/CH3/CH4.

### Live session flow

`POST /session/start` initializes the record and in-memory preview state.

`POST /add_to_session`:

- accepts 20-packet chunks from the mobile app,
- updates the in-memory live preview buffer,
- publishes SSE preview events,
- persists preview state to Supabase in the background,
- stores the chunk metadata row.

`GET /session/live/visual` and `GET /session/live/events` power the live dashboard in `ecg-review-web`.

### Final session upload

`POST /end_session`

- stores the full session binary,
- updates the `ecg_recordings` row,
- marks the live session as ended,
- triggers review artifact generation.

## Review processing

There are two distinct review paths.

### Channel review artifacts

`_process_review_artifacts_for_record()` generates JSON artifacts for CH2, CH3, and CH4 and writes them under `processed/<record_id>/...`.

The relevant endpoints are:

- `POST /review/{record_id}/process`
- `GET /review/process/{job_id}`
- `GET /review/latest`
- `GET /review/{record_id}`
- `GET /review/{record_id}/window`
- `GET /review/{record_id}/session_window`
- `GET /review/{record_id}/vector_beat`
- `GET /review/{record_id}/vector3d_beat`
- `POST /review/{record_id}/vector3d_preload`

### Static review images

The newer review web path uses backend-generated static PNGs instead of plotting in the browser.

Key endpoints:

- `GET /review_static/{record_id}/manifest`
- `POST /review_static/{record_id}/process`
- `GET /review_static/process/{job_id}`
- `GET /review_static/{record_id}/image`

Current method summary:

- window size is 20 seconds,
- CH4 is used as the segmentation anchor,
- CH2/CH3/CH4 mean beats are derived using CH4-based boundaries,
- outlier beats are rejected using a z-threshold,
- backend emits waveform, 2D VCG-style, and 3D VCG-style PNGs per window.

## Important implementation facts

- Packet format assumed by the backend must match the firmware in `hardware-code/`.
- `DEFAULT_SAMPLE_RATE_HZ` is 500 Hz.
- Live preview buffers are intentionally short and are not the same as full-run processing.
- Static review logic in `app.py` is derived from the notebooks in `signal-processing-intense/`.

## Testing

Smoke test:

```powershell
pytest
```

The current test coverage is minimal. The test suite verifies import stability only.
