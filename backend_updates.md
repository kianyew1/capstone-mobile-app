# Backend Updates

## Implemented

### 2026-03-09

- Added backend Supabase helper utilities in `backend/app.py` for:
  - storage upload
  - row insert
  - row update
- Expanded `POST /calibration_signal_quality_check` so it now:
  - accepts raw concatenated ECG packet bytes
  - decodes packets on the backend
  - uploads calibration `.bin` to Supabase Storage
  - returns `quality_percentage`, `signal_suitable`, `calibration_object_key`
  - returns preview series for `CH2`, `CH3`, `CH4`
- Added backend session storage endpoints:
  - `POST /session/start`
  - `POST /session/{record_id}/upload`
- Removed CSV from the active backend plan. `POST /calibration_channels_csv` has been removed.
- Switched frontend calibration flow to:
  - send raw packet bytes to `POST /calibration_signal_quality_check`
  - use backend-returned preview for `CH2`, `CH3`, `CH4`
  - store `calibrationObjectKey` from backend response for later session use
- Switched frontend session flow to:
  - call backend `POST /session/start`
  - call backend `POST /session/{record_id}/upload`
- Removed active frontend direct-Supabase and CSV code:
  - deleted `services/supabase-ecg.ts`
  - deleted `services/calibration-csv.ts`
- Removed active frontend ECG decoding helpers from `services/ecg-utils.ts`
- Removed redundant frontend local-raw preview persistence:
  - deleted `services/ecg-storage.ts`
  - removed calibration-screen writes to local SQLite that were only supporting old frontend preview reconstruction
- Removed redundant session-store decoded packet buffers that were no longer used by the raw-packet upload flow

### 2026-03-10

- Updated mock mode to emit firmware-compatible raw ECG packets from `capstone-ecgapp/services/bluetooth-service.ts`:
  - 228 bytes per packet
  - 24-bit signed big-endian layout
  - 1 status value + 25 samples each for `CH2`, `CH3`, `CH4`
- Switched mock-mode enablement in `capstone-ecgapp/config/mock-config.ts` to respect `EXPO_PUBLIC_MOCK_MODE=TRUE|DEV|PROD`
- Aligned mock calibration timing with real capture:
  - 1 packet per 50 ms tick
  - target remains 400 packets / 10000 samples per channel
  - added mock stream timing logs for validation
- Replaced calibration quality heuristics with backend NeuroKit2 processing on `CH2`:
  - `POST /calibration_signal_quality_check` now decodes raw packet bytes on the backend
  - computes quality from NeuroKit2 processing
  - returns cleaned preview series for `CH2`, `CH3`, `CH4`
  - logs request stats and response summary on the backend
  - only uploads calibration storage objects when `signal_suitable=true`
- Reworked `POST /session_signal_quality_check` into the realtime session-monitoring endpoint:
  - accepts raw packet chunks from the frontend
  - keeps a rolling backend buffer per active session
  - analyzes `CH2` with NeuroKit2
  - returns compact status fields such as `signal_ok`, `abnormal_detected`, `reason_codes`, `heart_rate_bpm`
  - logs request stats and response summary on the backend
- Wired the frontend session flow to send raw packet chunks to `POST /session_signal_quality_check` every 2 seconds during a running session
- Added frontend logging for:
  - calibration quality request/response
  - session start/upload request/response
  - realtime session signal-check request/response
- Reintroduced frontend SQLite only for durable session raw-packet storage:
  - raw session packets are appended to SQLite during capture
  - run-summary loads the authoritative full session bytes from SQLite for final upload
  - SQLite session packets are cleared after successful upload

### 2026-03-17

- Added review API endpoints in `backend/app.py`:
  - `GET /review/latest?channel=CH2`
  - `GET /review/{record_id}?channel=CH2`
- Added backend review payload generation for:
  - selected channel full cleaned signal
  - segmented heartbeats
  - beat-level delineation markers
  - calibration interval-related summary
  - session interval-related rows, including the trailing partial interval
- Scaffolded a separate Vite + React + TypeScript review frontend in `ecg-review-web/`
- Added a root workspace `package.json` with a single combined dev command:
  - `npm run dev:review`
- Added live session snapshot support in `backend/app.py`:
  - `POST /session_signal_quality_check` now stores the latest rolling CH2 snapshot per `record_id`
  - snapshot includes cleaned signal, P/Q/R/S/T peak markers, interval metrics, and abnormality status
  - `GET /session/live?record_id=...` serves the latest stored live snapshot
  - session lifecycle is now explicit:
    - session start initializes an active live state
    - session upload marks the live state as ended while keeping the final snapshot available
- Added a React live session page at `/session` in `ecg-review-web/`:
  - polls `/api/session/live` every 2 seconds
  - renders the rolling CH2 buffer with P/Q/R/S/T peak markers
  - shows live quality, status flags, and interval metrics in a right-side panel
  - supports an optional `recordId` query parameter, falling back to the latest active session snapshot
  - stops polling once the backend reports the session has ended
  - renders P/Q/R/S/T delineation as dotted vertical marker lines
- Updated the stored review flow so the session signal is loaded as a selected 20-second window instead of the full session trace:
  - `GET /review/latest` and `GET /review/{record_id}` now accept `session_window_index`
  - added `GET /review/{record_id}/session_window` so the frontend can refresh only the session review section
  - the backend returns only the selected session window signal/beat data, plus window navigation metadata
  - the React review page now provides prev/next and numeric window controls beneath the session chart
  - changing the session window now updates only the session card rather than reloading the whole review page
- Hardened backend NeuroKit handling to reduce log flooding:
  - too-short segmented beats are skipped quietly instead of emitting repeated delineation warnings
  - interval-related metrics are now derived from backend time-domain processing rather than `ecg_intervalrelated()` / `epochs_create()`
  - this avoids the previous `numpy.trapz`, chained-assignment, and empty-slice error spam on short/noisy windows
- Added processed-review artifact support:
  - `session_upload` now precomputes per-channel review artifacts and indexes them in `ecg_processed_records` / `ecg_processed_artifacts`
  - review endpoints now load precomputed artifacts from Storage instead of recomputing the full NeuroKit pipeline on each refresh
  - artifacts are versioned via `REVIEW_PROCESSING_VERSION`
- Refactored the React review UI to be beat-driven for session navigation:
  - the full session signal is no longer refetched per 20-second window
  - selecting a session heartbeat now determines the displayed 20-second window locally
  - the selected beat is highlighted with a translucent green overlay on the 20-second session graph
  - calibration remains a full 20-second signal with separate beat selection
- Beat markers on review beat charts now come from full-signal delineation mapped into each beat segment:
  - P/Q/R/S/T should now appear on individual heartbeat graphs when delineation exists
  - review artifact version bumped to force regeneration of older cached artifacts
- Review load path optimized:
  - processed review artifacts are now cached in backend memory after first load
  - review beat payloads no longer store duplicated per-beat waveform arrays; frontend reconstructs the selected beat from the full cleaned signal
  - review artifact version bumped again so leaner artifacts replace older large ones
- HRV removed from the active review/live interval pipeline:
  - backend no longer calls `nk.hrv_time(...)` for review interval summaries
  - interval payloads now carry only `ECG_Rate_Mean`
  - React review cards now display only heart rate for interval-related analysis
- Beat exclusion metadata added to processed review artifacts:
  - beats are flagged `exclude_from_analysis=true` when `Q-R` exceeds `40 ms` at `500 Hz`
  - each beat now stores `exclusion_reasons`, `qr_duration_samples`, and `qr_duration_ms`
  - each section now stores included/excluded beat counts and excluded reason totals
  - React beat charts show a grey overlay when the selected beat is excluded
- Added lightweight vectorcardiography beat visualization:
  - backend endpoint `GET /review/{record_id}/vector_beat` slices Lead I from CH2 and Lead II from CH3 using CH2 beat bounds
  - React review page now shows large calibration/session 2D morphology plots with beat controls on the right
  - vector sections reuse the same beat selectors and exclusion overlay logic

## Next Verification

- Verify backend quality/preview response against a mock calibration run
- Verify realtime session checks return stable status every ~2 seconds in mock mode
- Verify session start/upload rows are written correctly through backend only
- Verify the React review frontend renders `/api/review/latest` correctly for CH2/CH3/CH4
