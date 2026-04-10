# Showcase Display

Standalone exhibition display for the ECG hardware.

## What it does
- Serves a single full-screen page from a local Python backend.
- Connects to the ECG hardware in the browser using Web Bluetooth.
- Decodes the live 231-byte ECG packets locally.
- Displays only CH2 as a rolling live waveform.
- Keeps a rolling local CSV capped at the latest 5000 samples.
- Clears the CSV and frontend buffer when Bluetooth disconnects.

## Run
From the repository root:

```powershell
python showcase_display/backend/app.py
```

Then open:

```text
http://127.0.0.1:8020
```

Use Chrome or Edge. Web Bluetooth requires a secure context such as `localhost` or `127.0.0.1`.

## Display behavior
- Rolling buffer: 5000 samples
- Visible chart window: 2500 samples
- Display delay: 500 samples behind the latest received data
- Cleaning scope: the full rolling 5000-sample CH2 buffer is cleaned before plotting, then the latest eligible 2500 samples are shown
- CSV persistence cadence: every 500 received samples

## Output
The active rolling CSV is stored at:

```text
showcase_display/data/live_ch2.csv
```
