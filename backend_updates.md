# Backend Updates

## In Progress

### 2026-03-09

- Added backend Supabase helper utilities in [app.py](/C:/src/capstone-ecgapp/backend/app.py) for:
  - storage upload
  - row insert
  - row update
- Expanded `POST /calibration_signal_quality_check` so it now:
  - accepts raw concatenated ECG packet bytes
  - decodes packets on the backend
  - uploads calibration `.bin` to Supabase Storage
  - returns `quality_percentage`, `signal_suitable`, `calibration_object_key`
  - returns preview series for `CH2`, `CH3`, `CH4`
- Added backend session storage endpoints:
  - `POST /session/start`
  - `POST /session/{record_id}/upload`
- Removed CSV from the active backend plan. `POST /calibration_channels_csv` has been removed.
- Switched frontend calibration flow to:
  - send raw packet bytes to `POST /calibration_signal_quality_check`
  - use backend-returned preview for `CH2`, `CH3`, `CH4`
  - store `calibrationObjectKey` from backend response for later session use
- Switched frontend session flow to:
  - call backend `POST /session/start`
  - call backend `POST /session/{record_id}/upload`
- Removed active frontend direct-Supabase and CSV code:
  - deleted `services/supabase-ecg.ts`
  - deleted `services/calibration-csv.ts`
- Removed active frontend ECG decoding helpers from `services/ecg-utils.ts`

## Next

- Verify backend quality/preview response against a real calibration run
- Verify session start/upload rows are written correctly through backend only
- Remove or simplify any remaining frontend code that only existed for local decoded preview reconstruction
