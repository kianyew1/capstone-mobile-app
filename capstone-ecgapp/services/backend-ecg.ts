import { BACKEND_BASE_URL } from "@/config/runtime-config";

export type SessionStartResult = {
  recordId: string;
  sessionObjectKey: string;
};

export type SessionChunkResult = {
  recordId: string;
  sessionId: string;
  chunkIndex: number;
  byteLength: number;
  packetCount: number;
  sampleCountPerChannel: number;
};

export async function startSessionRecord(params: {
  userId: string;
  sessionId: string;
  calibrationObjectKey: string;
  startTime?: Date | null;
  recordId?: string | null;
}): Promise<SessionStartResult> {
  const url = `${BACKEND_BASE_URL}/session/start`;
  console.log(
    `[BACKEND] POST ${url} session_id=${params.sessionId} calibration_object_key=${params.calibrationObjectKey}`,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_id: params.userId,
      session_id: params.sessionId,
      calibration_object_key: params.calibrationObjectKey,
      start_time: params.startTime ? params.startTime.toISOString() : null,
      record_id: params.recordId ?? null,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Session start failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  console.log(
    `[BACKEND] session/start response record_id=${String(data.record_id)} session_object_key=${String(data.session_object_key)}`,
  );
  return {
    recordId: String(data.record_id),
    sessionObjectKey: String(data.session_object_key),
  };
}

export async function finalizeSessionRecord(params: {
  recordId: string;
  userId: string;
  sessionId: string;
  bytes: Uint8Array;
  startTime?: Date | null;
}): Promise<void> {
  const body = Uint8Array.from(params.bytes).buffer as ArrayBuffer;
  const url = `${BACKEND_BASE_URL}/end_session`;
  console.log(
    `[BACKEND] POST ${url} bytes=${params.bytes.length} session_id=${params.sessionId} record_id=${params.recordId}`,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Record-Id": params.recordId,
      "X-User-Id": params.userId,
      "X-Session-Id": params.sessionId,
      "X-Start-Time": params.startTime ? params.startTime.toISOString() : "",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Session upload failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  console.log(
    `[BACKEND] session/upload response record_id=${String(data.record_id)} packet_count=${Number(data.packet_count ?? 0)} sample_count_per_channel=${Number(data.sample_count_per_channel ?? 0)} duration_ms=${Number(data.duration_ms ?? 0)}`,
  );
}

export async function addToSessionChunk(params: {
  recordId: string;
  sessionId: string;
  chunkIndex: number;
  bytes: Uint8Array;
}): Promise<SessionChunkResult> {
  const body = Uint8Array.from(params.bytes).buffer as ArrayBuffer;
  const url = `${BACKEND_BASE_URL}/add_to_session`;
  console.log(
    `[BACKEND] POST ${url} record_id=${params.recordId} session_id=${params.sessionId} chunk_index=${params.chunkIndex} bytes=${params.bytes.length}`,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Record-Id": params.recordId,
      "X-Session-Id": params.sessionId,
      "X-Chunk-Index": String(params.chunkIndex),
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Add session chunk failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  return {
    recordId: String(data.record_id ?? params.recordId),
    sessionId: String(data.session_id ?? params.sessionId),
    chunkIndex: Number(data.chunk_index ?? params.chunkIndex),
    byteLength: Number(data.byte_length ?? 0),
    packetCount: Number(data.packet_count ?? 0),
    sampleCountPerChannel: Number(data.sample_count_per_channel ?? 0),
  };
}
