# Review Web

This folder contains the React + Vite web UI used for two things:

- static review of processed runs on `/`
- live session visualization on `/session`

The frontend does not do heavy ECG processing. It depends on the FastAPI backend for all review data and plot generation.

## Tech stack

- React 19
- TypeScript
- Vite

## Local run

```powershell
cd C:\src\capstone-ecgapp\ecg-review-web
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

The Vite dev server proxies `/api/*` to `http://127.0.0.1:8001`.

If your backend runs elsewhere, update `vite.config.ts`.

## Routes

### `/`

Static review page.

What it does:

- accepts an `ecg_recordings.id`,
- loads a static review manifest from the backend,
- can trigger backend static review generation,
- shows one selected 20-second session window at a time,
- displays seven backend-generated images per window:
  - CH2 waveform comparison
  - CH3 waveform comparison
  - CH4 waveform comparison
  - frontal plane
  - transverse plane
  - sagittal plane
  - 3D VCG-style plot

Important detail: the frontend only loads precomputed PNGs. Plot generation is done in `backend/app.py`.

### `/session`

Live session dashboard.

What it does:

- polls `GET /session/live/visual`,
- listens to `GET /session/live/events` via SSE,
- displays buffered CH2/CH3/CH4 live preview traces,
- is intended for live session sanity-checking rather than post-run review.

## Backend endpoints used

Static review page:

- `GET /review_static/{record_id}/manifest`
- `POST /review_static/{record_id}/process`
- `GET /review_static/process/{job_id}`
- `GET /review_static/{record_id}/image`

Live page:

- `GET /session/live/visual`
- `GET /session/live/events`

## Current behavior notes

- The static review page now uses backend-generated manifest + image caching rather than frontend plotting.
- Window switching is expected to be fast only after the images have been generated and fetched.
- The live page is a preview dashboard, not the full analytical review path.

## Files to know

- `src/App.tsx` - both the static review page and live page live here
- `src/index.css` - all styling
- `vite.config.ts` - backend proxy configuration

## Typical operator workflow

1. start the backend,
2. open the review web,
3. paste a valid `ecg_recordings.id`,
4. click `Load` if artifacts already exist,
5. click `Generate` if the static review manifest does not yet exist,
6. browse windows with the slider once generation is complete.
