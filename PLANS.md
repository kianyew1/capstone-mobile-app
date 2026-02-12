# PLANS.md — ECG Mobile Pipeline (Expo RN) — Codex Phase Plan

This plan is for Codex to implement the mobile “backend” pipeline for **Calibration (Baseline)** and **Run** sessions.

---

## What is SHA-256 and why we use it here?

**SHA-256** is a cryptographic hash function that takes any data (like your raw ECG bytes) and produces a fixed-size **256-bit “fingerprint”** (usually shown as 64 hex characters).

We use SHA-256 in this project to:
- **Verify integrity**: confirm the blob uploaded to Supabase is byte-for-byte identical to what the phone exported.
- **Detect truncation/corruption**: if base64/byte conversions go wrong, the hash will differ.
- **Enable safe retries (idempotency)**: using `session_id + sha256` as an idempotency key lets you retry uploads without creating duplicates.

SHA-256 is **not encryption**—it doesn’t hide the ECG. It only fingerprints it.

---

## Global Design Constraints (apply to all phases)

## Repo Alignment Notes (Expo Router + Current Structure)

Current repo conventions (as scanned):
- Screens + navigation live in `capstone-ecgapp/app/` (Expo Router).
- Shared UI components live in `capstone-ecgapp/components/`.
- Domain logic lives in `capstone-ecgapp/services/`.
- Shared hooks live in `capstone-ecgapp/hooks/`.
- App state is in `capstone-ecgapp/stores/`.
- Types in `capstone-ecgapp/types/`.
- `features-from-other-repo/` is reference code only unless explicitly wired.

Plan placement adjustment (minimal change, no repo restructure):
- Use **services/** for BLE + SQLite + recorder core.
- Use **hooks/** for orchestration state machines (calibration/run).
- Use **components/** for minimal UI widgets (buttons/status).
- Keep `app/` screens thin; they should call hooks and render components.

### Known conflicts to resolve
- **Packet spec mismatch**: PLANS Phase 0 expects 96-byte indications with CRC + seq.  
  Current Xiao nRF52840 firmware in `features-from-other-repo/` emits **20-byte notifications** (10 int16 samples, no seq/CRC).  
  Action: implement a decoder that supports both formats:
  - If 96 bytes with header/CRC present, validate seq + CRC per plan.
  - If 20 bytes, treat as sample-only payload and synthesize seq locally (gap detection disabled for this format).

---

1) **Crash safety**
- Data must be committed incrementally to SQLite in small chunks.
- If the app is killed mid-session, already-written chunks must still be readable.

2) **Chunking**
- Store raw ECG in fixed-duration chunks during recording (default **2 seconds**).
- At end of session, concatenate all chunks into **one long blob** for upload.

3) **No JSON arrays for raw ECG**
- Store raw ECG as **little-endian int16 bytes**, base64-encoded.

4) **Never upload while recording**
- Upload only when the user explicitly ends a session.

5) **Seq-based gap detection**
- Each packet includes `seq`. Maintain `expected_seq` and record `gap_count`.

6) **Policy A**
- Calibration must always occur before a Run.
- Calibration is stored as a **separate session**.

---

## PHASE 0 — Packet + API Contract Baselines (Owner: Human + Codex)

### Context of the user
We now have a concrete BLE packet format and retransmit mechanism. Codex should implement the parsing/validation + gap/retransmit logic **exactly** and wire the rest of the pipeline around it.

### 0A) BLE transport + packet spec (NOW SPECIFIED)

**Transport**
- Use **GATT Indications** (not notifications) on the ECG Data characteristic.
- ATT_MTU = 100.
- Each indication carries a fixed **96-byte value**.

**Packet layout (little-endian)**
- Total: 96 bytes delivered; logical content includes:
  - `header` = 16 bytes
  - `payload` = 12 frames × 6 bytes = 72 bytes
  - `crc32` = 4 bytes
  - (Any remaining bytes in the 96-byte ATT value are reserved/padding; preserve original bytes for retransmit fidelity.)

**Header fields (little-endian)**
- `magic` (u16) = 0xECG1
- `ver` (u8) = 1
- `flags` (u8) (includes `retransmit` bit)
- `seq` (u32) increments every packet
- `t0_ticks` (u32) timestamp of first frame (1 MHz timer)
- `n_frames` (u16) = 12

**Payload**
- `n_frames = 12`
- Each frame is interleaved int16: `[ch2, ch3, ch6]` (3 channels)
- Each frame: 3 × int16 = 6 bytes
- 12 frames = 24 ms of data at 500 Hz
- Expected ~41.7 indications/sec

**CRC32**
- Both sides drop any packet whose CRC32 fails.

**Idempotency + gap handling**
- Maintain `expected_seq` per session.
- Accept only:
  - `seq == expected_seq` → process and increment expected
  - `seq < expected_seq` → duplicate; ignore (idempotency)
  - `seq > expected_seq` → gap detected; request retransmit via Control characteristic and do not advance expected until missing packets received.

**Retransmit protocol**
- Control characteristic supports **Write With Response** command: `CMD_RETX(from_seq,to_seq)`.
- Peripheral keeps ring buffer ≥ 5–10 seconds and retransmits **exact original bytes** with same `seq` and `t0_ticks`, setting `flags.retransmit=1`.

**Lead-aware representation**
- Channel count = 3 (`ch2`, `ch3`, `ch6`). Treat as leads.
- Storage/export must preserve lead metadata: `lead_count=3`, `layout="interleaved"`.
- Internal representation may remain interleaved for storage; decoding to per-lead arrays can be deferred.

### 0B) FastAPI placeholder endpoints (NOW AGREED)
Codex should implement a typed client with these placeholder endpoints (exact auth TBD, but shape is fixed enough to scaffold):

1) Baseline registration
- `POST /baseline-sessions`
  - body: `{ local_session_id, started_at_ms, ended_at_ms, fs, lead_count, layout, gap_count, sha256, storage_key }`
  - returns: `{ baseline_cloud_id, status: "pass"|"fail", reason?: string }`

2) Run registration
- `POST /run-sessions`
  - body: `{ local_session_id, baseline_cloud_id, started_at_ms, ended_at_ms, fs, lead_count, layout, gap_count, sha256, storage_key }`
  - returns: `{ run_cloud_id }`

3) Trigger analysis
- `POST /analysis`
  - body: `{ run_cloud_id, baseline_cloud_id }`
  - returns: `{ job_id }`

4) Poll job
- `GET /analysis/{job_id}`
  - returns: `{ status: "queued"|"running"|"done"|"fail", reason?: string }`

5) Fetch insights
- `GET /run-sessions/{run_cloud_id}/insights`
  - returns: `{ summary, confidence, flags, plot_urls, metrics }`

### Sanity checks before moving on
- Packet parser can validate: magic, ver, n_frames, CRC32.
- Duplicate behavior works: seq < expected is ignored.
- Gap behavior works: seq jumps trigger RETX request.
- Placeholder API client compiles with typed request/response shapes.

### Sanity checks for developer (REAL DATA)
- Settings → Developer → **Run Sanity Checks** uses real BLE data and returns PASS for:
  - "Real: bluetooth powered on"
  - "Real: packets received"
  - "Real: packet format detected"
  - "Phase3: recorder total samples > 0"
  - "Phase3: chunk count matches expected"
  - "Phase4: export sample count matches recorder"
  - "Phase4: export sha256 present"
- Optional hardware check (requires BLE device on):
  - Settings → Developer → **Run Live BLE Check**
  - Expect: packets > 0 and decodeErrors = 0

---

## PHASE 1 — SQLite Foundations (Codex can fully implement)

### Context of the user
User is preparing the local persistence layer so recording is reliable and crash-safe. No cloud calls in this phase.

### 1A) Create SQLite access layer
- Use `expo-sqlite`.
- Provide a single DB module that:
  - opens the database
  - runs migrations
  - exposes helper functions for transactions

### 1B) Scratch tables (raw session storage)
Create tables that support BOTH calibration and run sessions.

**Table: `scratch_session`**
- `session_id TEXT PRIMARY KEY`
- `type TEXT`  ("baseline" | "run")
- `started_at_ms INTEGER`
- `ended_at_ms INTEGER NULL`
- `fs INTEGER` (500)
- `lead_count INTEGER` (placeholder; default 1)
- `layout TEXT` ("unknown" | "interleaved" | "per_lead" etc.)
- `status TEXT` ("recording" | "ended" | "exported" | "failed")
- `gap_count INTEGER DEFAULT 0`

**Table: `scratch_chunk`**
- `session_id TEXT`
- `chunk_index INTEGER`
- `start_ts_ms INTEGER`
- `end_ts_ms INTEGER`
- `sample_count INTEGER`
- `data_b64 TEXT`  (base64 of little-endian int16 bytes)
- `checksum TEXT NULL` (optional per chunk)
- PRIMARY KEY(`session_id`, `chunk_index`)

### 1C) Minimal persistent tables
(History screens are out of scope for now.)

**Table: `active_baseline`**
- `id INTEGER PRIMARY KEY` (always 1 row)
- `baseline_cloud_id TEXT NULL`
- `baseline_local_session_id TEXT NULL`
- `accepted_at_ms INTEGER NULL`

### 1D) DB helper functions
Provide a clean API for:
- create session
- insert chunk
- list chunks ordered
- update gap count
- mark ended
- clear scratch

### Sanity checks & tests (run before Phase 2)
- Start app → DB initializes without errors.
- Insert a dummy `scratch_session` + 2 dummy `scratch_chunk` rows → query back ordered correctly.
- Verify uniqueness: inserting same `(session_id, chunk_index)` twice fails (or replaces only if explicitly coded).
- Kill and relaunch app → rows are still present.

### Sanity checks for developer (REAL DATA)
- Phase1 tests are covered implicitly by real recording + export:
  - Chunk ordering + contiguity validated in export
  - Chunk indices must be contiguous or export fails

---

## PHASE 2 — Encoding + Checksums (Codex can fully implement)

### Context of the user
User is standardizing the raw ECG representation so it can be stored and exported deterministically.

### 2A) Raw encoding format
Implement utilities:
- `int16ToBase64LE(samples: Int16Array): string`
- `base64ToInt16LE(b64: string): Int16Array`
- `concatInt16(arrays: Int16Array[]): Int16Array`

### 2B) SHA-256 checksum
Implement SHA-256 of the **raw bytes** (not of the base64 string).

### Sanity checks & tests (run before Phase 3)
- Roundtrip test: generate random `Int16Array` → encode → decode → identical values.
- Determinism test: same input yields same base64 and same SHA-256.
- Byte-order test: confirm little-endian: values like `0x0102` decode correctly.

### Sanity checks for developer (REAL DATA)
- Phase2 tests are covered by export integrity checks:
  - SHA-256 present
  - Export sample count matches recorder

---

## PHASE 3 — Recorder Core (Codex can fully implement)

### Context of the user
User is building the core recording engine that consumes BLE **indications** (validated packets) and persists chunked data safely.

### 3A) Packet decoding + validation layer (NEW)
Create a strict decoder for the 96-byte indication value:
- Validate header:
  - magic == 0xECG1
  - ver == 1
  - n_frames == 12
- Validate CRC32:
  - compute CRC32 over the correct byte range (header+payload; exclude crc field) and drop on mismatch.
- Output a typed packet object:
  - `seq`, `t0_ticks`, `flags`, `frames` (interleaved int16 values for ch2,ch3,ch6)

### 3B) Seq idempotency + retransmit control (UPDATED)
Maintain `expected_seq` per session.
On each decoded packet:
- If `seq < expected_seq`: duplicate; ignore.
- If `seq == expected_seq`: accept and advance expected.
- If `seq > expected_seq`: gap detected.
  - Increment `gap_count`.
  - Issue `CMD_RETX(from_seq=expected_seq, to_seq=seq-1)` via the Control characteristic (Write With Response).
  - Do not advance expected until missing packets arrive.

Persist `gap_count` in `scratch_session`.

### 3C) ChunkWriter (UPDATED)
ChunkWriter now appends **validated sample frames**.
- Treat samples as interleaved leads `[ch2, ch3, ch6]`.
- Store as little-endian int16 bytes in base64.
- Chunk boundary is time-based:
  - default chunkSeconds = 2
  - 500 Hz × 2s = 1000 frames
  - each frame has 3 int16 → 3000 int16 samples total per chunk (interleaved)

### 3D) State machine (session controller)
Create a controller/hook that manages:
- idle
- calibrating
- running
- stopping
- uploading (placeholder)
- analyzing (placeholder)
- complete
- error

### Sanity checks & tests (run before Phase 4)
- Decoder test:
  - Reject wrong magic/ver/n_frames.
  - Reject CRC32 mismatch.
- Idempotency test:
  - Feed seq 10 then seq 10 again; second is ignored.
- Gap + RETX test:
  - Feed seq 10 then seq 12 → request RETX(11,11), do not advance expected past 10 until seq 11 arrives.
- Throughput test (simulated):
  - Feed ~42 packets/sec for 30 seconds; chunk count matches expected for 2s chunks.
- Crash test:
  - Mid-recording force close; relaunch and verify chunks persisted.

### Sanity checks for developer (REAL DATA)
- Phase3 tests are covered by recorder + export checks during real capture.

---

## PHASE 4 — Calibration Session Flow (Codex can fully implement)

### Context of the user
User presses Calibration, holds still for 20 seconds, then the app finalizes, exports, uploads, and either **passes** or **fails** based on backend cleanliness checks.

### 4A) Start calibration
On button press:
- Assert BLE connected + ECG Data characteristic subscribed via **indications**.
- Assert Control characteristic is writable (Write With Response).
- Create a new local `baseline_session_id`.
- Create `scratch_session` row (`type="baseline"`, `status="recording"`, `fs=500`, `lead_count=3`, `layout="interleaved"`).
- Reset `expected_seq`.
- Start ChunkWriter.
- Start a **20s timer**.

### 4B) End calibration (auto at 20s)
- Stop accepting packets.
- Flush final chunk.
- Mark session ended.
- Export to a single baseline payload.

### 4C) Export baseline payload
- Read all chunks ordered by `chunk_index`.
- Validate chunk contiguity: indices must be `0..N` with no gaps.
- Decode and concatenate to one long interleaved Int16 stream.
- Encode to base64 LE.
- Compute SHA-256 of raw bytes.

Export payload must include:
- local session id
- started_at_ms / ended_at_ms
- fs
- lead_count=3
- layout="interleaved"
- total_frames (optional) / total_samples
- gap_count
- data_b64
- sha256

### 4D) Upload + register baseline immediately
After export:
1) Upload raw blob to Supabase Storage → obtain `storage_key`.
2) Call FastAPI `POST /baseline-sessions`.
3) Handle response:
- If `status="pass"`:
  - set `active_baseline.baseline_cloud_id`
  - clear scratch
- If `status="fail"`:
  - do NOT set active_baseline
  - clear scratch (raw baseline is not needed)
  - transition to “Redo calibration” UI state
  - block Run until pass

### Sanity checks & tests (run before Phase 5)
- Calibration auto-stops at ~20s and exports payload.
- Payload size matches expectation (~20s × 500Hz = 10,000 frames; 3 channels → 30,000 int16 samples).
- Simulate FastAPI baseline response:
  - pass → baseline_cloud_id stored
  - fail → baseline cleared and run remains blocked

### Sanity checks for developer (REAL DATA)
- Phase4 tests rely on a real BLE capture and optional calibration API:
  - "Phase4: calibration API configured" will FAIL until you set `EXPO_PUBLIC_CALIBRATION_API_URL`

---

## PHASE 5 — Run Session Flow (Codex can fully implement)

### Context of the user
User can only start Run after a successful calibration (Policy A). Run stores chunks to SQLite; end-run finalizes, uploads, triggers processing, then returns insights to UI.

### 5A) Start run
Preconditions:
- BLE connected
- `active_baseline.baseline_cloud_id` exists

Start:
- Create `run_session_id`.
- Create `scratch_session` row (`type="run"`, `status="recording"`, `fs=500`, `lead_count=3`, `layout="interleaved"`).
- Reset `expected_seq`.
- Start ChunkWriter.

### 5B) End run
On user stop:
- Stop accepting packets.
- Flush final chunk.
- Mark ended.
- Export to single run payload (same structure as baseline).

### 5C) Upload + register run immediately
After export:
1) Upload raw blob to Supabase Storage → `storage_key`.
2) Call FastAPI `POST /run-sessions` with `baseline_cloud_id`.
3) Trigger analysis `POST /analysis` and poll until done.
4) Fetch insights `GET /run-sessions/{run_cloud_id}/insights`.
5) Clear scratch only when safe.

### Sanity checks & tests (run before Phase 6)
- Attempt to start run without active_baseline → blocked.
- Run export payload created and SHA-256 computed.
- Gap handling triggers RETX requests during run as needed.
- Mocked analysis flow returns insights to UI.

---

## PHASE 6 — Cloud Upload (PARTIALLY BLOCKED)

### Context of the user
User ends calibration/run and expects the app to upload the consolidated blob to Supabase Storage and register a session with FastAPI.

### 6A) Upload raw blob to Supabase Storage
- Upload baseline and run payloads as objects.
- Use stable object keys (Codex may choose naming):
  - `baseline/<baseline_local_session_id>.bin`
  - `run/<run_local_session_id>.bin`

### 6B) Register sessions with FastAPI
Scaffold client calls (names TBD):
- `POST /baseline-sessions` → returns `baseline_cloud_id` and calibration result (pass/fail)
- `POST /run-sessions` (includes baseline_cloud_id + run object reference) → returns `run_cloud_id`

### 6C) Retry behavior
- On failure, allow retry without losing scratch.
- Use idempotency key = `local_session_id + sha256`.

**BLOCKER:** exact endpoints + auth.

### Sanity checks & tests (run before Phase 7)
- With mock server, verify:
  - upload is called only after stop
  - retry does not duplicate sessions
  - baseline fail response triggers redo flow

### Sanity checks for developer
- Settings → Developer → **Run Sanity Checks** returns PASS for:
  - "Phase6: supabase config present (fill missing)" (may FAIL until you set env vars)
- Known gap test (expected FAIL until implemented):
  - "Phase6: upload test pending (implement supabase client)"

---

## PHASE 7 — Trigger Analysis + Poll Insights (BLOCKED)

### Context of the user
After run upload, user waits for processing and then sees results.

Expected flow after run registration:
- `POST /analysis` → returns `job_id`
- `GET /analysis/{job_id}` until complete
- `GET /run-sessions/{run_cloud_id}/insights`

**BLOCKER:** API contract.

### Sanity checks & tests (run before Phase 8)
- With mocked responses, verify poll loop stops and handles failures.

---

## PHASE 8 — Data Clearing Rules (Codex can fully implement)

### Context of the user
Local raw storage must not grow. Scratch is cleared only when it is safe.

### 8A) Scratch clearing
- Clear scratch chunks only when:
  - upload succeeded
  - session registered succeeded
  - (for run) analysis/insights fetch succeeded OR at minimum run_cloud_id is persisted and user can fetch insights later

### 8B) Baseline persistence
After baseline upload + register success AND pass:
- set `active_baseline` row:
  - baseline_cloud_id
  - baseline_local_session_id
  - accepted_at_ms

After baseline fail:
- ensure `active_baseline` is empty

### Sanity checks & tests
- If upload fails: scratch remains.
- If upload succeeds: scratch clears and baseline/run pointers persist.

---

## PHASE 9 — Minimal UI Integration Contracts (Codex must expose)

### Context of the user
Frontend needs a minimal, stable interface to call.

Codex must expose a small interface that the frontend can call:

#### Calibration
- `startCalibration()`
- `getCalibrationStatus()` (elapsed, chunksWritten, gapCount, state)
- `cancelCalibration()`

#### Run
- `startRun()`
- `getRunStatus()`
- `stopRun()`

#### Common
- `getBleStatus()`
- `resetAllScratch()` (debug)

---

## Definition of Done

1) Calibration
- Press calibration start → 20 seconds recorded into SQLite chunks
- End calibration → exported baseline payload created (one blob + sha256)
- Upload scaffold exists; baseline pass/fail handled (fail prompts redo)

2) Run
- Start run only after baseline pass
- Run stores chunks to SQLite
- End run exports single blob payload

3) Robustness
- App crash mid session keeps prior chunks
- Seq gap detection works
- No cloud upload occurs during recording

---

## Notes for Codex
- Do not reorganize the entire repo.
- Keep changes scoped to the ECG feature.
- Avoid editing unrelated navigation.
- Leave TODOs clearly where human input is required (lead processing + API contract).
