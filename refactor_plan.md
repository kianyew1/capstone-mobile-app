Refactor plan (Option B, raw-first, end-only processing)

Goals
- Treat packets as 25 samples, not time-based.
- Use hardware-provided elapsed-time values (not BLE timing) to estimate effective sampling rate.
- Store long time-series as blobs in storage; keep DB rows minimal.
- No resampling or cleaning during the session; only at the end.
- `/add_to_session` must be fast and only update live preview and raw storage.
- Improve readability by splitting backend into 3 modules: `supabase.py`, `ui_previews.py`, `app.py`.

Packet format (Option B: append hardware elapsed time)
- Payload length: 231 bytes.
  - STATUS (3 bytes)
  - CH2 (25 * 3 bytes)
  - CH3 (25 * 3 bytes)
  - CH4 (25 * 3 bytes)
  - ELAPSED_TIME_MS (3 bytes)
- The first 3 bytes are the packet status word.
- The next 225 bytes are signal data.
- The final 3 bytes are produced by hardware directly, not inferred from BLE intervals.
- No first-timestamp / last-timestamp delta is needed in the backend.
- Validation constants (single source of truth in mobile + backend):
  - BYTES_PER_SAMPLE = 3
  - SAMPLES_PER_PACKET = 25
  - CHANNELS = 3
  - SIGNAL_BYTES = BYTES_PER_SAMPLE * SAMPLES_PER_PACKET * CHANNELS
  - STATUS_BYTES = 3
  - ELAPSED_TIME_BYTES = 3
  - PACKET_BYTES = SIGNAL_BYTES + STATUS_BYTES + ELAPSED_TIME_BYTES
- Validate payload length and reject anything else.

Effective sampling rate estimation
- Each packet already carries an elapsed-time contribution in milliseconds.
- For any payload:
  - total_elapsed_time_ms = sum(packet_elapsed_time_ms for each packet)
  - total_samples = packet_count * 25
  - effective_sps = total_samples / (total_elapsed_time_ms / 1000)
- Used only for end-of-session resampling.

Calibration flow (send at end only)
- Device collects 10,000 samples (400 packets).
- Mobile sends full raw payload + elapsed-time bytes to `/calibration_completion`.
- Backend pipeline:
  1) Compute effective_sps from total_elapsed_time_ms.
  2) Resample to 500 Hz.
  3) ecg_clean.
  4) ecg_quality (averageQRS).
  5) Persist cleaned signal + metadata + preview artifacts.

Session flow (incremental raw, no cleaning)
- `/add_to_session` called every 20 packets:
  - Accept raw packets + elapsed-time bytes only.
  - Append raw data to storage (no parsing beyond basic validation).
  - Update session metadata (packet_count, cumulative elapsed_time_ms, effective_sps estimate).
  - Trigger refresh_livefeed():
    - Update a rolling preview buffer with last 500 samples.
    - Keep only last 4000 samples (explicit slice).
    - Return preview to live UI.
- `/end_session` called once:
  - Backend:
    1) Load full raw stream from storage.
    2) Compute effective_sps from total_elapsed_time_ms.
    3) Resample to 500 Hz.
    4) ecg_clean.
    5) Generate review artifacts (beats, markers, intervals).
    6) Persist processed artifacts for review UI.

Raw storage strategy (Supabase)
- Long time-series stored as blobs in storage (not DB JSON).
- Avoid assumptions about "append" support:
  - Use chunk objects (e.g., `session/{session_id}/chunks/{chunk_index}.bin`).
  - Maintain a manifest / chunk list in DB.
  - At end, concatenate chunks in order.
- Store elapsed-time bytes alongside samples in the raw blobs (same 231-byte packets).

Live preview storage
- A small DB row or cache for current preview:
  - last 4000 samples per channel
  - latest effective_sps estimate
  - cumulative elapsed_time_ms
- Only for live UI; not used for final processing.

Processed artifacts storage
- Store processed artifacts (cleaned signal, beats, markers, intervals) as storage blobs.
- DB row only keeps metadata: object_key, version, sample_count, timestamps.

Validation and failure handling
- Reject packets with invalid length or non-positive cumulative elapsed time.
- Log packet counts and cumulative elapsed_time_ms for debugging.
- If a chunk upload fails, keep ingesting and mark gap in manifest.

Backend file layout (readability)
- `supabase.py`
  - Supabase config + low-level storage helpers (fetch/upload bytes/json).
  - DB helpers for inserts/updates on recordings, chunks, previews, artifacts.
  - No FastAPI routes here.
- `ui_previews.py`
  - Rolling preview buffer management (append, trim to 4000).
  - Helpers to compute preview response payloads.
  - Pure functions where possible for testability.
- `app.py`
  - FastAPI routes + request parsing/validation.
  - Calls into `supabase.py` and `ui_previews.py`.
  - No raw SQL or storage HTTP inside route bodies.

Phased refactor plan (step-by-step, minimal changes per phase)
Phase 1: Extract storage/DB helpers
- Create `backend/supabase.py`.
- Move Supabase config + storage helpers from `app.py`.
- Keep signatures the same, remove extra fallbacks.
- Add explicit error logs with context (object_key, table, status).

Phase 2: Extract live preview logic
- Create `backend/ui_previews.py`.
- Move rolling buffer and preview shaping helpers.
- Keep preview output identical to current UI expectations.
- Add explicit logs only at callsites (avoid hidden logging in helpers).

Phase 3: Introduce chunked session storage
- Implement chunk key convention: `session/{session_id}/chunks/{chunk_index}.bin`.
- Add `ecg_session_chunks` writes on `/add_to_session`.
- Replace legacy `/session/{record_id}/upload` with `/end_session`.
- Add explicit error logs for missing chunk index or invalid payload length.

Phase 4: End-only processing
- Move heavy processing (resample/clean/artifacts) to `/end_session`.
- Ensure review endpoints read processed artifacts only.
- Keep response shapes unchanged.

Phase 5: Remove redundancy
- Delete legacy code paths that decode full raw blobs on every request.
- Remove fallback paths that reprocess when artifacts are missing; instead log and return a clear error.

Error logging policy
- Prefer explicit, contextual logs (record_id, session_id, chunk_index, object_key).
- Avoid silent fallbacks; fail fast with clear messages.

Non-goals (explicit)
- No resampling during `/add_to_session`.
- No reliance on 50 ms cadence or BLE timings.
- No full-signal JSON stored in DB.

Next step
- Agree on Supabase schema to support:
  - raw chunk storage manifest
  - live preview row
  - processed artifacts metadata

Supabase schema proposal (minimal, debuggable)
- Table: ecg_recordings
  - id uuid pk default gen_random_uuid()
  - user_id text (or uuid) not null
  - session_id text not null (device session identifier)
  - created_at timestamptz default now()
  - calibration_object_key text
  - session_chunks_prefix text (e.g., `session/{session_id}/chunks`)
  - packet_count int default 0
  - sample_count int default 0
  - elapsed_time_ms int
  - effective_sps numeric(10,4)
  - processing_version text
  - status text (e.g., started | ended | processed | error)

- Table: ecg_session_chunks
  - id uuid pk default gen_random_uuid()
  - record_id uuid references ecg_recordings(id) on delete cascade
  - chunk_index int not null
  - object_key text not null (e.g., `session/{session_id}/chunks/{chunk_index}.bin`)
  - byte_length int not null
  - packet_count int not null
  - sample_count int not null
  - elapsed_time_ms int
  - created_at timestamptz default now()
  - unique (record_id, chunk_index)

- Table: ecg_live_preview
  - record_id uuid pk references ecg_recordings(id) on delete cascade
  - ch2_preview float4[] not null
  - ch3_preview float4[] not null
  - ch4_preview float4[] not null
  - sample_count int not null
  - elapsed_time_ms int
  - updated_at timestamptz default now()

- Table: ecg_processed_artifacts
  - id uuid pk default gen_random_uuid()
  - record_id uuid references ecg_recordings(id) on delete cascade
  - artifact_type text not null (e.g., review_ch2, review_ch3, review_ch4)
  - object_key text not null
  - byte_length int
  - sample_count int
  - created_at timestamptz default now()
  - updated_at timestamptz default now()
  - unique (record_id, artifact_type)

Storage conventions
- calibration raw: `calibration/{run_id}.bin`
- session chunks: `session/{session_id}/chunks/{chunk_index}.bin`
- processed artifacts: `processed/{record_id}/{artifact_type}.json`
