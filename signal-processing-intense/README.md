# Signal Processing Workspace

This folder contains the notebooks and generated artifacts used to develop, validate, and present the ECG morphology workflow.

This is not the deployed runtime path. It is the offline analysis workspace.

## What this folder is for

The notebooks here were used to:

- decode captured binary files,
- inspect raw and cleaned ECG windows,
- derive CH4-anchored segmentation boundaries,
- compute representative mean beats for CH2/CH3/CH4,
- build 2D and 3D vectorcardiography-style views,
- compute calibration baselines and per-window deltas,
- export presentation graphics and per-window plot assets.

The final static-review implementation in `backend/app.py` is derived from this work, especially from `average-beat.ipynb`.

## Main notebooks

### `average-beat.ipynb`

This is the final notebook to read first. It contains the later-stage workflow for:

- 20-second window processing,
- mean-beat extraction,
- calibration baseline construction,
- session window analysis,
- delta computation,
- trend plots,
- saved pickle / JSON / CSV artifacts,
- presentation-oriented figures and narrative.

### `step-by-step-signal-processing.ipynb`

This is the more granular exploratory notebook for beat extraction and channel-by-channel candidate validation before the workflow was consolidated.

### `plot.ipynb`

This notebook reads saved mean-beat pickle data and exports low-size per-window PNG overlays into `plots/`.

## Data and generated artifacts

Inputs:

- `calibration_05Apr26_0432H.bin`
- `session_05Apr26_0459H.bin`

Generated artifacts:

- `session_mean_beats_*.pkl` - saved per-window mean beat arrays
- `session_window_metrics_*.json` - saved per-window metrics and deltas from calibration
- `calibration_mean_beats_*.csv` - calibration representative beat exports
- `plots/...` - exported PNG comparisons by session window

## Relationship to runtime code

The backend static review path mirrors this notebook workflow in code. In particular:

- segmentation is anchored on CH4,
- windows are 20 seconds,
- CH2/CH3/CH4 mean beats are computed from shared CH4-derived boundaries,
- beat outliers are rejected before averaging,
- comparison plots are generated from calibration vs session mean beats.

That logic now lives in `backend/app.py`, not in the notebooks themselves.

## Reproducing the notebook work

Open the notebooks in Jupyter using the Python environment that has:

- `neurokit2`
- `numpy`
- `pandas`
- `matplotlib`
- any notebook tooling you prefer

The notebooks expect the example `.bin` files in this folder to exist locally.

## Use this folder for

- method explanation,
- algorithm traceability,
- reproducing figures used in presentations or reports,
- validating backend logic against the original exploratory workflow.

Do not treat this folder as production application code.
