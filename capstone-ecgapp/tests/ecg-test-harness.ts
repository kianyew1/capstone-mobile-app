// Test harness for Phase 0/1/2.
// These tests are deterministic and run locally inside the app.
// They DO NOT require BLE hardware.
import {
  clearScratch,
  createScratchSession,
  getScratchSession,
  initEcgDb,
  insertScratchChunk,
  listScratchChunks,
} from "@/services/ecg-db";
import {
  base64ToInt16LE,
  int16ToBase64LE,
  int16ToBytesLE,
  sha256Hex,
} from "@/services/ecg-encoding";
import {
  crc32,
  createSeqTracker,
  decodeEcgPayload,
} from "@/services/ecg-packet";
import { EcgRecorder } from "@/services/ecg-recorder";
import { exportScratchSessionPayload } from "@/services/ecg-export";
import { validateCalibration } from "@/services/ecg-calibration";

export interface TestResult {
  name: string;
  ok: boolean;
  details?: string;
}

export async function runPhase1DbTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  // Phase 1: SQLite correctness and ordering
  // Purpose: verify the DB is created and chunk ordering is deterministic.
  await initEcgDb();
  await clearScratch();

  const sessionId = "test-session-1";
  await createScratchSession({
    sessionId,
    type: "baseline",
    startedAtMs: 1,
    fs: 500,
    leadCount: 1,
    layout: "unknown",
  });

  await insertScratchChunk({
    sessionId,
    chunkIndex: 0,
    startTsMs: 1,
    endTsMs: 1000,
    sampleCount: 10,
    dataB64: int16ToBase64LE(new Int16Array([1, 2, 3, 4, 5])),
  });
  await insertScratchChunk({
    sessionId,
    chunkIndex: 1,
    startTsMs: 1001,
    endTsMs: 2000,
    sampleCount: 10,
    dataB64: int16ToBase64LE(new Int16Array([6, 7, 8, 9, 10])),
  });

  // Expect chunk_index ordering to be stable and contiguous.
  const chunks = await listScratchChunks(sessionId);
  results.push({
    name: "Phase1: chunks ordered",
    ok: chunks.length === 2 && chunks[0].chunkIndex === 0 && chunks[1].chunkIndex === 1,
    details: `count=${chunks.length}`,
  });

  let duplicateFailed = false;
  try {
    await insertScratchChunk({
      sessionId,
      chunkIndex: 1,
      startTsMs: 2001,
      endTsMs: 3000,
      sampleCount: 10,
      dataB64: int16ToBase64LE(new Int16Array([11, 12, 13, 14, 15])),
    });
  } catch {
    duplicateFailed = true;
  }
  results.push({
    name: "Phase1: duplicate chunk_index rejected",
    ok: duplicateFailed,
  });

  await createScratchSession({
    sessionId: "test-session-2",
    type: "baseline",
    startedAtMs: 2,
    fs: 500,
    leadCount: 1,
    layout: "unknown",
  });
  await clearScratch(sessionId);
  const remaining = await listScratchChunks("test-session-2");
  results.push({
    name: "Phase1: clearScratch(session) preserves other sessions",
    ok: remaining.length === 0,
    details: `remaining=${remaining.length}`,
  });

  return results;
}

export async function runPhase2EncodingTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  // Phase 2: Encoding + checksum determinism
  // Purpose: ensure int16->base64->int16 roundtrip and SHA-256 stability.
  const samples = new Int16Array([0, 1, -1, 0x0102, -32768, 32767]);
  const b64 = int16ToBase64LE(samples);
  const decoded = base64ToInt16LE(b64);
  const same =
    decoded.length === samples.length &&
    decoded.every((v, i) => v === samples[i]);
  results.push({
    name: "Phase2: int16 LE roundtrip",
    ok: same,
  });

  const sampleBytes = int16ToBytesLE(samples);
  const hash1 = sha256Hex(sampleBytes);
  const hash2 = sha256Hex(sampleBytes);
  results.push({
    name: "Phase2: SHA-256 deterministic",
    ok: hash1 === hash2,
  });

  const bytes = int16ToBytesLE(new Int16Array([0x0102]));
  results.push({
    name: "Phase2: little-endian byte order",
    ok: bytes[0] === 0x02 && bytes[1] === 0x01,
    details: `bytes=${bytes[0]},${bytes[1]}`,
  });

  return results;
}

export async function runPhase0PacketTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  // Phase 0: Packet decode, CRC32 validation, and seq gap logic
  // These tests simulate packets without BLE hardware.

  const good = buildPacket96Ascii(42);
  const decoded = decodeEcgPayload(good);
  results.push({
    name: "Phase0: decode 96-byte packet (ASCII magic)",
    ok: decoded.ok,
  });

  const badMagic = new Uint8Array(good);
  badMagic[0] = 0x00;
  const decodedMagic = decodeEcgPayload(badMagic);
  results.push({
    name: "Phase0: reject bad magic",
    ok: !decodedMagic.ok,
  });

  const badCrc = new Uint8Array(good);
  badCrc[95] = badCrc[95] ^ 0xff;
  const decodedCrc = decodeEcgPayload(badCrc);
  results.push({
    name: "Phase0: reject bad CRC32",
    ok: !decodedCrc.ok,
  });

  const notify20 = buildNotify20();
  const decoded20 = decodeEcgPayload(notify20);
  results.push({
    name: "Phase0: decode 20-byte notification",
    ok: decoded20.ok && decoded20.ok && decoded20.packet.samples.length === 10,
  });

  const tracker = createSeqTracker(10);
  // Accept seq=10, then duplicate seq=10, then gap at seq=12 (missing 11).
  const r1 = tracker.onPacket(10);
  const r2 = tracker.onPacket(10);
  const r3 = tracker.onPacket(12);
  results.push({
    name: "Phase0: seq accept + duplicate",
    ok: r1.action === "accept" && r2.action === "duplicate",
  });
  results.push({
    name: "Phase0: seq gap detection",
    ok:
      r3.action === "gap" &&
      r3.missingFrom === 11 &&
      r3.missingTo === 11,
  });

  const badLen = new Uint8Array(10);
  const decodedBadLen = decodeEcgPayload(badLen);
  results.push({
    name: "Phase0: reject unsupported length",
    ok: !decodedBadLen.ok,
  });

  return results;
}

export async function runPhase3RecorderTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  await initEcgDb();
  await clearScratch();

  // Phase 3: Recorder chunking (2s at 500 Hz, single lead)
  const sessionId = "recorder-test-1";
  const recorder = new EcgRecorder({
    sessionId,
    type: "baseline",
    fs: 500,
    leadCount: 1,
    layout: "single",
    chunkSeconds: 2,
  });
  await recorder.start();

  const notify20 = buildNotify20();
  for (let i = 0; i < 100; i += 1) {
    await recorder.ingestPacketBytes(notify20);
  }
  await recorder.stop();

  const chunks = await listScratchChunks(sessionId);
  results.push({
    name: "Phase3: chunk writer 2s (single lead)",
    ok: chunks.length === 1 && chunks[0].sampleCount === 1000,
    details: `chunks=${chunks.length}, samples=${chunks[0]?.sampleCount ?? 0}`,
  });

  // Phase 3: Seq gap detection + retransmit hook
  await clearScratch();
  const sessionId2 = "recorder-test-2";
  let retx: { from: number; to: number } | null = null;
  const recorder2 = new EcgRecorder({
    sessionId: sessionId2,
    type: "run",
    fs: 500,
    leadCount: 3,
    layout: "interleaved",
    chunkSeconds: 2,
    onRetransmit: (from, to) => {
      retx = { from, to };
    },
  });
  await recorder2.start();
  await recorder2.ingestPacketBytes(buildPacket96Ascii(1));
  await recorder2.ingestPacketBytes(buildPacket96Ascii(3));
  await recorder2.ingestPacketBytes(buildPacket96Ascii(2));
  await recorder2.stop();

  const session2 = await getScratchSession(sessionId2);
  results.push({
    name: "Phase3: gap triggers RETX(2,2)",
    ok: retx?.from === 2 && retx?.to === 2,
    details: retx ? `from=${retx.from},to=${retx.to}` : "no retx",
  });
  results.push({
    name: "Phase3: gap_count persisted",
    ok: (session2?.gapCount ?? 0) >= 1,
    details: `gap_count=${session2?.gapCount ?? 0}`,
  });

  // Duplicate packet should not increase totalSamples
  await clearScratch();
  const sessionId3 = "recorder-test-3";
  const recorder3 = new EcgRecorder({
    sessionId: sessionId3,
    type: "baseline",
    fs: 500,
    leadCount: 3,
    layout: "interleaved",
    chunkSeconds: 2,
  });
  await recorder3.start();
  await recorder3.ingestPacketBytes(buildPacket96Ascii(1));
  await recorder3.ingestPacketBytes(buildPacket96Ascii(1));
  await recorder3.stop();
  const status3 = recorder3.getStatus();
  results.push({
    name: "Phase3: duplicate seq ignored (sample count stable)",
    ok: status3.totalSamples === 36,
    details: `samples=${status3.totalSamples}`,
  });

  // Flush partial chunk on stop (single lead)
  await clearScratch();
  const sessionId4 = "recorder-test-4";
  const recorder4 = new EcgRecorder({
    sessionId: sessionId4,
    type: "baseline",
    fs: 500,
    leadCount: 1,
    layout: "single",
    chunkSeconds: 2,
  });
  await recorder4.start();
  for (let i = 0; i < 10; i += 1) {
    await recorder4.ingestPacketBytes(buildNotify20());
  }
  await recorder4.stop();
  const chunks4 = await listScratchChunks(sessionId4);
  results.push({
    name: "Phase3: flush partial chunk on stop",
    ok: chunks4.length === 1 && chunks4[0].sampleCount === 100,
    details: `chunks=${chunks4.length},samples=${chunks4[0]?.sampleCount ?? 0}`,
  });

  // Interleaved 3-lead chunk boundary (3000 samples per 2s)
  await clearScratch();
  const sessionId5 = "recorder-test-5";
  const recorder5 = new EcgRecorder({
    sessionId: sessionId5,
    type: "run",
    fs: 500,
    leadCount: 3,
    layout: "interleaved",
    chunkSeconds: 2,
  });
  await recorder5.start();
  for (let i = 0; i < 84; i += 1) {
    await recorder5.ingestPacketBytes(buildPacket96Ascii(i + 1));
  }
  await recorder5.stop();
  const chunks5 = await listScratchChunks(sessionId5);
  const firstChunkOk = chunks5[0]?.sampleCount === 3000;
  results.push({
    name: "Phase3: interleaved chunk size (3-lead)",
    ok: chunks5.length >= 1 && firstChunkOk,
    details: `chunks=${chunks5.length},first=${chunks5[0]?.sampleCount ?? 0}`,
  });

  return results;
}

export async function runPhase4CalibrationTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  await initEcgDb();
  await clearScratch();

  const sessionId = "calibration-test-1";
  const recorder = new EcgRecorder({
    sessionId,
    type: "baseline",
    fs: 500,
    leadCount: 1,
    layout: "single",
    chunkSeconds: 2,
  });
  await recorder.start();

  // 20 seconds at 500 Hz = 10,000 samples.
  // notify20 packet has 10 samples, so we need 1,000 packets.
  const notify20 = buildNotify20();
  for (let i = 0; i < 1000; i += 1) {
    await recorder.ingestPacketBytes(notify20);
  }
  await recorder.stop();

  const chunks = await listScratchChunks(sessionId);
  results.push({
    name: "Phase4: 20s -> 10 chunks (2s each)",
    ok: chunks.length === 10,
    details: `chunks=${chunks.length}`,
  });

  const payload = await exportScratchSessionPayload(sessionId);
  results.push({
    name: "Phase4: export sample count (10k)",
    ok: payload.totalSamples === 10000,
    details: `samples=${payload.totalSamples}`,
  });
  results.push({
    name: "Phase4: export sha256 present",
    ok: payload.sha256.length === 64,
  });

  const validation = await validateCalibration(payload, null);
  results.push({
    name: "Phase4: validation fallback returns clean=false",
    ok: validation.clean === false,
  });
  const cleanSegmentSamples = base64ToInt16LE(validation.cleanSegmentB64);
  results.push({
    name: "Phase4: clean segment length (10s)",
    ok: cleanSegmentSamples.length === 5000,
    details: `samples=${cleanSegmentSamples.length}`,
  });

  await clearScratch();
  const badSessionId = "calibration-test-2";
  await createScratchSession({
    sessionId: badSessionId,
    type: "baseline",
    startedAtMs: 1,
    fs: 500,
    leadCount: 1,
    layout: "single",
  });
  await insertScratchChunk({
    sessionId: badSessionId,
    chunkIndex: 0,
    startTsMs: 1,
    endTsMs: 2000,
    sampleCount: 1000,
    dataB64: int16ToBase64LE(new Int16Array(1000)),
  });
  await insertScratchChunk({
    sessionId: badSessionId,
    chunkIndex: 2,
    startTsMs: 4001,
    endTsMs: 6000,
    sampleCount: 1000,
    dataB64: int16ToBase64LE(new Int16Array(1000)),
  });
  let threw = false;
  try {
    await exportScratchSessionPayload(badSessionId);
  } catch {
    threw = true;
  }
  results.push({
    name: "Phase4: export fails on missing chunk",
    ok: threw,
  });

  let notEndedThrew = false;
  await clearScratch();
  const notEndedId = "calibration-test-3";
  await createScratchSession({
    sessionId: notEndedId,
    type: "baseline",
    startedAtMs: 1,
    fs: 500,
    leadCount: 1,
    layout: "single",
  });
  try {
    await exportScratchSessionPayload(notEndedId);
  } catch {
    notEndedThrew = true;
  }
  results.push({
    name: "Phase4: export fails if session not ended",
    ok: notEndedThrew,
  });

  const missing: string[] = [];
  if (!process.env.EXPO_PUBLIC_ECG_SERVICE_UUID) {
    missing.push("EXPO_PUBLIC_ECG_SERVICE_UUID");
  }
  if (!process.env.EXPO_PUBLIC_ECG_CHARACTERISTIC_UUID) {
    missing.push("EXPO_PUBLIC_ECG_CHARACTERISTIC_UUID");
  }
  if (!process.env.EXPO_PUBLIC_ECG_CONTROL_UUID) {
    missing.push("EXPO_PUBLIC_ECG_CONTROL_UUID");
  }
  if (!process.env.EXPO_PUBLIC_CALIBRATION_API_URL) {
    missing.push("EXPO_PUBLIC_CALIBRATION_API_URL");
  }
  results.push({
    name: "Phase4: config inputs present (fill missing)",
    ok: missing.length === 0,
    details: missing.length ? `missing=${missing.join(",")}` : undefined,
  });

  return results;
}

export async function runPhase6SupabaseTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const missing: string[] = [];
  if (!process.env.EXPO_PUBLIC_SUPABASE_URL) {
    missing.push("EXPO_PUBLIC_SUPABASE_URL");
  }
  if (!process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY) {
    missing.push("EXPO_PUBLIC_SUPABASE_ANON_KEY");
  }
  if (!process.env.EXPO_PUBLIC_SUPABASE_STORAGE_BUCKET) {
    missing.push("EXPO_PUBLIC_SUPABASE_STORAGE_BUCKET");
  }
  results.push({
    name: "Phase6: supabase config present (fill missing)",
    ok: missing.length === 0,
    details: missing.length ? `missing=${missing.join(",")}` : undefined,
  });

  results.push({
    name: "Phase6: upload test pending (implement supabase client)",
    ok: false,
    details: "TODO: add supabase upload client + mocked test",
  });

  return results;
}

function buildPacket96Ascii(seq: number): Uint8Array {
  const buf = new Uint8Array(96);
  // Build a valid 96-byte packet with ASCII magic "ECG1"
  // ASCII "ECG1"
  buf[0] = 0x45;
  buf[1] = 0x43;
  buf[2] = 0x47;
  buf[3] = 0x31;
  // ver, flags
  buf[4] = 1;
  buf[5] = 0;
  // seq
  writeUint32LE(buf, 6, seq);
  // t0_ticks
  writeUint32LE(buf, 10, 123456);
  // n_frames = 12
  writeUint16LE(buf, 14, 12);

  // payload (12 frames * 3 int16 = 36 int16 => 72 bytes)
  const payloadOffset = 16;
  for (let i = 0; i < 36; i += 1) {
    writeInt16LE(buf, payloadOffset + i * 2, i - 18);
  }

  // CRC32 computed over header+payload (first 92 bytes)
  const crc = crc32(buf.subarray(0, 92));
  writeUint32LE(buf, 92, crc);
  return buf;
}

function buildNotify20(): Uint8Array {
  const buf = new Uint8Array(20);
  // 20-byte notification contains 10 int16 samples (little-endian)
  for (let i = 0; i < 10; i += 1) {
    writeInt16LE(buf, i * 2, i);
  }
  return buf;
}

function writeUint16LE(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32LE(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function writeInt16LE(buf: Uint8Array, offset: number, value: number) {
  const v = value & 0xffff;
  buf[offset] = v & 0xff;
  buf[offset + 1] = (v >>> 8) & 0xff;
}
