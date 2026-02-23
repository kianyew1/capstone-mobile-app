# Backend Analysis Plan (Draft)

## Verified Data Format (from repo)
- Session and calibration files are uploaded as `.bin` (see `capstone-ecgapp/services/supabase-ecg.ts`).
- Bytes are concatenated BLE packets (`Uint8Array`) with samples stored as **signed int16 little-endian** (see `capstone-ecgapp/services/bluetooth-service.ts` where each sample is encoded into 2 bytes little-endian).
- Default metadata on write: `encoding = int16_le`, `sample_rate_hz = 500`, `channels = 1` (see `capstone-ecgapp/services/supabase-ecg.ts`).
- Storage keys are saved in `public.ecg_recordings` as `session_object_key` and `calibration_object_key` (see `supabase-schema.txt`).

## Proposed Endpoint Inputs (for `/session_analysis`)
- `record_id` OR explicit `session_object_key` + `calibration_object_key`.
- `sample_rate_hz`, `channels` (optional if we fetch from DB).
- `window_seconds` (default 20).
- `top_k` (default 3).
- `overlap_seconds` or `stride_seconds` (optional; default = window length for non-overlap).

## Plan (Stepwise)
1. **Fetch metadata**
   - Read row from `ecg_recordings` using `record_id` (or accept explicit object keys).
   - Use `session_object_key`, `calibration_object_key`, `sample_rate_hz`, `channels`, `encoding`, `byte_length`, `sample_count`.

2. **Download and decode binaries**
   - Fetch both objects from Supabase Storage.
   - Decode `.bin` as signed int16 little-endian.
   - Validate `byte_length % 2 == 0`, `sample_count == byte_length / 2`.

3. **Segment session into windows**
   - Split into `window_seconds * sample_rate_hz` samples.
   - Optionally allow overlap via `stride_seconds`.

4. **Compute signal-quality scores**
   - Placeholder: use a composite score (baseline wander, noise power, peak stability, RR variance, clipping rate, SNR-like proxies).
   - Rank windows and select top 3.

5. **Compute metrics**
   - Calculate metrics for calibration + each selected window (e.g., HR, HRV, RR stats, QRS width, PR, QT if feasible).
   - Compute deltas between calibration and windows.

6. **Return JSON**
   - No raw signal in response.
   - Include window metadata, metrics, comparison deltas, and plot-ready arrays (sample indices, decimated points).

7. **Async execution**
   - Add background task option if processing is > 10s.
   - Return job id + status endpoint if async.

## Questions Needing Your Input
1. **How to identify the record**:
   - Do you want to pass `record_id` only, or always pass both `session_object_key` and `calibration_object_key`?
2. **Windowing rules**:
   - Non-overlapping windows or overlapping? If overlapping, what stride?
3. **Signal-quality scoring**:
   - Any preferred scoring components or thresholds? We can start with a simple composite.
4. **Metric set**:
   - Confirm which metrics are required for the JSON output (HR, HRV, RR variance, PR/QRS/QT, etc.).
5. **Return shape**:
   - Provide a sample JSON schema or indicate required keys for the response.
6. **Async**:
   - Do you want async by default (return job id), or sync until it exceeds N seconds?

If this plan looks right, I will implement step 1-2 first (fetch + decode + validate), then proceed to windowing and scoring.
