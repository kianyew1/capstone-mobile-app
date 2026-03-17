import { BACKEND_BASE_URL } from "@/config/runtime-config";

export type SessionStartResult = {
  recordId: string;
  sessionObjectKey: string;
};

export type SessionSignalCheckResult = {
  recordId: string;
  sessionId: string | null;
  packetCountReceived: number;
  totalPacketsBuffered: number;
  samplesAnalyzed: number;
  windowSeconds: number;
  qualityPercentage: number;
  signalOk: boolean;
  abnormalDetected: boolean;
  reasonCodes: string[];
  heartRateBpm: number | null;
};

export async function startSessionRecord(params: {
  userId: string;
  sessionId: string;
  calibrationObjectKey: string;
  startTime?: Date | null;
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
  const url = `${BACKEND_BASE_URL}/session/${params.recordId}/upload`;
  console.log(
    `[BACKEND] POST ${url} bytes=${params.bytes.length} session_id=${params.sessionId}`,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
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

export async function checkSessionSignalQuality(params: {
  recordId: string;
  sessionId: string;
  bytes: Uint8Array;
}): Promise<SessionSignalCheckResult> {
  const body = Uint8Array.from(params.bytes).buffer as ArrayBuffer;
  const url = `${BACKEND_BASE_URL}/session_signal_quality_check`;
  console.log(
    `[BACKEND] POST ${url} record_id=${params.recordId} session_id=${params.sessionId} bytes=${params.bytes.length}`,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Record-Id": params.recordId,
      "X-Session-Id": params.sessionId,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Session signal quality check failed: ${response.status} ${text}`,
    );
  }

  const data = await response.json();
  console.log(
    `[BACKEND] session_signal_quality_check response abnormal=${Boolean(data.abnormal_detected)} signal_ok=${Boolean(data.signal_ok)} quality=${Number(data.quality_percentage ?? 0)} hr=${data.heart_rate_bpm ?? "null"} reasons=${Array.isArray(data.reason_codes) ? data.reason_codes.join("|") : "none"}`,
  );
  return {
    recordId: String(data.record_id ?? params.recordId),
    sessionId: data.session_id ? String(data.session_id) : null,
    packetCountReceived: Number(data.packet_count_received ?? 0),
    totalPacketsBuffered: Number(data.total_packets_buffered ?? 0),
    samplesAnalyzed: Number(data.samples_analyzed ?? 0),
    windowSeconds: Number(data.window_seconds ?? 0),
    qualityPercentage: Number(data.quality_percentage ?? 0),
    signalOk: Boolean(data.signal_ok),
    abnormalDetected: Boolean(data.abnormal_detected),
    reasonCodes: Array.isArray(data.reason_codes) ? data.reason_codes : [],
    heartRateBpm:
      data.heart_rate_bpm === null || data.heart_rate_bpm === undefined
        ? null
        : Number(data.heart_rate_bpm),
  };
}
