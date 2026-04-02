# VCG Metrics README

## Purpose

This folder is intended to hold mathematically explicit functions that operate on a cleaned, resampled, beat-segmented 3D cardiac signal.

The target signal model is:

```text
V(t) = [x(t), y(t), z(t)]^T
```

where:

- `x(t)` is the Lead-I-like spatial axis
- `y(t)` is the vertical axis
- `z(t)` is the anterior-posterior axis
- the signal has already been cleaned and resampled to an effective `500 Hz`

This README is the implementation contract for the first four higher-level vectorcardiographic metrics:

1. Spatial QRS-T angle
2. ST injury vector
3. T-wave alternans
4. Loop complexity

The goal is not just to produce numbers, but to define those numbers so they remain:

- mathematically coherent
- reproducible across sessions
- comparable against calibration
- understandable in terms of the underlying electrophysiology


## Signal Assumptions

All four metrics should be computed only after the backend has already done the following:

1. decoded raw packets into `x/y/z` time series
2. estimated effective sampling rate from hardware elapsed-time bytes
3. resampled to `500 Hz`
4. cleaned baseline wander and high-frequency noise
5. segmented beats and identified fiducial landmarks

For each accepted beat, the minimum required fiducials are:

- `QRS_onset`
- `R_peak`
- `J_point`
- `T_peak`
- `T_end`

Optional but useful fiducials:

- `P_onset`
- `P_peak`
- `P_end`
- `Q_peak`
- `S_peak`

If a beat does not have reliable `QRS_onset`, `J_point`, or `T_end`, then some metrics should be marked unavailable rather than estimated loosely.


## Mathematical Notation

Let one beat occupy a closed sample interval:

```text
t in [t0, t1]
```

Let the beat trace in 3D be:

```text
V(t) = [x(t), y(t), z(t)]^T
```

Let the Euclidean norm be:

```text
||V(t)|| = sqrt(x(t)^2 + y(t)^2 + z(t)^2)
```

Let the baseline vector be:

```text
V_base = [x_base, y_base, z_base]^T
```

estimated from an isoelectric interval, typically in the PR segment or another stable pre-QRS window.

For many calculations we use a baseline-corrected vector:

```text
V_corr(t) = V(t) - V_base
```

This is important because several metrics depend on direction and magnitude relative to electrical quiescence, not relative to an arbitrary offset.


## Why 3D Metrics Matter

The cleaned 3D signal is more informative than any single scalar lead because ventricular depolarization and repolarization are vector phenomena. A scalar lead is only a projection of the true electrical trajectory onto one axis. In contrast, the 3D curve:

```text
t -> V(t)
```

captures:

- direction
- magnitude
- temporal evolution
- loop geometry

This matters because:

- QRS reflects the propagation of ventricular depolarization
- ST reflects injury-related displacement from baseline
- T reflects ventricular repolarization
- beat-to-beat variation in those objects can indicate instability, ischemia, or structural heterogeneity


## Shared Preprocessing for Metric Computation

Before computing any of the four metrics, the backend should apply the same structural preparation:

1. Baseline correction
   - Estimate `V_base` from an isoelectric interval.
   - Subtract it from the beat.

2. Beat acceptance
   - Exclude beats with missing fiducials or obvious delineation failure.
   - Exclude beats already flagged by higher-level anomaly filters.

3. Temporal windows
   - QRS window: `QRS_onset` to `J_point`
   - ST window: `J_point` to `J_point + 80 ms`
   - T window: `J_point` or `T_onset` to `T_end`

4. Optional time normalization
   - For beat-to-beat morphology comparison, resample the QRS or T interval to a fixed number of points.
   - This is especially useful for T-wave alternans and loop-complexity comparisons.


## 1. Spatial QRS-T Angle

### Physiologic Idea

The QRS complex and the T wave are the vector expressions of two different ventricular processes:

- QRS: depolarization
- T: repolarization

If those two processes are well aligned spatially, the angle between their representative vectors is relatively small. If repolarization is spatially discordant relative to depolarization, that angle increases.

In broad terms:

- smaller angle: more concordant depolarization-repolarization relation
- larger angle: more abnormal spatial heterogeneity

This metric is attractive because it compresses a complicated 3D trajectory into a geometrically interpretable quantity.


### Mathematical Definition

Choose one representative QRS vector `V_QRS` and one representative T vector `V_T`.

Then define the spatial QRS-T angle as:

```text
theta_QRST = arccos( <V_QRS, V_T> / (||V_QRS|| ||V_T||) )
```

where `<.,.>` is the Euclidean inner product.


### How To Choose `V_QRS` and `V_T`

There are multiple valid choices, but the implementation should pick one and stay consistent.

Recommended first implementation:

- `V_QRS`: the vector at the time of maximal vector magnitude inside the QRS interval
- `V_T`: the vector at the time of maximal vector magnitude inside the T-wave interval

That is:

```text
t_QRS* = argmax_{t in QRS} ||V_corr(t)||
t_T*   = argmax_{t in T}   ||V_corr(t)||

V_QRS = V_corr(t_QRS*)
V_T   = V_corr(t_T*)
```

This choice is practical because it is:

- simple
- stable
- tied to the dominant spatial axis of each interval

Alternative definitions include:

- mean vector over QRS and T intervals
- area-integrated vector over QRS and T intervals

Those may be useful later, but the peak-vector version is the cleanest first implementation.


### Why It Matters

The QRS-T angle is a geometric measure of mismatch between ventricular activation and recovery. Large angular separation implies that the recovery vector is not merely following the same broad spatial organization as the activation vector. That can be associated with:

- ischemic changes
- repolarization abnormalities
- heterogeneous conduction/recovery states
- structural or functional remodeling

In your project, the strongest immediate use is relative rather than absolute:

- compare session beats against calibration baseline
- track drift in the session mean and distribution
- identify subgroups of beats whose angle departs materially from calibration


## 2. ST Injury Vector

### Physiologic Idea

The ST segment is the interval immediately after depolarization, before most visible repolarization unfolds. In injured myocardium, this segment is displaced relative to the isoelectric baseline. In vector form, that displacement becomes a 3D vector:

```text
V_ST(t) = V(t) - V_base
```

within the ST interval.

The term "injury vector" refers to the direction and magnitude of this displacement. In 3D, this is more informative than just saying one scalar lead is elevated or depressed.


### Mathematical Definition

Let `J` be the J-point. For a time offset `tau` in the ST interval:

```text
V_ST(J + tau) = V_corr(J + tau)
```

Two useful derived quantities are:

1. Fixed-time injury vector

```text
V_ST,J60 = V_corr(J + 60 ms)
```

2. Maximal ST injury vector in a clinically relevant early ST window

```text
tau* = argmax_{tau in [0, 80 ms]} ||V_corr(J + tau)||
V_ST,max = V_corr(J + tau*)
```

with scalar magnitude:

```text
M_ST,max = ||V_ST,max||
```


### Why This Definition Is Reasonable

The ST segment is not a single time point. A single `J+60 ms` value is easy to compare across beats, but it may miss the strongest displacement if the morphology is slightly shifted in time. A maximum over `J` to `J+80 ms` is more robust to that variability.

This yields both:

- a reproducible reference point (`J+60`)
- and a morphology-aware extremal quantity (`max in J..J+80`)


### Why It Matters

This metric encodes:

- how far the post-QRS segment has deviated from baseline
- in what spatial direction it has deviated

That makes it useful for:

- ischemia-sensitive monitoring
- comparing calibration vs session post-depolarization geometry
- identifying clusters of beats whose ST geometry deviates from baseline

In your repository, this should likely be reported as:

- vector components `(x, y, z)`
- magnitude
- optional angular coordinates later


## 3. T-Wave Alternans

### Physiologic Idea

T-wave alternans is a beat-to-beat alternation in repolarization morphology, commonly conceptualized as an `ABAB...` pattern. In scalar ECG this is often measured as a change in T-wave amplitude or shape across consecutive beats. In 3D, the more faithful object is the changing repolarization trajectory itself.

Mathematically, this is not just "difference between two beats". The defining feature is alternation parity:

- odd beats behave one way
- even beats behave another way


### Practical First Definition

There are sophisticated spectral methods for TWA, but they require longer stationary sequences, careful pacing assumptions, and noise handling. For your pipeline, the first sensible implementation is a beat-domain alternans measure.

Recommended first implementation:

1. Extract the T-wave interval for each accepted beat.
2. Time-normalize each T-wave interval to a fixed length `N`.
3. Convert to vector magnitude:

```text
T_k(u) = ||V_k(u)||,  u in [0, 1]
```

where `k` indexes beats and `u` is normalized time.

4. Partition beats into odd and even groups.
5. Compute median odd and even T-wave templates:

```text
T_odd(u), T_even(u)
```

6. Define alternans amplitude as:

```text
A_TWA = max_u |T_odd(u) - T_even(u)|
```


### Why This Works

This definition directly asks whether repolarization morphology alternates by beat parity. It is robust because:

- median templates suppress outlier beats
- time normalization reduces duration mismatch
- vector magnitude reduces axis-specific sign ambiguity

Later, if needed, you can extend this to:

- componentwise TWA in `x/y/z`
- full spectral TWA
- alternans energy rather than just peak difference


### Why It Matters

T-wave alternans is a marker of repolarization instability. In a 3D setting, it becomes a property of the repolarization trajectory, not just a scalar bump in one lead.

In your use case, this metric is most meaningful when:

- enough beats exist in a stable window
- heart rate is reasonably stationary
- segmentation is reliable

This is not a single-beat metric in the same way the QRS-T angle is. It is a window metric computed from a set of beats.


## 4. Loop Complexity

### Important Clarification

"Loop complexity" is not a single universally standardized clinical metric. If this project uses that phrase, the implementation must define it explicitly.

The right way to treat it is as a family of geometric descriptors of the 3D trajectory.


### Why Complexity Matters

A perfectly simple loop has:

- a dominant geometric orientation
- limited out-of-plane deviation
- relatively smooth traversal

A more complex loop may have:

- more three-dimensional spread
- less planarity
- more local directional change
- longer path length relative to its spatial extent

This is relevant because more disorganized electrical propagation or recovery can manifest as geometrically more irregular loops.


### Recommended First Definition: PCA-Based Complexity

Take all points in a chosen loop interval, such as the QRS loop or T loop:

```text
{V(t_i)}_{i=1}^n
```

After centering:

```text
W_i = V(t_i) - mean(V)
```

compute the covariance matrix:

```text
C = (1/n) sum_i W_i W_i^T
```

Let the eigenvalues be:

```text
lambda_1 >= lambda_2 >= lambda_3 >= 0
```

These describe how much variance the loop has along its principal axes.


### Derived Descriptors

#### Planarity Ratio

If a loop is mostly planar, then `lambda_3` is small.

Use:

```text
R_planar = lambda_3 / (lambda_1 + lambda_2 + lambda_3)
```

Interpretation:

- small value: loop lies mostly in a plane
- larger value: loop spreads more substantially out of plane


#### Eigenvalue Entropy

Define normalized eigenvalues:

```text
p_i = lambda_i / (lambda_1 + lambda_2 + lambda_3)
```

Then define:

```text
H = -sum_i p_i log(p_i)
```

Interpretation:

- low entropy: one or two dominant axes, simpler geometry
- higher entropy: variance distributed across more axes, more spatial complexity


### Optional Additional Descriptor: Tortuosity

For the ordered loop points, define arc length:

```text
L = sum_{i=1}^{n-1} ||V(t_{i+1}) - V(t_i)||
```

Then define a simple tortuosity-like ratio using the straight-line span:

```text
T = L / ||V(t_n) - V(t_1)||
```

This must be used carefully for closed or nearly closed loops because the endpoint distance can become too small. A more stable alternative is to normalize by a characteristic loop diameter or principal-axis scale.

For that reason, PCA-based descriptors should be the primary implementation, and tortuosity should be secondary.


### Why It Matters

Loop complexity is useful because it captures geometric organization rather than just scalar amplitude or angle. It may reveal:

- loss of planarity
- increased dispersion
- more irregular repolarization or depolarization morphology

For this project, the safest first implementation is not one single "complexity score", but a structured object:

- `planarity_ratio`
- `eigenvalue_entropy`
- optional `tortuosity`


## Recommended Computation Scope

Some metrics are naturally per-beat, while others are better computed over windows.

Per-beat metrics:

- spatial QRS-T angle
- ST injury vector
- loop complexity

Window-level metrics:

- T-wave alternans

This distinction matters because TWA requires comparison across beats, not within one beat alone.


## Calibration vs Session Logic

These metrics should not only be reported in absolute terms. They should also be compared against calibration.

Recommended output structure:

1. Calibration baseline
   - per-beat values
   - mean
   - median
   - standard deviation
   - interquartile range

2. Session values
   - per-beat values
   - rolling window summaries where applicable

3. Deviations
   - session minus calibration mean
   - z-score where distribution is stable
   - percentile relative to calibration

The project value comes from baseline-relative interpretation rather than relying only on generic textbook thresholds.


## Recommended Order of Implementation

Implement in this order:

1. Spatial QRS-T angle
2. ST injury vector
3. Loop complexity
4. T-wave alternans

Why:

- QRS-T angle is clean and low-risk
- ST injury vector is also direct once fiducials exist
- loop complexity is mathematically tractable with PCA
- TWA is the most method-sensitive and should come after the pipeline is stable


## Proposed Return Shape

Each beat-level output can look like:

```json
{
  "beat_index": 42,
  "included": true,
  "spatial_qrst_angle_deg": 67.3,
  "st_injury_vector": {
    "x": 0.12,
    "y": -0.08,
    "z": 0.04,
    "magnitude": 0.149
  },
  "loop_complexity": {
    "planarity_ratio": 0.021,
    "eigenvalue_entropy": 0.41
  }
}
```

For T-wave alternans, a window-level output can look like:

```json
{
  "window_index": 3,
  "beat_start": 81,
  "beat_end": 112,
  "twa_amplitude_mv": 0.018
}
```


## Implementation Boundary

The functions in this folder should remain pure where possible.

That means:

- input: arrays, fiducials, beat metadata
- output: dictionaries or typed objects with computed metrics
- no FastAPI code
- no Supabase code
- no plotting code

The route layer should call these functions after preprocessing has already been completed.


## Open Design Decisions

The following should be decided explicitly before implementation:

1. Whether the representative QRS and T vectors are peak vectors or mean vectors
2. Whether ST injury should prefer `J+60 ms`, `J+80 ms`, or max in `[J, J+80 ms]`
3. Whether TWA version 1 should be vector-magnitude only or componentwise plus magnitude
4. Whether loop complexity should report only PCA descriptors or also tortuosity

Current recommendation:

- QRS-T angle: peak-vector method
- ST injury vector: both `J+60 ms` and `max in J..J+80 ms`
- TWA: vector-magnitude odd/even median method
- loop complexity: PCA descriptors first, tortuosity optional
