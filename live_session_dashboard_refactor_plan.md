# Live Session Dashboard Refactor Plan

## Objective

Refactor live session viewing into a dedicated buffered realtime dashboard with four synchronized quadrants:
- CH2
- CH3
- CH4
- 3D Vectorcardiography

The display should feel continuous and smooth, while intentionally running about **500 ms behind real time** to provide a buffer for stable animation and consistent UX.

---

## Why the current implementation is insufficient

Current live behavior is snapshot-driven:
- mobile app sends session chunks to backend about every 2 seconds
- backend keeps a rolling in-memory buffer and exposes summary state
- React live page polls backend and redraws snapshots

This is not a good foundation for smooth quadrant animation because:
- network update cadence is too coarse
- frontend is rendering state jumps, not continuous playback
- current 3D vector rendering is image-based, which is too heavy for realtime motion

---

## Target architecture

### Principle
Separate:
- **data acquisition cadence**
- **visual playback cadence**

The backend should provide buffered numeric data.
The frontend should animate inside that buffer smoothly.

---

## Backend refactor

### 1. Keep current ingestion path
Do not replace:
- `POST /session_signal_quality_check`

This remains the write path from the mobile app.
The backend still:
- receives raw chunks
- decodes them
- updates rolling session state
- runs live signal checks

### 2. Add a dedicated live visualization read endpoint
Add a new endpoint for the dashboard, separate from the current live summary route.

Recommended endpoint:
- `GET /session/live/visual`

Recommended query params:
- `record_id`
- optional `window_seconds` (default `8`)

Why a new endpoint:
- current live route is optimized for status summary
- dashboard needs buffered sample arrays
- mixing the two contracts will make both worse

### 3. Backend live visualization response shape
Recommended response:

```json
{
  "record_id": "...",
  "status": "active|ended|missing",
  "updated_at": "...",
  "ended_at": null,
  "sample_rate_hz": 500,
  "window_seconds": 8,
  "delay_ms": 500,
  "samples_per_channel": 4000,
  "quality_percentage": 87.4,
  "signal_ok": true,
  "abnormal_detected": false,
  "reason_codes": [],
  "heart_rate_bpm": 74.2,
  "channels": {
    "CH2": [...],
    "CH3": [...],
    "CH4": [...]
  },
  "markers": {
    "R": [...],
    "P": [...],
    "Q": [...],
    "S": [...],
    "T": [...]
  }
}
```

### 4. Rolling window size
Recommended live visualization buffer:
- `8 seconds` default
- at `500 Hz`, that is `4000` samples/channel

Why:
- enough for a useful scrolling ECG display
- still tractable for transport and rendering

### 5. Channel alignment for vector quadrant
The backend should return synchronized numeric arrays only:
- `CH2` -> vector `x`
- `CH4` -> vector `y`
- `CH3` -> vector `z`

No image generation on the backend for live vector mode.

### 6. Marker policy for live v1
Recommended first pass:
- backend may return markers if already available
- frontend does **not** need to render live PQRST overlays initially

Reason:
- keeps live view readable
- avoids extra rendering complexity in phase 1

### 7. Backend performance notes
- reuse already buffered live session state
- do not recompute full heavy review artifacts
- build response from the latest rolling in-memory data only
- return numeric arrays, not derived plots/images

---

## Frontend refactor

### 1. Create a dedicated live dashboard view
This should be distinct from the current static review page.

Layout:
- top-left: CH2
- top-right: CH3
- bottom-left: CH4
- bottom-right: 3D Vectorcardiography

### 2. Shared buffered playback model
Introduce a dedicated frontend live playback store/state.

The store should hold:
- latest fetched backend buffer
- sample rate
- fetch timestamp
- playback cursor position
- configured display lag (`500 ms`)
- configured visible window (`8 s`)

All four quadrants must read from the same playback cursor so they remain synchronized.

### 3. Fetch cadence vs render cadence
Recommended:
- fetch live visualization data every `500 ms` or `1000 ms`
- animate using `requestAnimationFrame`

This means:
- backend snapshots arrive periodically
- frontend smoothly advances a delayed display cursor between snapshots

### 4. Intentional display delay
Target:
- live page renders approximately `500 ms` behind newest backend data

Why:
- absorbs irregular chunk arrival
- avoids jumpy updates
- makes animation feel continuous

### 5. Signal chart renderer choice
Use canvas-based rendering for live CH2/CH3/CH4.

Do **not** use SVG for this page.

Why:
- canvas is more suitable for high-frequency redraws
- three simultaneous scrolling waveforms are expensive in SVG
- the page is a dashboard, not a document view

### 6. Chart behavior for CH2/CH3/CH4
Each chart should:
- use fixed ECG y-scale
- scroll left-to-right or right-to-left consistently
- show the same visible duration (`8 s`)
- optionally show a subtle “now” line representing playback cursor
- remain synchronized to the same delayed cursor

### 7. 3D Vector quadrant renderer choice
Do not use backend-rendered Matplotlib images here.

Use client-side rendering.

Recommended first implementation:
- a fixed-camera 3D projection rendered in canvas
- no interactive rotation initially
- path built from synchronized buffered samples:
  - `x = CH2`
  - `y = CH4`
  - `z = CH3`

This keeps the live 3D view lightweight and synchronized.

### 8. 3D vector behavior
- same `500 ms` delayed playback cursor as the channel charts
- same shared time window
- render trailing path segment from the current buffer
- fixed axis limits from current frontend ECG scale controls or dedicated live defaults

### 9. Status strip
Optional but recommended:
- place above the quadrant grid
- show:
  - connection/session status
  - quality percentage
  - signal_ok
  - abnormal_detected
  - heart_rate_bpm
  - updated_at

This should be lightweight and not dominate the page.

---

## Rendering strategy

### Visual model
The frontend should behave like buffered playback, not raw socket replay.

At any time:
- newest fetched backend sample = `T_now`
- displayed cursor = `T_now - 500 ms`

When a new backend snapshot arrives:
- merge or replace the local rolling buffer
- continue animating smoothly through it

### If data arrives late
Frontend should:
- hold cursor briefly or slow playback slightly
- never jump aggressively if avoidable

### If data arrives early
Frontend should:
- keep the 500 ms lag target
- not try to display newest samples immediately

---

## API and state flow

### Backend write path
- mobile app -> `POST /session_signal_quality_check`

### Backend read path for live dashboard
- React live page -> `GET /session/live/visual`

### Frontend runtime flow
1. live page starts
2. fetch first rolling snapshot
3. initialize shared playback store
4. start animation loop
5. periodically fetch new snapshot
6. update buffered data
7. all four quadrants render from shared delayed playback cursor

---

## What should not be reused from the current implementation

### 1. Do not use backend Matplotlib PNG generation for live 3D
That is acceptable for per-beat review, but not for smooth realtime animation.

### 2. Do not use snapshot-only polling as the visual model
It causes visible stepping.

### 3. Do not make each quadrant fetch independently
All quadrants must derive from one shared snapshot to stay synchronized.

---

## Phased implementation order

### Phase 1: backend live visualization payload
1. add `GET /session/live/visual`
2. return rolling numeric buffers for CH2/CH3/CH4
3. return summary status fields
4. verify payload size and cadence

### Phase 2: frontend live dashboard shell
1. add dedicated live dashboard route/view
2. build 4-quadrant layout
3. add top status strip
4. wire fetch loop to new endpoint

### Phase 3: shared playback buffer
1. create live playback store
2. implement `500 ms` lag logic
3. implement animation loop with `requestAnimationFrame`

### Phase 4: channel chart rendering
1. build canvas renderers for CH2/CH3/CH4
2. fixed ECG axes
3. synchronized scrolling window

### Phase 5: live 3D vector renderer
1. implement client-side fixed-camera 3D projection in canvas
2. render buffered path from CH2/CH4/CH3
3. synchronize to shared playback cursor

### Phase 6: refinement
1. loading/empty/ended states
2. frame-rate tuning
3. payload-size tuning if needed
4. optional markers or cursor line

---

## Risks and tradeoffs

### 1. Payload size
At 500 Hz and 8 seconds across 3 channels, payloads are not tiny.

Mitigation:
- keep window modest
- avoid redundant fields
- only add marker arrays if actually needed

### 2. Browser rendering cost
Three live ECG traces plus one live 3D panel can be expensive.

Mitigation:
- canvas-based rendering
- shared state
- avoid excessive React re-renders

### 3. Synchronization drift
If each quadrant manages time independently, visuals will drift.

Mitigation:
- one shared playback cursor only

### 4. Overengineering the first pass
Avoid adding rotation, marker overlays, and complex controls initially.

Recommended first pass:
- smooth synchronized motion
- fixed camera
- fixed scales
- status strip

---

## Recommended defaults

- visible signal window: `8 s`
- display lag: `500 ms`
- backend fetch cadence: `500 ms` initially
- rendering: canvas for all four quadrants
- vector mapping:
  - `CH2 -> X`
  - `CH4 -> Y`
  - `CH3 -> Z`
- live 3D camera: fixed
- live marker overlay: off in v1

---

## Outcome after refactor

You will have a dedicated live dashboard where:
- all four views are synchronized
- motion feels continuous rather than chunked
- the UX is stable because playback is buffered
- the backend remains the source of truth for live decoded data
- the frontend is responsible for smooth visual playback
