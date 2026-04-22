# Showcase Display

Standalone exhibition display for the ECG hardware.

## What it does
- Serves a single full-screen page from a local Python backend.
- Connects to the ECG hardware in the browser using Web Bluetooth.
- Receives the live 231-byte ECG packets in the browser, then sends packet batches to the local Python backend.
- Decodes and cleans CH2 in the local Python backend.
- Displays only CH2 as a rolling live waveform.
- Uses the latest 3 seconds of raw CH2 standard deviation and absolute mean value to detect whether a participant is touching the electrodes.
- Captures a 20-second CH2 window once contact is detected, then shows raw signal, segmented beats, and mean beat for 8 seconds.
- Keeps a rolling local CSV capped at the latest 5000 samples.
- Clears the CSV and frontend buffer when Bluetooth disconnects.

## Requirements
- Windows laptop with Chrome or Edge.
- Python environment with `neurokit2` available.
- The ECG hardware must advertise the expected BLE service and characteristic UUIDs used in `frontend/app.js`.

## Run
From the repository root:

```powershell
.\showcase_display\run_showcase.ps1
```

Then open:

```text
http://127.0.0.1:8020
```

Use Chrome or Edge. Web Bluetooth requires a secure context such as `localhost` or `127.0.0.1`.

If you prefer to run the backend directly:

```powershell
python showcase_display/backend/app.py
```

## Display behavior
- Rolling buffer: 5000 samples
- Visible chart window: 2500 samples
- Display delay: 500 samples behind the latest received data
- Cleaning scope: the full rolling 5000-sample CH2 buffer is cleaned and clipped to +/-2.0 mV before plotting, then the latest eligible 2500 samples are shown
- CSV persistence cadence: every 500 received samples
- Contact detection: minimum/maximum standard deviation and maximum absolute mean over latest 1500 samples / 3 seconds
- Capture target: selectable 5000 / 7500 / 10000 samples, equivalent to 10 / 15 / 20 seconds
- Result modal duration: 8 seconds

## Exhibition controls
- `Min STD`: rejects signals that are too flat.
- `Max STD`: rejects signals that are too noisy.
- `Max abs mean`: rejects signals whose 3-second raw mean is too far from 0 mV.
- `Graph scale`: adjusts the live chart y-axis from +/-0.10 mV to +/-5.00 mV.
- `Capture length`: selects a 10, 15, or 20 second capture before showing the result modal.

## Output
The active rolling CSV is stored at:

```text
showcase_display/data/live_ch2.csv
```
