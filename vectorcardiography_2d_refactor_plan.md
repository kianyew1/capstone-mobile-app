# 2D Vectorcardiography Refactor Plan

## Goal
Refactor the current `Vectorcardiography` tab into a more explicit `2D Vectorcardiography` tab that shows the three standard planar projections derived from the current vector axes.

## Current State
The current `Vectorcardiography` tab renders:
- one calibration card
- one session card
- each card contains one 2D morphology plot
- the current 2D plot uses:
  - `X = Lead I / CH2`
  - `Y = Lead II / CH3`
- each card also has:
  - beat selector
  - vector movement slider
  - exclusion overlay / status handling
  - PQRST marker dots and labels

The current `3D Vectorgraphy` tab already uses the axis model:
- `X = CH2`
- `Y = CH4`
- `Z = CH3`

That axis model should be treated as the canonical vector basis for the refactor, so the new 2D planes are consistent with the 3D tab.

## Requested End State
Rename the tab to `2D Vectorcardiography` and replace the single 2D morphology graph in each card with three stacked plane views:

1. Frontal plane
   - reconstructed from `X` and `Y`
   - using current axis basis:
     - `X = CH2`
     - `Y = CH4`

2. Transverse (horizontal) plane
   - reconstructed from `X` and `Z`
   - using current axis basis:
     - `X = CH2`
     - `Z = CH3`

3. Sagittal plane
   - reconstructed from `Y` and `Z`
   - using current axis basis:
     - `Y = CH4`
     - `Z = CH3`

The rest of the card behavior stays the same:
- calibration card and session card still appear side by side
- beat selector stays under each card
- movement slider stays under each card
- selected beat drives the plots
- exclusion overlay stays supported

## Interpretation Decisions
These are the implementation assumptions I would use.

### Axis Basis
Use the existing 3D vector basis everywhere in the refactor:
- `X = CH2`
- `Y = CH4`
- `Z = CH3`

This is the cleanest choice because:
- it matches the existing `3D Vectorgraphy` implementation
- it avoids having the 2D and 3D tabs disagree on what the vector axes mean
- it gives the three requested projection planes directly

### What the three planes are
Use these pairings:
- frontal plane = `(X, Y)` = `(CH2, CH4)`
- transverse plane = `(X, Z)` = `(CH2, CH3)`
- sagittal plane = `(Y, Z)` = `(CH4, CH3)`

### Marker behavior
Apply the same marker treatment to all three planes:
- same colored P/Q/R/S/T dots
- same text labels
- same movement slider gating, meaning markers only show once their sample index is inside the revealed portion of the trace

This is implied by your request for the same graph style and labels.

### Exclusion behavior
If a beat is excluded, apply the same overlay behavior to each of the three plane charts.

Practical implementation choice:
- one overlay per chart, same wording
- or one shared overlay wrapper over the whole 3-plot block

Recommended option:
- one shared overlay wrapper over the entire plane stack
- keeps the UI cleaner and avoids repeating the same warning three times

### Scale behavior
Keep the current shared topbar `Y scale (mV)` controls as the fixed axis range for these 2D plane plots as well.

That means:
- the same min/max is used for both axes in each 2D plane
- no additional vector-specific controls are added in this refactor

This matches the current direction of the UI and avoids introducing more controls.

## UI Refactor Plan

### 1. Rename the tab
Change:
- `Vectorcardiography`

To:
- `2D Vectorcardiography`

Update:
- the tab option label in the top-right view selector
- internal mode comparisons in `App.tsx`
- any visible record metadata label that still says `Vectorcardiography`

### 2. Preserve the overall two-card layout
Keep:
- left card = calibration
- right card = session

Each card remains a `review-section` with:
- title
- descriptive subtitle
- large graph area
- selector row beneath

No major layout change is needed at the page level.

### 3. Replace the single 2D graph with a plane stack
Inside each calibration/session vector card:
- replace the current one-graph render with three stacked graph panels
- each panel should look like the current vector morphology plot style:
  - same axis styling
  - same card background
  - same labels and marker treatment
  - same stroke style

Recommended structure inside each card:
- Frontal plane chart
- Transverse plane chart
- Sagittal plane chart
- controls row below the stack

### 4. Plane chart titles
Use explicit chart titles so there is no ambiguity:
- `Frontal Plane (X-Y)`
- `Transverse Plane (X-Z)`
- `Sagittal Plane (Y-Z)`

And use small subtitles or axis labels to show the actual channel mapping:
- `X = CH2, Y = CH4`
- `X = CH2, Z = CH3`
- `Y = CH4, Z = CH3`

### 5. Keep the existing controls unchanged
Do not redesign the controls in this refactor.

Each card should still have:
- beat selector row
- Prev Beat / input / Next Beat
- movement slider

Behavior stays exactly as it is now:
- one selected beat index per card
- one movement percentage per card
- all three plane charts update together from those same controls

## Data/Backend Plan

## 1. Do not introduce a new backend endpoint if not needed
The current `vector_beat` endpoint already returns enough raw data for this refactor:
- `lead_i`
- `lead_ii`
- and internally we already have access to the 3D beat payload builder using:
  - `lead_x`
  - `lead_y`
  - `lead_z`

The cleanest backend change is:
- extend `vector_beat` so the frontend receives all three vector axes for the selected beat

Recommended payload shape change:
- keep backward-compatible fields if convenient
- add:
  - `lead_x`
  - `lead_y`
  - `lead_z`

Where:
- `lead_x = CH2`
- `lead_y = CH4`
- `lead_z = CH3`

This avoids multiple round-trips and keeps the whole 2D tab driven by one fetch per selected beat.

### 2. Keep beat boundaries exactly as they are
No change to segmentation logic.

Continue using:
- CH2-derived beat segmentation and boundaries
- same beat index for calibration/session vector views

This ensures the 2D projections and 3D vectorgraphy remain synchronized.

### 3. Keep the existing exclusion fields
No new exclusion logic is required for this refactor.

Continue returning:
- `exclude_from_analysis`
- `exclusion_reasons`
- `qr_duration_ms`

Frontend can keep using these as it already does.

## Frontend Component Plan

### 1. Refactor the current vector chart into a reusable plane chart
Current component:
- `VectorLoopChart`

Recommended refactor:
- rename the current low-level geometry logic to something axis-agnostic
- create a reusable component that accepts:
  - title
  - x-axis samples
  - y-axis samples
  - x-axis label
  - y-axis label
  - markers
  - movement percent
  - fixed min/max range
  - exclusion state

That reusable plane chart can then be instantiated three times.

### 2. Create a higher-level stacked component
Add a new wrapper component, conceptually something like:
- `VectorPlaneStack`

Responsibilities:
- render the three plane charts in order
- pass the same beat payload to all three
- apply the shared exclusion wrapper if we choose the shared-overlay approach

### 3. Update the existing vector review section
Current:
- `VectorReviewSection` renders one `VectorLoopChart`

Refactor it so it renders:
- one stacked plane block instead of one chart

The rest of `VectorReviewSection` stays the same:
- header text
- controls row
- loading state

## Styling Plan

### 1. Keep the same design language
Preserve the current vector card styling:
- same background treatment
- same rounded card treatment
- same typography system
- same axis/grid styling family

### 2. Add stacked spacing rules
Add CSS for:
- vertical gap between the three plane charts
- consistent axis-label spacing
- responsive height management so the three charts do not become cramped

### 3. Responsive behavior
On narrower widths:
- calibration and session cards can still stack as they do now
- within each card, the three plane plots remain vertically stacked

No special responsive rule beyond that is likely needed.

## Implementation Sequence

### Phase 1: Backend payload extension
1. Extend the vector beat payload to include canonical `X/Y/Z` arrays.
2. Keep existing fields available until frontend is switched.
3. Verify the selected beat fetch still works for both calibration and session.

### Phase 2: Frontend refactor
1. Rename the tab label to `2D Vectorcardiography`.
2. Build a reusable plane chart component using the current vector chart style.
3. Replace the single-chart render with a 3-chart stack in each card.
4. Wire the three planes:
   - frontal `(X, Y)`
   - transverse `(X, Z)`
   - sagittal `(Y, Z)`
5. Keep markers, movement slider, and exclusion behavior intact.

### Phase 3: Verification
Check the following:
- calibration card renders all three planes
- session card renders all three planes
- beat selector updates all three planes at once
- movement slider updates all three planes at once
- PQRST dots appear consistently across all three planes
- exclusion overlay still works correctly
- 3D tab remains unaffected

## Potential Risks

### 1. Marker ambiguity across planes
PQRST marker indices are shared sample positions, which is correct, but some labels may overlap more in certain planes.

Mitigation:
- keep current label placement first
- only add plane-specific label offsets if overlap becomes a real UI problem

### 2. Vertical density
Three stacked charts per card can become visually dense.

Mitigation:
- slightly reduce per-chart padding before reducing the plot area
- keep titles compact

### 3. Payload naming confusion
Current vector payload field names (`lead_i`, `lead_ii`) are tied to the old 2D interpretation.

Mitigation:
- introduce canonical fields (`lead_x`, `lead_y`, `lead_z`)
- treat older names as transitional compatibility only

## What this refactor will achieve
After the refactor:
- the tab will explicitly represent 2D vectorcardiography
- the user will see all three clinically useful 2D projection planes at once
- calibration and session morphology remain directly comparable
- the 2D and 3D vector tabs will finally use the same axis basis

## No open blockers
The request is sufficiently specified to implement.
The only real implementation choice is whether the exclusion overlay is repeated per chart or shared across the whole 3-chart block.

Recommended choice:
- shared overlay for the full stack
- cleaner and less repetitive
