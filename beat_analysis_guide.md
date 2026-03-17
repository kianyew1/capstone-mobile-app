# Beat Analysis Guide

## Where the beat signals are

The source of truth for beat-level review data is the processed review artifact stored in Supabase Storage.

Per record and per channel, the backend writes:

- `processed/<record_id>/review_ch2.json`
- `processed/<record_id>/review_ch3.json`
- `processed/<record_id>/review_ch4.json`

The pointer to each artifact is indexed in:

- `public.ecg_processed_records`
- `public.ecg_processed_artifacts`

The backend fetch path is implemented in:

- `backend/app.py:_load_review_artifact(...)`

## What is inside each review artifact

Each review artifact contains:

- `record_id`
- `channel`
- `sample_rate_hz`
- `calibration`
- `session`

Each of `calibration` and `session` contains:

- `meta`
- `signal`
- `beats`
- `beat_count_total`
- `beat_count_included`
- `beat_count_excluded`
- `excluded_reason_counts`
- `interval_related`
- `interval_related_rows`

## Where the full signal is

For each section:

- `section.signal.full`

This is the cleaned per-channel signal used by the React review frontend.

Examples:

- `artifact["calibration"]["signal"]["full"]`
- `artifact["session"]["signal"]["full"]`

## Where each beat is

Each beat is stored as metadata, not as a duplicated waveform array.

Per beat:

- `index`
- `start_sample`
- `end_sample`
- `window_index`
- `window_start_sample`
- `window_end_sample`
- `markers`
- `exclude_from_analysis`
- `exclusion_reasons`
- `qr_duration_samples`
- `qr_duration_ms`

Examples:

- `artifact["session"]["beats"]["items"][0]`
- `artifact["calibration"]["beats"]["items"][0]`

## How to reconstruct a beat waveform

Use the full cleaned signal plus the beat sample bounds.

Pseudo-code:

```python
full_signal = artifact["session"]["signal"]["full"]
beat = artifact["session"]["beats"]["items"][0]
beat_signal = full_signal[beat["start_sample"] - 1 : beat["end_sample"]]
```

The React frontend does this in:

- `ecg-review-web/src/App.tsx:getBeatSamples(...)`

## How beat exclusion works

The backend marks a beat as excluded when its `Q -> R` duration is suspiciously long.

Current rule:

- sample rate = `500 Hz`
- `1 sample = 2 ms`
- `MAX_QR_MS = 40`
- if `Q -> R > 20 samples`, the beat is marked:
  - `exclude_from_analysis = true`
  - `exclusion_reasons = ["qr_too_long"]`

This logic is implemented in:

- `backend/app.py:_evaluate_beat_exclusion(...)`

## Which beats should be analyzed

Do not analyze all beats blindly.

Use only beats where:

```python
beat["exclude_from_analysis"] is False
```

This is the intended filtered analysis set.

Examples:

- total session beats: `900`
- included beats: `850`
- excluded beats: `50`

You can read these directly from section aggregates:

- `artifact["session"]["beat_count_total"]`
- `artifact["session"]["beat_count_included"]`
- `artifact["session"]["beat_count_excluded"]`
- `artifact["session"]["excluded_reason_counts"]`

## Recommended downstream analysis flow

1. Load the review artifact for the channel you want.
2. Choose the section:
   - `calibration`
   - `session`
3. Iterate through `section["beats"]["items"]`
4. Keep only beats with:
   - `exclude_from_analysis == False`
5. Reconstruct each beat waveform from `section["signal"]["full"]`
6. Run your beat-level analysis on the filtered set only
7. Compare or aggregate results as needed

## Minimal Python example

```python
import json

with open("review_ch2.json", "r", encoding="utf-8") as handle:
    artifact = json.load(handle)

section = artifact["session"]
full_signal = section["signal"]["full"]

included_beats = []
for beat in section["beats"]["items"]:
    if beat["exclude_from_analysis"]:
        continue
    signal = full_signal[beat["start_sample"] - 1 : beat["end_sample"]]
    included_beats.append(
        {
            "index": beat["index"],
            "signal": signal,
            "markers": beat["markers"],
        }
    )

print("included beats:", len(included_beats))
```

## Practical rule

For later analysis:

- use `session.signal.full` + filtered `session.beats.items`
- use `calibration.signal.full` + filtered `calibration.beats.items`

The beat artifact metadata is the authoritative filter layer.
