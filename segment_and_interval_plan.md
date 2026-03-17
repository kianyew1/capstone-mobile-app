# Segment And Interval Analysis Plan

Date: 2026-03-16

This plan covers the requested changes to the backend-rendered `/` page and the supporting backend analysis pipeline.

Scope:
- remove the current calibration-vs-window metrics table
- remove the current top-windows presentation from the frontend
- add heartbeat segmentation views for calibration and session
- add per-beat delineation plots
- add interval-related analysis for calibration and session
- keep the implementation minimal and centered on the full signal


## 1. Current Baseline

The current backend flow in `backend/app.py` works like this:

1. The latest `ecg_recordings` row is fetched from Supabase when `/` loads.
2. The session and calibration `.bin` objects are downloaded from Supabase Storage.
3. Raw packets are decoded into `CH2`, `CH3`, `CH4`.
4. The current implementation:
   - computes a cleaned calibration segment
   - computes 3 best session windows
   - renders:
     - a full calibration plot
     - a full session plot
     - a calibration-vs-window metrics table
     - top-window plots and nk.ecg_plot outputs

Your requested direction is to stop emphasizing windows for now and instead emphasize:
- the full calibration signal
- the full session signal
- segmented individual beats
- interval-related analysis on 20-second chunks


## 2. Requested End State

The backend-rendered `/` page should show:

1. Calibration section
- left: full 20-second calibration signal graph
- right: one selected heartbeat graph
- below the heartbeat graph: a numeric input to choose which heartbeat to inspect
- below the full calibration graph: interval-related analysis results for calibration

2. Session section
- left: full session signal graph
- right: one selected heartbeat graph
- below the heartbeat graph: a numeric input to choose which heartbeat to inspect
- below the full session graph: interval-related analysis table for 20-second session intervals

3. Removed from frontend presentation
- calibration-vs-window metrics table
- top 3 windows display
- window overlays
- window-specific ECG plots


## 3. Core Technical Direction

The implementation should be backend-first and reuse NeuroKit2 as the single analysis authority.

### 3.1 Signal basis

Use the cleaned single-channel signal as the basis for the new views.

Assumption:
- default analysis channel is `CH2`
- the current multi-channel dropdown and window comparisons are not part of this phase

Reason:
- your request explicitly says to ignore the current window implementation
- you also said to keep it minimal and use the full signal for now

### 3.2 Segmentation

Use NeuroKit2 `ecg_segment()` on the cleaned signal.

Based on the referenced docs:
- `ecg_segment()` takes a cleaned ECG signal and returns a dict of DataFrames, one per heartbeat
- the segmented beats are centered around R-peaks and are suitable for per-beat visualization

### 3.3 Delineation

Use NeuroKit2 `ecg_delineate()` on the cleaned signal / selected beat context to obtain wave landmarks.

Use this output to visualize beat structure:
- P
- Q
- R
- S
- T
- onsets / offsets where available

### 3.4 Interval-related analysis

Use NeuroKit2 `ecg_intervalrelated()` on:
- the full processed calibration DataFrame once
- a dict of 20-second processed session epochs created with `epochs_create()`

Based on the referenced docs:
- `ecg_intervalrelated()` operates on processed ECG DataFrames returned by `ecg_process()`
- `epochs_create()` can split a processed signal DataFrame into separate epochs for repeated interval-related analysis


## 4. Backend Changes

All heavy lifting should happen in `backend/app.py` first, with helper extraction if needed.

### 4.1 Remove obsolete output structures from `/`

Remove the following from the root-rendered page:
- calibration-vs-window metrics table HTML
- best-windows metadata block
- top-window plots
- window overlay controls
- window-related CSV export

This simplifies the page and avoids spending more engineering effort on a path you want to pause.

### 4.2 Introduce a new backend analysis model for `/`

Replace the current “channel + best windows” page model with a “full signal + beats + intervals” model.

Recommended backend structure:

```python
{
  "calibration": {
    "raw_samples": [...],
    "cleaned_samples": [...],
    "signals": <ecg_process dataframe-like output>,
    "info": {...},
    "r_peaks": [...],
    "segments": {
      "1": {...},
      "2": {...},
      ...
    },
    "interval_related": {...}
  },
  "session": {
    "raw_samples": [...],
    "cleaned_samples": [...],
    "signals": <ecg_process dataframe-like output>,
    "info": {...},
    "r_peaks": [...],
    "segments": {
      "1": {...},
      "2": {...},
      ...
    },
    "interval_related_rows": [...]
  }
}
```

This should replace the current `best_windows`-centric structure inside `LAST_ANALYSIS_PLOT`.

### 4.3 Add reusable backend helpers

Add dedicated helpers for the new behavior.

Recommended helpers:

1. `_process_full_signal(samples, sample_rate_hz)`
- input: decoded `CH2` samples
- output:
  - cleaned signal
  - NeuroKit `signals`
  - NeuroKit `info`
  - R-peaks

2. `_segment_heartbeats(cleaned, info, sample_rate_hz)`
- uses `nk.ecg_segment()`
- returns heartbeat dict keyed by beat label or normalized integer index

3. `_build_segment_plot_data(segments, sample_rate_hz)`
- converts segmented DataFrames into frontend-safe arrays
- one payload per heartbeat

4. `_delineate_beat(cleaned, rpeaks, sample_rate_hz, method="dwt")`
- uses `nk.ecg_delineate()`
- returns delineation landmarks suitable for plotting

5. `_build_interval_related_for_calibration(signals_df, sample_rate_hz)`
- uses `nk.ecg_intervalrelated(signals_df, sampling_rate=...)`
- keeps only requested fields

6. `_build_interval_related_for_session(signals_df, sample_rate_hz)`
- splits processed session signal into 20-second epochs
- uses `nk.epochs_create(...)`
- uses `nk.ecg_intervalrelated(epochs, sampling_rate=...)`
- returns one row per 20-second interval


## 5. Calibration Signal Implementation

### 5.1 Processing

For calibration:

1. Decode `CH2`
2. Run `nk.ecg_process(ch2, sampling_rate=500)`
3. Store:
- full cleaned signal
- R-peaks
- full NeuroKit `signals`
- full NeuroKit `info`

### 5.2 Heartbeat segmentation

1. Call `nk.ecg_segment(cleaned, rpeaks=info["ECG_R_Peaks"], sampling_rate=500)`
2. This returns a dict of beat DataFrames
3. Convert each beat into frontend-safe payload:
- x values
- y values
- beat index
- optional beat label

### 5.3 Delineation

For the selected beat display:

Approach:
- use the beat waveform from `ecg_segment()`
- overlay delineation landmarks derived from the parent processed signal or beat-local reconstruction

Pragmatic implementation plan:
1. compute delineation once on the full cleaned signal with `nk.ecg_delineate(...)`
2. for each segmented beat, map the relevant delineation landmarks into beat-local coordinates
3. pass beat-local landmark arrays to frontend plotting

Reason:
- this is more stable than trying to re-run delineation on extremely short beat snippets in isolation

### 5.4 Interval-related analysis for calibration

For calibration, run interval-related analysis once on the full processed calibration signal.

Implementation:
- `interval_df = nk.ecg_intervalrelated(signals_df, sampling_rate=500)`

Returned payload for frontend:
- `ECG_Rate_Mean`
- chosen HRV output field(s), see underspecified section below


## 6. Session Signal Implementation

### 6.1 Processing

For session:

1. Decode `CH2`
2. Run `nk.ecg_process(ch2, sampling_rate=500)`
3. Store:
- full cleaned signal
- R-peaks
- full NeuroKit `signals`
- full NeuroKit `info`

### 6.2 Heartbeat segmentation

Same as calibration:
- `nk.ecg_segment(cleaned, rpeaks=info["ECG_R_Peaks"], sampling_rate=500)`
- build frontend-safe beat payloads

### 6.3 Delineation

Same strategy as calibration:
- delineate once on the full cleaned session signal
- map landmarks into beat-local coordinates for the selected heartbeat view

### 6.4 Interval-related analysis on 20-second session chunks

Implementation plan:

1. Use the full processed session `signals` DataFrame from `nk.ecg_process()`
2. Build epoch boundaries every 20 seconds:
- `event` at sample `0`
- `event` at sample `10000`
- `event` at sample `20000`
- etc.
3. Call:
- `nk.epochs_create(signals_df, events=[...], sampling_rate=500, epochs_start=0, epochs_end=20)`
4. Call:
- `nk.ecg_intervalrelated(epochs, sampling_rate=500)`
5. Convert the resulting DataFrame into a frontend-safe interval table

Policy for trailing remainder:
- drop the final interval if it is shorter than 20 seconds

Reason:
- this matches your request for strict 20-second interval analysis
- it avoids partial-window interpretation ambiguity


## 7. Frontend / HTML Layout Changes For `/`

This is a backend-rendered page, so the “frontend” here means the HTML/CSS/JS emitted by `backend/app.py`.

### 7.1 Global simplification

Remove:
- channel dropdown if we are defaulting to `CH2` only for this phase
- windows section
- calibration-vs-window metrics table
- top-window controls and opacity slider

### 7.2 Calibration section layout

Create a two-column layout:

Left:
- title: `Calibration Signal`
- full 20-second graph

Right:
- title: `Calibration Heartbeat`
- graph of the selected heartbeat
- numeric input beneath:
  - min = 1
  - max = number of segmented beats
  - default = 1

Below the calibration section:
- interval-related info block
- compact two-column or key-value layout

### 7.3 Session section layout

Create a matching two-column layout:

Left:
- title: `Session Signal`
- full session graph

Right:
- title: `Session Heartbeat`
- graph of the selected heartbeat
- numeric input beneath:
  - min = 1
  - max = number of segmented beats
  - default = 1

Below the session section:
- interval-related table
- one row per 20-second interval

### 7.4 Beat graph rendering

Each beat graph should show:
- beat waveform line
- delineation markers on top
- minimal legend or color coding if needed

Recommended marker set:
- R always shown
- P, Q, S, T shown when available

Minimal visual approach:
- one line plot
- colored dots for landmarks
- no excessive controls


## 8. Data Contract For The Page JS

The JS embedded in `/` should receive structured JSON blobs for:

1. full calibration signal
2. full session signal
3. calibration beat dictionary
4. session beat dictionary
5. calibration interval-related summary
6. session interval-related rows

Recommended JSON structure:

```json
{
  "calibration": {
    "signal": [...],
    "beats": [
      {
        "index": 1,
        "x": [...],
        "y": [...],
        "markers": {
          "P": [...],
          "Q": [...],
          "R": [...],
          "S": [...],
          "T": [...]
        }
      }
    ],
    "interval_related": {
      "ECG_Rate_Mean": 0.0,
      "HRV": {}
    }
  },
  "session": {
    "signal": [...],
    "beats": [...],
    "interval_related_rows": [
      {
        "interval_label": "0-20s",
        "ECG_Rate_Mean": 0.0,
        "HRV": {}
      }
    ]
  }
}
```


## 9. Implementation Order

Recommended implementation sequence:

### Phase A: remove obsolete UI/rendering
- remove metrics table
- remove best windows section
- remove top-window graphs and controls

### Phase B: backend full-signal processing
- add reusable helpers for full `CH2` processing
- build calibration/session full-signal outputs

### Phase C: heartbeat segmentation
- add `ecg_segment()` output handling
- serialize beats for frontend

### Phase D: delineation integration
- add full-signal delineation
- map delineation markers into selected beat views

### Phase E: interval-related analysis
- calibration single-run interval-related summary
- session 20-second epochs + interval-related table

### Phase F: HTML/JS rendering
- implement two-column calibration layout
- implement two-column session layout
- implement beat number inputs
- implement beat graph updates without page reload if possible


## 10. Underspecified Points

These points should be confirmed before implementation, because they affect the exact output.

### 10.1 What exactly is `ECG_HRV`?

This is the main underspecified point.

In NeuroKit2 interval-related output, there is not usually one single canonical field literally named `ECG_HRV`.
Instead, `ecg_intervalrelated()` returns:
- `ECG_Rate_Mean`
- plus many HRV-related columns such as `HRV_MeanNN`, `HRV_SDNN`, etc.

You wrote:
- “I just want ECG_Rate_Mean, ECG_HRV from it.”

This needs a precise interpretation.

Recommended options:

Option A:
- use `ECG_Rate_Mean`
- use one HRV summary field, e.g. `HRV_MeanNN`

Option B:
- use `ECG_Rate_Mean`
- use a small HRV subset, e.g. `HRV_MeanNN`, `HRV_SDNN`, `HRV_RMSSD`

Option C:
- create one backend-computed aggregate called `ECG_HRV` from selected HRV metrics

Recommendation:
- choose Option B unless you explicitly want one synthetic `ECG_HRV` scalar

### 10.2 Heartbeat numbering

You asked for a number input to choose the heartbeat.

Assumption:
- use 1-based numbering for display and input

Reason:
- this is more intuitive than 0-based indexing for manual selection

### 10.3 Channel handling

You asked to ignore windows and not show session signals for each channel.

Assumption:
- default the entire page to `CH2`
- remove channel selection from `/` for this phase

If you still want the channel dropdown retained for future use, that should be stated explicitly.

### 10.4 Full-signal delineation vs beat-only delineation

You explicitly requested delineation on each beat.

Assumption:
- only the beat graphs need delineation markers
- the full calibration and full session graphs do not need delineation markers in this phase

### 10.5 Trailing session remainder shorter than 20s

Assumption:
- drop incomplete trailing intervals

Alternative:
- include final partial interval and label it explicitly

The current plan assumes drop.


## 11. Recommended Default Decisions

Unless you change them, this is the recommended implementation contract:

1. Analyze only `CH2`
2. Remove channel dropdown from `/`
3. Remove all window UI from `/`
4. Use 1-based heartbeat indexing
5. Show delineation markers only on beat graphs
6. Drop trailing session chunks shorter than 20 seconds
7. For interval-related output:
   - definitely include `ECG_Rate_Mean`
   - use a small HRV subset instead of inventing a single opaque `ECG_HRV`


## 12. Short Summary

This change is a backend-page simplification, not an expansion:

- less focus on windows
- more focus on:
  - full calibration signal
  - full session signal
  - selected heartbeat inspection
  - delineation on individual beats
  - interval-related summaries on 20-second periods

The cleanest path is:
- remove the current windows/table UI first
- rebuild `/` around `CH2` full-signal processing
- add segmentation + delineation
- then add interval-related analysis blocks

