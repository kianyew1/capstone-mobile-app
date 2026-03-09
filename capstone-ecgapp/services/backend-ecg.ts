import { BACKEND_BASE_URL } from "@/config/runtime-config";

export type SessionStartResult = {
  recordId: string;
  sessionObjectKey: string;
};

export async function startSessionRecord(params: {
  userId: string;
  sessionId: string;
  calibrationObjectKey: string;
  startTime?: Date | null;
}): Promise<SessionStartResult> {
  const url = `${BACKEND_BASE_URL}/session/start`;
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
}
