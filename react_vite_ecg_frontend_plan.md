# React + FastAPI ECG Review Frontend Plan

Date: 2026-03-17

This plan replaces the earlier backend-rendered `/` direction with a cleaner split:

- FastAPI remains the analysis and data API
- a new Vite + React + TypeScript frontend renders the ECG review UI
- the existing backend HTML in `backend/app.py` is reduced or removed after migration

This document incorporates the clarified requirements:

1. `ecg_intervalrelated()` output should be treated as:
   - `ECG_Rate_Mean`
   - `ECG_HRV` (the HRV-related columns returned in the DataFrame)
2. `/` should have a channel selector
3. delineation markers should appear only on beat plots
4. trailing session intervals shorter than 20s should be kept and analyzed
5. heartbeat numbering is 1-based
6. the rendered review UI should move to React
7. the styling should feel professional and healthcare-oriented


## 1. Goal

The target end state is:

- backend owns all ECG decoding and NeuroKit processing
- frontend is a dedicated React review app
- the review app shows:
  - calibration full signal
  - calibration individual beat viewer
  - calibration interval-related summary
  - session full signal
  - session individual beat viewer
  - session interval-related table across 20-second epochs
  - channel selector for CH2 / CH3 / CH4
- no top-window UI
- no calibration-vs-window metrics table
- no large backend-generated HTML strings in Python


## 2. High-Level Architecture

### 2.1 Backend responsibility

FastAPI should own:

- fetching latest recording
- fetching arbitrary recording by id if needed later
- reading Supabase storage objects
- decoding raw packet bytes into channels
- channel selection
- `ecg_process`
- `ecg_segment`
- `ecg_delineate`
- `epochs_create`
- `ecg_intervalrelated`
- shaping JSON for the frontend

The backend should not try to render HTML for the review app after migration.

### 2.2 Frontend responsibility

The React app should own:

- fetching JSON from backend
- rendering full-signal graphs
- rendering selected beat graphs
- rendering delineation markers on beat graphs
- rendering calibration interval-related summary
- rendering session interval-related table
- channel selection UI
- beat-number input UI

The frontend should not:

- decode packet bytes
- run NeuroKit logic
- compute signal processing outputs


## 3. Recommended Repository Shape

Current repo shape already contains:

- `backend/` or backend files at repo root
- `capstone-ecgapp/` for the mobile app

Recommended addition:

- new web review app folder, e.g.:
  - `ecg-review-web/`

Reason:
- keeps the mobile app isolated
- keeps the review frontend independent from Expo/web constraints
- Vite + React + TS will be simpler than trying to force this into the Expo app


## 4. Final Dev Startup Contract

You asked for one command to spin up both FastAPI and the React frontend.

Recommended final developer command:

```bash
npm run dev:review
```

Recommended implementation:

- add a root `package.json` at repo root if needed
- use `concurrently`
- define a script that starts:
  - FastAPI on port `8001`
  - Vite dev server on port `5173`

Recommended script shape:

```json
{
  "scripts": {
    "dev:review": "concurrently -n backend,web -c blue,green \"cd backend && uvicorn app:app --host 127.0.0.1 --port 8001 --reload\" \"cd ecg-review-web && npm run dev -- --host 127.0.0.1 --port 5173\""
  }
}
```

This is the final one-line command I recommend after implementation.


## 5. Backend API Plan

The current `/` backend page should be replaced by a structured JSON endpoint.

### 5.1 New primary review endpoint

Recommended endpoint:

```text
GET /review/latest?channel=CH2
```

and optionally later:

```text
GET /review/{record_id}?channel=CH2
```

Purpose:
- return one complete JSON payload for the React review screen

### 5.2 Response shape

Recommended response structure:

```json
{
  "record_id": "string",
  "channel": "CH2",
  "sample_rate_hz": 500,
  "calibration": {
    "meta": {
      "object_key": "string",
      "byte_length": 0,
      "sample_count": 0
    },
    "signal": {
      "full": [0.0],
      "r_peaks": [0]
    },
    "beats": {
      "count": 0,
      "items": [
        {
          "index": 1,
          "x": [0.0],
          "y": [0.0],
          "markers": {
            "P": [12],
            "Q": [20],
            "R": [25],
            "S": [28],
            "T": [46],
            "P_Onsets": [],
            "T_Offsets": []
          }
        }
      ]
    },
    "interval_related": {
      "ECG_Rate_Mean": 0.0,
      "ECG_HRV": {
        "HRV_MeanNN": 0.0,
        "HRV_SDNN": 0.0,
        "HRV_RMSSD": 0.0
      }
    }
  },
  "session": {
    "meta": {
      "object_key": "string",
      "byte_length": 0,
      "sample_count": 0
    },
    "signal": {
      "full": [0.0],
      "r_peaks": [0]
    },
    "beats": {
      "count": 0,
      "items": [
        {
          "index": 1,
          "x": [0.0],
          "y": [0.0],
          "markers": {
            "P": [12],
            "Q": [20],
            "R": [25],
            "S": [28],
            "T": [46]
          }
        }
      ]
    },
    "interval_related_rows": [
      {
        "interval_index": 1,
        "start_s": 0.0,
        "end_s": 20.0,
        "sample_count": 10000,
        "ECG_Rate_Mean": 0.0,
        "ECG_HRV": {
          "HRV_MeanNN": 0.0,
          "HRV_SDNN": 0.0,
          "HRV_RMSSD": 0.0
        }
      }
    ]
  }
}
```


## 6. Backend Processing Plan

The backend needs a stable reusable analysis pipeline.

### 6.1 Existing code to reuse

Current useful backend pieces already exist in `backend/app.py`:

- raw packet decoding
- counts-to-mV conversion
- `_process_window(...)`
- `nk.ecg_process(...)`
- `nk.ecg_delineate(...)`
- some HRV extraction

These should be refactored into signal-level helpers rather than window-first helpers.

### 6.2 New reusable helpers

Recommended helpers:

#### A. `_process_full_signal(samples, sample_rate_hz)`

Input:
- one selected channel of decoded samples

Output:
- cleaned signal
- `signals`
- `info`
- R-peaks

Purpose:
- single canonical processing entrypoint for calibration and session

#### B. `_segment_beats(cleaned, info, sample_rate_hz)`

Uses:
- `nk.ecg_segment(cleaned, rpeaks=info["ECG_R_Peaks"], sampling_rate=sample_rate_hz)`

Output:
- heartbeat dict / normalized beat list

#### C. `_delineate_full_signal(cleaned, info, sample_rate_hz)`

Uses:
- `nk.ecg_delineate(cleaned, rpeaks=info["ECG_R_Peaks"], sampling_rate=sample_rate_hz, method="dwt")`

Output:
- landmark arrays in full-signal coordinates

#### D. `_map_delineation_to_beat_segments(...)`

Purpose:
- convert full-signal delineation landmarks into beat-local coordinates for each segmented beat

Reason:
- you only want delineation markers on beat plots
- doing the mapping once centrally is cleaner than trying to re-delineate each tiny beat snippet

#### E. `_interval_related_single(signals_df, sample_rate_hz)`

Uses:
- `nk.ecg_intervalrelated(signals_df, sampling_rate=sample_rate_hz)`

Purpose:
- calibration summary

#### F. `_interval_related_epochs(signals_df, sample_rate_hz, epoch_seconds=20)`

Uses:
- `nk.epochs_create(...)`
- `nk.ecg_intervalrelated(...)`

Purpose:
- session interval table


## 7. Channel Selector Plan

You want `/` to keep a channel selector.

Recommended behavior:

- frontend selector values:
  - `CH2`
  - `CH3`
  - `CH4`
- selector triggers a refetch of the review endpoint:
  - `/review/latest?channel=CH2`
  - `/review/latest?channel=CH3`
  - `/review/latest?channel=CH4`

Reason:
- keeps backend authoritative
- avoids shipping all 3 channel analysis payloads at once if unnecessary
- simplifies memory usage and response size

Alternative:
- backend returns all 3 channel payloads in one response

Recommendation:
- do not do that initially
- fetch per selected channel


## 8. Calibration UI Plan

### 8.1 Layout

Calibration section should be a two-column medical review layout.

Left column:
- card title: `Calibration Signal`
- metadata row:
  - channel
  - duration
  - sample count
  - object key
- full 20-second line chart

Right column:
- card title: `Calibration Heartbeat`
- heartbeat plot
- 1-based numeric input beneath it
- beat counter text:
  - e.g. `Beat 4 of 22`

Below calibration:
- `Interval-Related Analysis`
- compact professional card layout showing:
  - `ECG_Rate_Mean`
  - `ECG_HRV` group

### 8.2 Full-signal graph

Requirements:
- professional healthcare styling
- clear grid
- good contrast
- x-axis in seconds or samples
- no delineation markers here

### 8.3 Beat graph

Requirements:
- show a single selected beat
- overlay delineation markers only here
- marker legend optional but compact


## 9. Session UI Plan

### 9.1 Layout

Same overall two-column structure.

Left column:
- card title: `Session Signal`
- metadata row
- full session graph

Right column:
- card title: `Session Heartbeat`
- selected beat graph
- numeric input beneath it
- beat counter text

Below session:
- `Interval-Related Analysis`
- table where each row is a 20-second interval

### 9.2 Session interval table

Rows:
- interval index
- start time
- end time
- sample count
- `ECG_Rate_Mean`
- HRV columns

Since you clarified that `ECG_HRV` means the HRV metrics, the table needs a practical subset.

Recommended minimal HRV subset:
- `HRV_MeanNN`
- `HRV_SDNN`
- `HRV_RMSSD`

Reason:
- enough signal to be meaningful
- avoids an unreadably wide table

If all HRV columns are kept, the table will become too wide again.


## 10. Handling Trailing Session Intervals

You said to keep the trailing shorter-than-20s intervals and analyze them.

Implementation policy:

- create epochs at 20-second boundaries
- include the final partial epoch
- label it explicitly in the frontend

Example:
- `0–20s`
- `20–40s`
- `40–53.2s`

This should be reflected in:
- backend interval row metadata
- frontend table row labels


## 11. ecg_intervalrelated() Interpretation

You clarified:

- `ECG_Rate_Mean` is the mean heart rate
- `ECG_HRV` is the different HRV metrics

For implementation, this should mean:

### Calibration

Show:
- `ECG_Rate_Mean`
- one grouped `ECG_HRV` section containing selected HRV columns

### Session

For each 20-second interval row, show:
- `ECG_Rate_Mean`
- the same selected HRV columns

Recommended HRV subset for first implementation:
- `HRV_MeanNN`
- `HRV_SDNN`
- `HRV_RMSSD`

This is the most practical translation of your clarification into a usable table.


## 12. React Frontend Plan

### 12.1 Stack

Create:
- `ecg-review-web/`
- Vite
- React
- TypeScript

Recommended additional libs:
- `react-router-dom` only if needed later
- `@tanstack/react-query` for data fetching / cache
- `recharts` or `plotly.js` or `echarts`

Recommendation:
- use `echarts-for-react` or plain `plotly.js`

Reason:
- you need multiple scientific plots with overlays and consistent styling
- this is a better fit than hand-rolled SVG for the review app

### 12.2 Frontend page structure

Recommended React component tree:

- `App`
  - `ReviewHeader`
    - title
    - channel selector
  - `CalibrationSection`
    - `SignalCard`
    - `BeatViewerCard`
    - `CalibrationIntervalCard`
  - `SessionSection`
    - `SignalCard`
    - `BeatViewerCard`
    - `SessionIntervalTable`

Reusable components:
- `SignalLineChart`
- `BeatPlot`
- `BeatIndexControl`
- `MetadataRow`
- `MetricCard`
- `IntervalTable`

### 12.3 State model

Frontend state should be minimal:

- selected channel
- selected calibration beat index
- selected session beat index
- fetched review payload
- loading / error state

No signal processing state should exist in the frontend.


## 13. Styling Direction

You asked for professional healthcare styling.

Recommended visual system:

### Color

- background: soft neutral off-white or pale slate
- cards: white / near-white
- primary accent: deep medical blue
- supportive accent: teal / muted cyan
- warning: restrained amber
- danger: restrained clinical red

Avoid:
- neon colors
- gamer dark theme aesthetic
- overloaded gradients

### Typography

Recommended feel:
- professional, clinical, readable
- system-safe modern sans or a clean medical dashboard feel

### Layout

- spacious card layout
- strong section hierarchy
- subtle separators
- visible gridlines on plots

### Plot styling

- calm line colors
- crisp axes
- clearly visible R-peaks / delineation markers on beat plots
- restrained legend


## 14. Migration Plan

### Phase 1: Backend data contract

1. Add new review endpoint(s):
   - `GET /review/latest?channel=CH2`
   - optional later `GET /review/{record_id}?channel=CH2`
2. Refactor current `/` logic into JSON production helpers
3. Remove dependence on best-window UI data for the main review output

### Phase 2: Signal processing helpers

1. full-signal processing helper
2. segmentation helper
3. delineation mapping helper
4. calibration interval-related helper
5. session interval-related helper

### Phase 3: React frontend scaffold

1. scaffold `ecg-review-web` with Vite + React + TS
2. create API client
3. create channel selector
4. create calibration/session section shells

### Phase 4: Plot rendering

1. full-signal plot
2. beat plot
3. delineation markers on beat plot
4. beat number input handling

### Phase 5: Interval-related UI

1. calibration interval card
2. session interval table
3. trailing partial-interval labeling

### Phase 6: Remove backend HTML UI

1. deprecate large HTML output from `backend/app.py`
2. either:
   - keep `/` as a redirect to the Vite frontend in dev / built frontend in prod
   - or keep `/api/...` on backend and let frontend live on its own port in dev

Recommendation:
- in dev, keep frontend on Vite `5173`
- in production later, serve built frontend as static files from FastAPI if needed


## 15. Single-Command Dev Startup Plan

Final goal:

```bash
npm run dev:review
```

Implementation details:

### At repo root

Add `package.json` with:
- `concurrently`

Scripts:

```json
{
  "scripts": {
    "dev:review": "concurrently -n backend,web -c blue,green \"cd backend && uvicorn app:app --host 127.0.0.1 --port 8001 --reload\" \"cd ecg-review-web && npm run dev -- --host 127.0.0.1 --port 5173\""
  }
}
```

If backend files remain at repo root instead of inside `backend/`, then the script should be adjusted accordingly.

This is the planned single command to launch:
- FastAPI backend
- React review frontend


## 16. Tradeoffs

### Why React here is the correct move

Benefits:
- removes large fragile HTML strings from Python
- cleaner iteration for medical-style UI
- better charting options
- better state management for beat selection
- cleaner long-term maintenance

Cost:
- one more frontend app to maintain

This tradeoff is justified because the current Python-generated HTML is already carrying too much UI complexity.

### Why keep backend authoritative

Benefits:
- one signal-processing truth
- easier consistency across mobile and review UI
- lower risk of mismatched NeuroKit outputs

This should not change.


## 17. Final Recommended Decisions

These are the decisions this plan assumes:

1. React review app lives in a new `ecg-review-web/` folder
2. backend serves data APIs, not heavy HTML
3. channel selector refetches one selected channel at a time
4. beat numbering is 1-based
5. delineation markers appear only on beat plots
6. trailing partial session intervals are included and labeled explicitly
7. `ECG_HRV` is represented in UI as a compact subset of HRV columns, not an opaque single number
8. final dev startup command is `npm run dev:review`


## 18. Remaining Minor Ambiguity

Only one meaningful ambiguity remains:

### Which exact HRV columns should appear under `ECG_HRV`?

Recommended minimal first version:
- `HRV_MeanNN`
- `HRV_SDNN`
- `HRV_RMSSD`

If you want more than these, say so explicitly before implementation.

