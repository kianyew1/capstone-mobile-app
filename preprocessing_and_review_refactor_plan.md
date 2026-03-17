# Preprocessing and Review Refactor Plan

## Goal

Move expensive ECG preprocessing out of the review endpoint path and into a backend preprocessing stage that runs after calibration/session upload. Then refactor the React review UI so session navigation is beat-driven rather than window-driven.

This should solve:

- slow `/review/latest` page loads
- repeated NeuroKit recomputation on every refresh
- repeated warning spam from review-time segmentation/epoch processing
- fragile session 20-second window controls
- missing beat-to-window linkage in the UI

## Current Problems

### 1. Review endpoints are doing too much work

Current `GET /review/latest` / `GET /review/{record_id}` work includes:

- fetch raw calibration `.bin`
- fetch raw session `.bin`
- decode packet stream
- clean signal
- detect R-peaks
- derive beat segments
- delineate beat markers
- compute interval rows

That is too much to do synchronously on page refresh.

### 2. Session UI model is wrong

The current session review card uses two separate navigation concepts:

- selected beat
- selected 20-second window

But the intended behavior is:

- user selects a beat
- backend/frontend determine which 20-second window contains that beat
- session graph shows only that 20-second window
- the selected beat is highlighted on that graph

So the window selector should not be the primary control anymore.

### 3. Warning noise from NeuroKit/Pandas compatibility

The old review path triggered warnings from:

- `epochs_create()`
- pandas Copy-on-Write / `ChainedAssignmentError`
- frequency/nonlinear HRV functions

Those are not useful in the review path and should not be part of every page load.

## Database Tables Already Planned

These two tables are the backend processing index:

### `ecg_processed_records`

One row per uploaded session recording.

Fields:

- `record_id`
- `status`
- `processing_version`
- `updated_at`
- `error_message`

### `ecg_processed_artifacts`

Index of precomputed artifact objects stored in Supabase Storage.

Fields:

- `id`
- `record_id`
- `artifact_type`
- `object_key`
- `updated_at`

## Storage Strategy

Raw `.bin` files remain the source of truth.

Precomputed outputs are stored separately in Storage as JSON artifacts.

Tables only store:

- processing state
- artifact lookup keys

Large arrays should not be stored directly in Postgres columns.

## Artifact Plan

For each `record_id`, preprocess and store per-channel review artifacts.

Recommended artifact types:

- `calibration_review_ch2`
- `calibration_review_ch3`
- `calibration_review_ch4`
- `session_review_ch2`
- `session_review_ch3`
- `session_review_ch4`

Each artifact JSON should contain only what the review UI needs.

## Calibration Artifact Content

For each channel:

- `meta`
  - `object_key`
  - `byte_length`
  - `sample_count`
- `signal`
  - `full`
- `beats`
  - list of beats with:
    - `index`
    - `start_sample`
    - `end_sample`
    - `x`
    - `y`
    - `markers`
- `interval_related`
  - `ECG_Rate_Mean`
  - `HRV_MeanNN`
  - `HRV_SDNN`
  - `HRV_RMSSD`

Calibration stays as a single 20-second full signal.

## Session Artifact Content

For each channel:

- `meta`
  - `object_key`
  - `byte_length`
  - `sample_count`
- `beats`
  - list of beats with:
    - `index`
    - `start_sample`
    - `end_sample`
    - `window_index`
    - `window_start_sample`
    - `window_end_sample`
    - `x`
    - `y`
    - `markers`
- `windows`
  - array of 20-second window descriptors:
    - `window_index`
    - `start_sample`
    - `end_sample`
- `interval_related_rows`
  - one row per 20-second chunk
  - trailing partial chunk included
  - fields:
    - `interval_index`
    - `start_s`
    - `end_s`
    - `sample_count`
    - `ECG_Rate_Mean`
    - `ECG_HRV`
      - `HRV_MeanNN`
      - `HRV_SDNN`
      - `HRV_RMSSD`

Important:

- do **not** store every 20-second window’s full signal inside the artifact if avoidable
- instead store the full cleaned signal once, or store enough data to slice a 20-second window by sample range

Better practical choice:

- store the full cleaned session signal once inside the session artifact
- store beat metadata + interval rows separately in the same JSON
- backend can slice out the requested 20-second window cheaply without rerunning NeuroKit

## Backend Processing Pipeline

### Trigger point

Run preprocessing after successful upload:

- after successful calibration upload
- after successful session upload

This should happen in backend code, not from frontend.

### Processing lifecycle

1. Insert or upsert `ecg_processed_records` with:
   - `status='queued'`
2. Start background preprocessing job
3. Set:
   - `status='processing'`
4. Decode raw `.bin`
5. Clean signal
6. Detect R-peaks
7. Derive beat boundaries
8. Delineate beats
9. Compute interval rows
10. Write JSON artifacts to Storage
11. Upsert `ecg_processed_artifacts`
12. Set:
    - `status='ready'`

If preprocessing fails:

- set `status='error'`
- store `error_message`

## Beat Segmentation Strategy

Do **not** depend on `nk.ecg_segment()` / `epochs_create()` in the hot review path.

Instead:

- use cleaned signal + detected R-peaks
- derive beat boundaries from neighboring R-peaks
- compute each beat segment directly
- run beat-level delineation on those beat segments

This gives:

- deterministic beat start/end sample indices
- cleaner mapping of beat to 20-second window
- fewer pandas/NeuroKit warning issues

Recommended rule:

- beat start = midpoint between previous R and current R
- beat end = midpoint between current R and next R
- for first/last beats, clamp to signal bounds

## Interval Metric Strategy

Use only time-domain metrics in this review/precompute path:

- `ECG_Rate_Mean`
- `HRV_MeanNN`
- `HRV_SDNN`
- `HRV_RMSSD`

Do not use:

- frequency-domain HRV
- nonlinear HRV
- `ecg_intervalrelated()` if it pulls unstable internals for this environment

Instead:

- run `_process_window()` on each 20-second chunk
- extract the needed metrics from the resulting processed info

## Backend Endpoint Refactor

### Keep

- `GET /review/latest`
- `GET /review/{record_id}`

### Change behavior

They should become read-mostly endpoints:

- look up processed artifacts
- if available, serve quickly
- if not ready:
  - return a structured `processing` state

### Add / adjust

#### `GET /review/latest`

Response should include:

- `record_id`
- `channel`
- `processing_status`
- `calibration`
- `session`

For session, this should return:

- the currently requested 20-second window only
- the beat list or selected beat info required by the UI
- interval table metadata

#### `GET /review/{record_id}/session_window`

Keep this session-only fetch path.

It should read precomputed artifact data and return:

- session 20-second window signal
- beat list or selected beat details for that window
- window metadata

No NeuroKit recomputation should happen here.

## React Frontend Refactor

### Current issue

Session graph and controls are currently window-driven.

### New behavior

Beat-driven session navigation.

The selected heartbeat is the primary control.

When heartbeat changes:

1. determine which 20-second window contains that beat
2. display that 20-second window in the session full-signal card
3. display the selected beat on the right
4. highlight the beat segment on the 20-second graph

### UI behavior

#### Calibration section

Keep:

- full 20-second signal on the left
- selected beat graph on the right
- heartbeat input beneath beat graph

Beat chart should show vertical dotted lines for:

- `P`
- `Q`
- `R`
- `S`
- `T`

No vertical lines on the full 20-second calibration graph.

#### Session section

Replace explicit 20-second window control with beat navigation.

Controls:

- heartbeat numeric input
- optional prev/next beat buttons

The left graph shows:

- exactly one 20-second session window
- translucent pastel green overlay on the selected beat region

As selected beat changes:

- if next beat stays in same 20-second window:
  - only overlay moves
- if next beat crosses into next 20-second window:
  - chart switches to next 20-second window
  - overlay appears in new location

The right graph shows:

- the selected beat only
- dotted vertical lines for `P/Q/R/S/T`

### Interval table

Session interval table stays below the session section.

It remains full-session interval data:

- one row per 20-second chunk
- trailing partial chunk included

## Performance Expectations After Refactor

### Refresh/load path

Expected load path after refactor:

1. frontend calls `/review/latest`
2. backend loads artifact metadata
3. backend reads precomputed JSON
4. backend slices requested session 20-second window
5. backend returns response

This should be substantially faster than recomputing all signals/beats/intervals every time.

### Session-only interactions

Changing selected heartbeat should:

- not reload the whole page
- not refetch calibration
- only update session card state / session window payload

## Warning Handling Policy

### Should be eliminated from review-time path

- pandas Copy-on-Write / `ChainedAssignmentError`
- `epochs_create()` warning spam
- `numpy.trapz` errors from frequency HRV
- repeated “too small to be segmented” logs

### Acceptable remaining warnings

Only warnings indicating genuine corrupt or unusable data should remain visible.

## Implementation Order

### Phase 1: Backend preprocessing

1. Add preprocessing service layer
2. Upsert `ecg_processed_records`
3. Generate processed artifact JSON per record/channel
4. Upload artifacts to Storage
5. Upsert `ecg_processed_artifacts`

### Phase 2: Backend read path

1. Refactor `/review/latest`
2. Refactor `/review/{record_id}`
3. Refactor `/review/{record_id}/session_window`
4. Serve processed artifacts instead of recomputing

### Phase 3: React review refactor

1. Make calibration section read-only and stable
2. Make session section beat-driven
3. Add highlighted beat overlay
4. Remove obsolete independent session window control
5. Keep session interval table below

### Phase 4: Cleanup

1. Remove now-unused review-time NeuroKit code paths
2. Remove redundant helpers
3. Update logs and `backend_updates.md`

## Expected Result

After the refactor:

- refresh is faster
- review endpoints are mostly read-only
- expensive processing is done once, after upload
- session graph behavior matches the selected beat
- calibration and session beat charts show full P/Q/R/S/T dotted lines
- warning spam is largely gone from normal review usage
