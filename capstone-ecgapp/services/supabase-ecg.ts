import {
  getLatestCalibrationRunId,
  getPacketsForRun,
} from "@/services/ecg-storage";
import {
  ECG_PACKET_BYTES,
  ECG_SAMPLES_PER_PACKET,
} from "@/services/ecg-utils";

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SUPABASE_STORAGE_BUCKET =
  process.env.EXPO_PUBLIC_SUPABASE_STORAGE_BUCKET ?? "";

const DEFAULT_ENCODING = "ads1298_24be_mv";
const DEFAULT_SAMPLE_RATE_HZ = 500;
const DEFAULT_CHANNELS = 3;
const DEFAULT_CHANNEL_LABELS = ["CH2", "CH3", "CH4"];

function computePacketStats(bytes: Uint8Array) {
  const packetCount = Math.floor(bytes.length / ECG_PACKET_BYTES);
  const remainder = bytes.length % ECG_PACKET_BYTES;
  const sampleCountPerChannel = packetCount * ECG_SAMPLES_PER_PACKET;
  return { packetCount, remainder, sampleCountPerChannel };
}

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
  console.log(`LOG ${url}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/octet-stream",
      "x-upsert": "true",
    },
    body: bytes,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Storage upload failed: ${response.status} ${text}`);
  }
}

export async function uploadCalibrationFile(): Promise<{
  objectKey: string;
  byteLength: number;
} | null> {
  try {
    const runId = await getLatestCalibrationRunId();
    if (!runId) return null;

    const packets = await getPacketsForRun(runId);
    if (packets.length === 0) return null;

    const bytes = concatUint8Arrays(packets);
    const objectKey = `calibration/${runId}.bin`;

    await uploadToStorage(objectKey, bytes);
    return { objectKey, byteLength: bytes.length };
  } catch (error) {
    console.error("Calibration upload failed:", error);
    return null;
  }
}

export async function createSessionRecordAtStart(params: {
  userId: string;
  sessionId: string;
  calibrationObjectKey: string;
  startTime?: Date | null;
}) {
  assertSupabaseConfig();
  const sessionObjectKey = `session/${params.sessionId}.bin`;
  const url = `${SUPABASE_URL}/rest/v1/ecg_recordings`;
  console.log(`LOG ${url}`);
  const notes = JSON.stringify({
    channel_labels: DEFAULT_CHANNEL_LABELS,
    packet_bytes: ECG_PACKET_BYTES,
    samples_per_packet: ECG_SAMPLES_PER_PACKET,
    encoding: DEFAULT_ENCODING,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      user_id: params.userId,
      bucket: SUPABASE_STORAGE_BUCKET,
      session_object_key: sessionObjectKey,
      calibration_object_key: params.calibrationObjectKey,
      encoding: DEFAULT_ENCODING,
      sample_rate_hz: DEFAULT_SAMPLE_RATE_HZ,
      channels: DEFAULT_CHANNELS,
      sample_count: 0,
      duration_ms: 0,
      start_time: params.startTime ? params.startTime.toISOString() : null,
      byte_length: 0,
      notes,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Insert failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  return {
    recordId: Array.isArray(data) ? data[0]?.id : data?.id,
    sessionObjectKey,
  };
}

export async function finalizeSessionRecording(params: {
  recordId: string;
  userId: string;
  sessionId: string;
  bytes: Uint8Array;
  startTime?: Date | null;
}) {
  assertSupabaseConfig();

  const sessionObjectKey = `session/${params.sessionId}.bin`;
  await uploadToStorage(sessionObjectKey, params.bytes);

  const { packetCount, remainder, sampleCountPerChannel } =
    computePacketStats(params.bytes);
  if (remainder !== 0) {
    console.warn(
      `[SESSION] byte_length=${params.bytes.length} not multiple of packet_bytes=${ECG_PACKET_BYTES} remainder=${remainder}`,
    );
  }
  const durationMs = Math.round(
    (sampleCountPerChannel / DEFAULT_SAMPLE_RATE_HZ) * 1000,
  );
  const notes = JSON.stringify({
    channel_labels: DEFAULT_CHANNEL_LABELS,
    packet_bytes: ECG_PACKET_BYTES,
    samples_per_packet: ECG_SAMPLES_PER_PACKET,
    encoding: DEFAULT_ENCODING,
    packet_count: packetCount,
  });

  const updateUrl = `${SUPABASE_URL}/rest/v1/ecg_recordings?id=eq.${params.recordId}`;
  console.log(`LOG ${updateUrl}`);
  const response = await fetch(updateUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: params.userId,
      session_object_key: sessionObjectKey,
      sample_count: sampleCountPerChannel,
      duration_ms: durationMs,
      start_time: params.startTime ? params.startTime.toISOString() : null,
      byte_length: params.bytes.length,
      encoding: DEFAULT_ENCODING,
      sample_rate_hz: DEFAULT_SAMPLE_RATE_HZ,
      channels: DEFAULT_CHANNELS,
      notes,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Update failed: ${response.status} ${text}`);
  }
}
