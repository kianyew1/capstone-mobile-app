import {
  getLatestCalibrationRunId,
  getPacketsForRun,
} from "@/services/ecg-storage";

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SUPABASE_STORAGE_BUCKET =
  process.env.EXPO_PUBLIC_SUPABASE_STORAGE_BUCKET ?? "";

const DEFAULT_ENCODING = "int16_le";
const DEFAULT_SAMPLE_RATE_HZ = 500;
const DEFAULT_CHANNELS = 1;

type RecordingMeta = {
  userId: string;
  objectKey: string;
  bytes: Uint8Array;
  startTime?: Date | null;
  notes?: string | null;
  deviceId?: string | null;
  firmwareVersion?: string | null;
};

function assertSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_STORAGE_BUCKET) {
    throw new Error("Missing Supabase configuration in .env");
  }
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function uploadToStorage(objectKey: string, bytes: Uint8Array) {
  assertSupabaseConfig();
  const url = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}/${objectKey}`;
  const body = new Blob([bytes], { type: "application/octet-stream" });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/octet-stream",
      "x-upsert": "true",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Storage upload failed: ${response.status} ${text}`);
  }
}

async function insertRecordingRow(meta: RecordingMeta) {
  assertSupabaseConfig();
  const sampleCount = Math.floor(meta.bytes.length / 2);
  const durationMs = Math.round((sampleCount / DEFAULT_SAMPLE_RATE_HZ) * 1000);

  const response = await fetch(`${SUPABASE_URL}/rest/v1/ecg_recordings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      user_id: meta.userId,
      bucket: SUPABASE_STORAGE_BUCKET,
      object_key: meta.objectKey,
      encoding: DEFAULT_ENCODING,
      sample_rate_hz: DEFAULT_SAMPLE_RATE_HZ,
      channels: DEFAULT_CHANNELS,
      sample_count: sampleCount,
      duration_ms: durationMs,
      start_time: meta.startTime ? meta.startTime.toISOString() : null,
      byte_length: meta.bytes.length,
      device_id: meta.deviceId ?? null,
      firmware_version: meta.firmwareVersion ?? null,
      notes: meta.notes ?? null,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Insert failed: ${response.status} ${text}`);
  }
}

export async function uploadRecording(meta: RecordingMeta) {
  await uploadToStorage(meta.objectKey, meta.bytes);
  await insertRecordingRow(meta);
}

export async function uploadLatestCalibration(
  userId: string,
): Promise<boolean> {
  try {
    const runId = await getLatestCalibrationRunId();
    if (!runId) return false;

    const packets = await getPacketsForRun(runId);
    if (packets.length === 0) return false;

    const bytes = concatUint8Arrays(packets);
    const objectKey = `calibration/${runId}.bin`;

    await uploadRecording({
      userId,
      objectKey,
      bytes,
      notes: "calibration",
    });

    return true;
  } catch (error) {
    console.error("Calibration upload failed:", error);
    return false;
  }
}

export async function uploadSessionRecording(
  userId: string,
  sessionId: string,
  bytes: Uint8Array,
  startTime?: Date | null,
): Promise<void> {
  const objectKey = `session/${sessionId}.bin`;
  await uploadRecording({
    userId,
    objectKey,
    bytes,
    startTime,
    notes: "session",
  });
}
