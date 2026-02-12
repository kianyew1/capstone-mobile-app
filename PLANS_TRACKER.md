# PLANS_TRACKER.md

This file tracks what has been implemented vs the phase plan in `PLANS.md`.

## Phase 0 — Packet + API Contract Baselines
**Implemented:**
- Packet decoder with CRC32 validation and dual-format support:
  - 96-byte packet with ASCII `ECG1` magic (ver=1, n_frames=12).
  - 20-byte notification fallback (XIAO nRF52840 firmware).
  - File: `capstone-ecgapp/services/ecg-packet.ts`
- Seq tracking helper (accept/duplicate/gap detection).
- Lead boundary stub `postProcessPacketToLeads(...)` with TODO for multi-lead mapping.
- Typed FastAPI client stubs (baseline/run/register/analysis/insights):
  - File: `capstone-ecgapp/services/ecg-api.ts`
- Deterministic test harness for Phase 0:
  - File: `capstone-ecgapp/tests/ecg-test-harness.ts`
- Developer UI hook to run Phase 0 tests:
  - `capstone-ecgapp/app/(tabs)/settings.tsx`
- Live BLE sanity check (hardware required):
  - `capstone-ecgapp/tests/ecg-live-sanity.ts`
  - Button added in Settings Developer section
- Live BLE sanity check now runs bare-minimum flow:
  - Requires existing paired/connected device id (no scan/connect/disconnect).
  - Stops via subscription remove (no cancelTransaction).
- Developer Settings no longer includes Pair/Connect; use the Device card UI instead.
- Reset BLE now only disconnects the current BLE connection without clearing the paired device.
- Device scan now uses `features-from-other-repo/ble-stream/bleService` functions (permissions + scan).
- Device card "Scan for Device" now routes to the onboarding Bluetooth screen (which shows the device list).
- Developer card now uses `useBleStream` to pair/connect by service UUID with auto-connect when Bluetooth turns on.
- Developer card now uses `useBleDevConnect` from `features-from-other-repo` (UI-agnostic hook).
- Auto-reconnect in `useBluetoothService` removed to avoid BLE conflicts.
- `PLANS.md` updated with repo alignment + Phase 0 sanity checklist.

**Follow-up required by you:**
1) Install deps if not already:
   - `cd capstone-ecgapp`
   - `npx expo install expo-sqlite`
   - `npm install`
2) Open app → Settings → Developer → Run Sanity Checks
   - Ensure Phase 0 checks pass.
2b) Optional: Settings → Developer → Run Live BLE Check
   - Requires device already paired/connected
   - Expect packets > 0 and decodeErrors = 0
2c) If Live BLE Check fails, press Reset BLE, reconnect device, then retry.
3) Confirm packet spec details:
   - Magic constant if not ASCII `ECG1`
   - CRC32 byte range if padding differs
   - Indications vs notifications in final hardware

## Phase 1 — SQLite Foundations
**Implemented:**
- SQLite schema + helpers for scratch sessions/chunks and active baseline.
  - File: `capstone-ecgapp/services/ecg-db.ts`
- Test harness for chunk ordering:
  - File: `capstone-ecgapp/tests/ecg-test-harness.ts`
- Developer UI to run tests:
  - `capstone-ecgapp/app/(tabs)/settings.tsx`

**Follow-up required by you:**
- Run sanity checks in Settings.

## Phase 2 — Encoding + Checksums
**Implemented:**
- int16 LE encode/decode, base64 helpers, SHA-256 deterministic hash.
  - File: `capstone-ecgapp/services/ecg-encoding.ts`
- Tests wired into Settings.

**Follow-up required by you:**
- Run sanity checks in Settings.

## Next Phase to Implement
**Phase 3 — Recorder Core**
**Implemented:**
- `EcgRecorder` + `ChunkWriter` core (decode → seq gap → chunk writer → SQLite).
  - File: `capstone-ecgapp/services/ecg-recorder.ts`
- Added `getScratchSession` DB helper for gap_count checks.
  - File: `capstone-ecgapp/services/ecg-db.ts`
- Phase 3 tests added to the test harness.
  - File: `capstone-ecgapp/tests/ecg-test-harness.ts`
- Settings → Developer now runs Phase 3 tests.
  - Developer panel extracted to `capstone-ecgapp/components/developer-tools-card.tsx`
 - Minimal session state machine hook added for Phase 3.
  - File: `capstone-ecgapp/hooks/use-ecg-session-controller.ts`

**Docs added:**
- `capstone-ecgapp/FEATURE_INTEGRATION.md` (migration steps for feature folders)

**Follow-up required by you:**
- Settings → Developer → Run Sanity Checks and confirm:
  - Phase3: chunk writer 2s (single lead)
  - Phase3: gap triggers RETX(2,2)
  - Phase3: gap_count persisted

## Phase 4 — Calibration Session Flow
**Implemented:**
- Export payload builder (contiguous chunk validation + sha256).
  - File: `capstone-ecgapp/services/ecg-export.ts`
- Calibration finalize + validation stub (clean=false fallback).
  - File: `capstone-ecgapp/services/ecg-calibration.ts`
- Phase 4 tests added (20s capture, export, validation, missing config).
  - File: `capstone-ecgapp/tests/ecg-test-harness.ts`
- Developer panel shows test details for missing configuration.
- Calibration flow hook (20s timer + finalize).
  - File: `capstone-ecgapp/hooks/use-calibration-flow.ts`

**Follow-up required by you:**
- Settings → Developer → Run Sanity Checks and confirm Phase4 tests.
- Provide missing env vars if the config test fails:
  - `EXPO_PUBLIC_ECG_SERVICE_UUID`
  - `EXPO_PUBLIC_ECG_CHARACTERISTIC_UUID`
  - `EXPO_PUBLIC_ECG_CONTROL_UUID`
  - `EXPO_PUBLIC_CALIBRATION_API_URL`
  - `EXPO_PUBLIC_SUPABASE_URL`
  - `EXPO_PUBLIC_SUPABASE_ANON_KEY`
  - `EXPO_PUBLIC_SUPABASE_STORAGE_BUCKET`

## Test Strategy Update
**Change:**
- Developer "Run Sanity Checks" now uses **real BLE data** only.
- Deterministic/synthetic tests remain in `tests/ecg-test-harness.ts` but are not run by default.

**Implication:**
- BLE device must be connected for Phase 0–4 verification.
- Missing env vars are surfaced as explicit FAILs.

## Phase 6 — Supabase Upload (Scaffold tests only)
**Implemented:**
- Supabase config tests added (env checks + explicit pending upload test).
  - File: `capstone-ecgapp/tests/ecg-test-harness.ts`
- Developer panel now includes Phase 6 test results.

**Follow-up required by you:**
- Set env vars:
  - `EXPO_PUBLIC_SUPABASE_URL`
  - `EXPO_PUBLIC_SUPABASE_ANON_KEY`
  - `EXPO_PUBLIC_SUPABASE_STORAGE_BUCKET`
- Implement Supabase upload client + mocked upload test when ready.
