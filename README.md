# PulseSense Capstone Project

This repository contains the full implementation for the software for PulseSense, including:

- A React Native mobile app for ECG capture and workflow
- A FastAPI backend for signal quality checks and ECG analysis
- A React web review dashboard for session visualization and post-run review

## Project Summary

The project is designed to support end-to-end ECG data collection and analysis:

1. Connect to ECG hardware and capture session data in the mobile app.
2. Validate calibration/session quality through backend analysis endpoints.
3. Upload and process recordings for review and derived metrics.
4. View processed data and vectorcardiography outputs in the review web UI.

## Repository Structure

- capstone-ecgapp: Expo React Native application (mobile + web preview)
- backend: FastAPI analysis service
- ecg-review-web: Vite React web review interface
- docs/plans at repo root: implementation plans and refactor notes used during development

## Tech Stack

- Mobile: Expo, React Native, TypeScript, Expo Router, NativeWind
- Backend: FastAPI, NeuroKit2, Matplotlib, HTTPX, Python 3.12+
- Review Web: React, TypeScript, Vite
- Workspace tooling: npm scripts and concurrently

## Prerequisites

Install these before running locally:

- Node.js 18+ and npm
- Python 3.12+
- Android Studio (for Android builds)
- Xcode (for iOS builds on macOS)

Optional but recommended:

- A Python virtual environment per backend setup below
- Physical device or emulator/simulator for testing mobile flows

## Local Setup

### 1) Mobile App Setup (capstone-ecgapp)

From the repository root:

```bash
cd capstone-ecgapp
npm install
```

Run the app:

```bash
npm run android
# or
npm run ios
# or
npm run web
```

### 2) Backend Setup (backend)

From the repository root:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Run backend locally:

```bash
fastapi dev app.py --host 127.0.0.1 --port 8001
```

Health check:

```bash
curl http://127.0.0.1:8001/health
```

### 3) Review Web Setup (ecg-review-web)

From the repository root:

```bash
cd ecg-review-web
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

## Run Components Together

The root workspace includes combined scripts in package.json.

Install root dependencies once:

```bash
npm install
```

Current combined script:

```bash
npm run dev:review
```

Note: the current backend root script uses a Windows-style Python path (.venv\\Scripts\\python.exe). On macOS/Linux, run backend and review web in separate terminals using the setup commands above unless the script is adjusted.

## Backend API Highlights

Main endpoints implemented in backend/app.py include:

- GET /health
- POST /calibration_signal_quality_check
- POST /session_signal_quality_check
- GET /session/live
- GET /session/live/visual
- POST /session/start
- POST /session/{record_id}/upload
- POST /session_analysis/start
- GET /session_analysis/status/{job_id}
- GET /review/latest
- GET /review/{record_id}
- GET /review/{record_id}/session_window
- GET /review/{record_id}/vector_beat
- GET /review/{record_id}/vector3d_beat
- POST /review/{record_id}/vector3d_preload

## Environment Variables (Backend)

The backend expects Supabase-related environment variables for storage and metadata fetch/upload paths:

- EXPO_PUBLIC_SUPABASE_URL (or SUPABASE_URL)
- EXPO_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY)
- EXPO_PUBLIC_SUPABASE_STORAGE_BUCKET (or SUPABASE_STORAGE_BUCKET)

A BASE_URL value can also be set for server URL behavior; default is http://127.0.0.1:8001.

## Testing

Backend test scaffold exists under backend/tests.

Example:

```bash
cd backend
source .venv/bin/activate
pytest
```

## Capstone Submission Notes

This repository is structured as a monorepo to clearly separate:

- Application interface layer (mobile app)
- Analysis/service layer (FastAPI backend)
- Review and visualization layer (web dashboard)

This separation supports easier demonstration, maintenance, and extension for future research/deployment work.

## Additional Documentation

Useful project docs already included:

- QUICK_START.md
- PROJECT_SETUP_COMPLETE.md
- backend/README.md
- capstone-ecgapp/README_SETUP.md
- setup and refactor plan markdown files at root
