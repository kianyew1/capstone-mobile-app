# Feature Integration Guide (Expo RN)

This doc explains how to migrate the ECG feature modules into another Expo React Native UI with minimal merge pain. The goal is **copy‑pasteable folders** and **thin UI wrappers**.

---

## 0) Prereqs (same for any host app)

- `react-native-ble-plx`
- `expo-sqlite`
- `buffer` (for base64 conversions in the JS layer)

---

## 1) BLE Core (drop‑in, UI‑agnostic)

**Copy folders**
- `features-from-other-repo/ble-stream/`

**What you get**
- `bleService.ts` — BLE manager + permissions + scan/connect/disconnect.
- `useBleStream.ts` — scan + connect flow (auto-connect by service UUID).
- `useBleDevConnect.ts` — lightweight dev hook with auto-connect + manual connect/disconnect.
- `BleStreamWidget.tsx` — minimal UI widget (optional).

**Use in your UI**
- Replace your “Bluetooth connect” button with:
  ```tsx
  const { isBluetoothOn, isPairing, connectedDevice, connect, disconnect } =
    useBleDevConnect({ serviceUUID, characteristicUUID, autoConnect: true });

  // Button:
  onPress={() => (connectedDevice ? disconnect() : connect())}
  ```

---

## 2) Recorder Core (SQLite chunk writer + seq gap handling)

**Copy files**
- `services/ecg-recorder.ts`
- `services/ecg-db.ts`
- `services/ecg-encoding.ts`
- `services/ecg-packet.ts`

**What you get**
- Strict packet decode (96‑byte + 20‑byte)
- Seq gap tracking + retransmit hook
- Chunked SQLite writer (2s default)

**Use in your UI**
```ts
const recorder = new EcgRecorder({
  sessionId,
  type: "baseline",
  fs: 500,
  leadCount: 3,
  layout: "interleaved",
  chunkSeconds: 2,
  onRetransmit: (from, to) => sendRetx(from, to),
});
await recorder.start();
// feed BLE bytes:
await recorder.ingestPacketBytes(bytes);
await recorder.stop();
```

---

## 3) Calibration Feature (20s capture + SQLite chunking)

**Copy folders**
- `features-from-other-repo/calibration/`

**What you get**
- `CalibrationButton.tsx` — single button UI
- `useCalibration.ts` — 20s record + SQLite chunk storage + placeholder API
- `calibrationStore.ts` — calibration DB schema + helpers

**Integration note**
- The calibration hook assumes samples are already being received.
- Replace the API URL when ready.

**Optional: Calibration flow hook (UI‑agnostic)**
- `hooks/use-calibration-flow.ts`
- Provides: `start()`, `ingestBytes()`, `stop()`, `reset()` and 20s timer state.
- Intended to be wired to your BLE stream subscription.

---

## 4) Developer BLE Card (thin wrapper UI)

**Option A (Recommended, portable)**
- Use the **hook** directly in your UI (see #1).

**Option B (Drop‑in UI)**
- Copy: `components/developer-tools-card.tsx`
- This uses `useBleDevConnect` + test harness and is meant for a **Developer Tools** panel.

---

## 5) Test Harness (portable tests)

**Copy files**
- `tests/ecg-test-harness.ts`
- `tests/ecg-live-sanity.ts`

**What you get**
- Deterministic Phase 0/1/2/3 tests (no hardware needed).
- Live BLE check (requires an already‑connected device).

**Run in any UI**
- Call `runPhase0PacketTests()` etc from any screen and render results.
- For live check, pass the connected device id.

---

## 6) Minimal integration path (lowest merge risk)

1) Copy `features-from-other-repo/ble-stream/` into the new repo.  
2) Copy `services/ecg-*.ts` into the new repo.  
3) Copy `tests/ecg-*.ts` into the new repo.  
4) Wire a single UI button to `useBleDevConnect` (no other UI changes).  

That keeps the UI thin and lets you iterate on BLE + recorder core safely.

---

## Notes

- The Developer BLE UI is optional. The core logic lives in the hook + services.
- If merges get messy, prefer **folder‑level moves**:
  - `features-from-other-repo/ble-stream`
  - `features-from-other-repo/calibration`
  - `services/ecg-*`
  - `tests/ecg-*`
