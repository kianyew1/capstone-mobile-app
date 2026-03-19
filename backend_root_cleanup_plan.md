# Backend Root-Page Cleanup Plan

## Objective

Remove legacy server-side `"/"` HTML rendering from `backend/app.py` now that `ecg-review-web/` is the dedicated visualization frontend.

The target is **only** code that exists to render the old backend HTML review page. Anything still used by:
- `ecg-review-web/`
- the mobile app in `capstone-ecgapp/`
- live session monitoring
- review JSON/vector endpoints

must stay.

---

## What is currently legacy HTML-page code

### 1. `HTMLResponse` import
- File: `backend/app.py:17`
- This exists only for the legacy `@app.get("/")` route.
- Safe to remove once the root route is deleted or converted to a simple JSON/redirect response.

### 2. Legacy root route
- File: `backend/app.py:2899`
- Route: `@app.get("/", response_class=HTMLResponse)`
- This is the old server-rendered ECG review page.
- It embeds HTML/CSS/JS directly inside Python.
- This is the primary deletion target.

### 3. Inline HTML-generation logic inside `root()`
Inside the root handler there is a large amount of HTML-only code that is not useful once the React frontend owns visualization:
- channel selection and fallback for the page only
- metric formatting helpers defined inside `root()`
- CSV export side effect inside `root()`
- construction of `best_windows_html`, `metrics_table_html`
- serialization of chart arrays into inline JS variables
- the full multiline HTML document returned from Python

This is all removable with the route.

---

## Code that looks related to the root page, but should **not** be removed blindly

These parts are mixed with the old page, but are not automatically safe to delete.

### 1. `_session_analysis_job(...)`
- File: `backend/app.py:2077`
- This currently feeds the legacy root-page cache, **but it is also still used by**:
  - `POST /session_analysis/start` at `backend/app.py:2196`
- Mobile app usage:
  - `capstone-ecgapp/services/session-analysis.ts:12`
  - `capstone-ecgapp/app/run-summary.tsx:119`

So `_session_analysis_job(...)` is **not root-only today**.

What is root-only inside it:
- the part that populates `LAST_ANALYSIS_PLOT`
- the `ecg_plots` base64 plot generation
- the `session_meta` / `calibration_meta` structures for server HTML display

What is not obviously safe to delete yet:
- the job lifecycle itself
- `ANALYSIS_JOBS` if the mobile app still depends on queued status flow

### 2. `ANALYSIS_JOBS`
- File: `backend/app.py:50`
- Not root-only.
- Used by `/session_analysis/start` and `/session_analysis/status/{job_id}`.
- Keep unless the mobile post-run workflow is being removed or replaced.

### 3. Placeholder session analysis endpoints
- `POST /session_analysis`
- `POST /session_find_clean_windows`
- `POST /session_compare_to_calibration`
- `POST /session_metrics`
- `POST /session_insights`

These are not part of the React review frontend, but they are also not part of the `"/"` HTML page itself.

They are probably cleanup candidates later, but **not as part of the root-page deletion unless we confirm they are dead**.

### 4. Matplotlib rendering helpers
- `_render_vector3d_png(...)`
- 3D preload/cache helpers

These must stay.
They render assets for API endpoints consumed by `ecg-review-web/`; they are not part of the old HTML root page.

---

## Safe-to-remove bucket

These are the parts I expect we can remove in the first pass without changing the React frontend or mobile app contracts.

### A. The route itself
- `@app.get("/", response_class=HTMLResponse)`
- entire `root(request: Request) -> str` function

### B. The import only used by that route
- `from fastapi.responses import HTMLResponse`

### C. Root-only inline logic inside that function
All of this disappears automatically when `root()` is deleted:
- `_format_metric(...)`
- `_metrics_html(...)`
- `_format_value(...)`
- `_metrics_table(...)`
- all inline HTML/CSS/JS string assembly
- CSV export triggered from page rendering

### D. `LAST_ANALYSIS_PLOT` fields that are only meaningful for the HTML page
Potentially removable after route deletion:
- `session_meta`
- `calibration_meta`
- `channels`
- `ecg_plots`

But do **not** remove `LAST_ANALYSIS_PLOT` immediately until `_session_analysis_job(...)` is cleaned up.

---

## Remove-after-audit bucket

These should be refactored after the root route is gone, not in the same blind delete.

### 1. Root-only work inside `_session_analysis_job(...)`
Current job does far more than the mobile app needs.
It computes and stores server-page-specific material such as:
- `calibration_plot_b64`
- `window_plot_b64`
- `channel_results[...]`
- `LAST_ANALYSIS_PLOT[...]`

Once the root route is removed, this job should be reduced to one of these:
- truly useful async analysis work for mobile/backend, or
- removed entirely if it is just legacy scaffolding.

### 2. `LAST_ANALYSIS_PLOT`
Once `root()` is deleted and `_session_analysis_job(...)` no longer populates server-rendered page state, this global should likely be deleted entirely.

### 3. Session-analysis job endpoints
Need product decision:
- keep for mobile post-run async processing, or
- replace/remove

Right now they are not tied to the React review UI, but they are still wired into the mobile app.

---

## Keep bucket

These must remain because the new architecture depends on them.

### Review API endpoints used by React
- `GET /review/latest`
- `GET /review/{record_id}`
- `GET /review/{record_id}/session_window`
- `GET /review/{record_id}/vector_beat`
- `GET /review/{record_id}/vector3d_beat`
- `POST /review/{record_id}/vector3d_preload`

### Live monitoring API used by React session page
- `GET /session/live`

### Ingestion / upload / calibration / realtime endpoints
- calibration quality
- session start/upload
- realtime session signal check

### Processed artifact pipeline
- review artifact loading/caching
- Supabase fetch/upload helpers
- vector helpers used by React visualizations

---

## Recommended cleanup sequence

### Phase 1: remove only the old HTML page
1. Delete `HTMLResponse` import.
2. Delete `@app.get("/")` root route entirely.
3. Remove any root-route-only helper code that becomes unreachable.
4. Replace the route with one of these minimal options:
   - `404`
   - simple JSON status endpoint
   - redirect instruction message like `"Use ecg-review-web on port 5173"`

Recommended: return a small JSON status response, not HTML.

### Phase 2: shrink the old analysis job
1. Audit `_session_analysis_job(...)` for outputs that only existed for the deleted root page.
2. Remove:
   - base64 ECG plot generation
   - `LAST_ANALYSIS_PLOT` population
   - per-channel root-page cache structures
3. Keep only behavior still required by mobile/API consumers.

### Phase 3: remove dead globals
After phase 2:
1. delete `LAST_ANALYSIS_PLOT`
2. delete any helper/state only used by the deleted root workflow

### Phase 4: optional second cleanup
Audit whether these are still needed at all:
- `/session_analysis/start`
- `/session_analysis/status/{job_id}`
- placeholder analysis endpoints

This is a separate decision from deleting the old root page.

---

## Risks to avoid

### 1. Do not remove `_session_analysis_job(...)` in the first pass
The mobile app still starts it from `run-summary.tsx`.

### 2. Do not remove review/vector endpoints
Those are now the real frontend contract.

### 3. Do not remove Matplotlib rendering helpers
The React 3D Vectorgraphy view depends on them.

### 4. Do not assume all analysis code is root-only
A lot of it is mixed together. The route is safe to kill first; the analysis job needs a second pass.

---

## Practical first-pass deletion target

If the goal is **safe cleanup with minimal risk**, the first PR should only do this:
- remove `HTMLResponse`
- remove `@app.get("/")`
- remove the entire HTML string and root-only helper logic
- replace `/` with a tiny JSON message or no route at all

Then we do a second PR to simplify `_session_analysis_job(...)` and delete `LAST_ANALYSIS_PLOT`.

---

## My recommendation

Do this as a two-step backend cleanup, not a one-shot deletion.

### Step 1
Delete the legacy root HTML page only.

### Step 2
Refactor the old session-analysis cache/job path after confirming what the mobile app still needs.

That is the cleanest way to avoid breaking the mobile flow while removing the obsolete server-rendered page.
