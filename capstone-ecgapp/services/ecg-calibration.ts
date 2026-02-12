import { clearScratch, setActiveBaseline } from "@/services/ecg-db";
import {
  base64ToInt16LE,
  int16ToBase64LE,
} from "@/services/ecg-encoding";
import { exportScratchSessionPayload } from "@/services/ecg-export";

export interface CalibrationValidationResult {
  clean: boolean;
  cleanSegmentB64: string;
  reason?: string;
}

export interface CalibrationResult {
  payload: Awaited<ReturnType<typeof exportScratchSessionPayload>>;
  validation: CalibrationValidationResult;
}

const DEFAULT_CLEAN_SEGMENT_SECONDS = 10;

export async function finalizeCalibration(
  sessionId: string,
  apiUrl?: string | null,
): Promise<CalibrationResult> {
  const payload = await exportScratchSessionPayload(sessionId);
  const validation = await validateCalibration(payload, apiUrl);

  if (validation.clean) {
    await setActiveBaseline(null, sessionId, Date.now());
  } else {
    await setActiveBaseline(null, null, null);
  }

  await clearScratch(sessionId);

  return { payload, validation };
}

export async function validateCalibration(
  payload: Awaited<ReturnType<typeof exportScratchSessionPayload>>,
  apiUrl?: string | null,
): Promise<CalibrationValidationResult> {
  if (apiUrl) {
    // TODO: Replace with real API call when endpoint is available.
    // Expected response: { clean: boolean, cleanSegmentB64: string, reason?: string }
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return {
        clean: false,
        cleanSegmentB64: computeCleanSegment(payload, DEFAULT_CLEAN_SEGMENT_SECONDS),
        reason: `API error: ${res.status}`,
      };
    }
    return (await res.json()) as CalibrationValidationResult;
  }

  // TODO: Replace with real API when available.
  // Current behavior intentionally returns "clean=false" to force retry.
  return {
    clean: false,
    cleanSegmentB64: computeCleanSegment(payload, DEFAULT_CLEAN_SEGMENT_SECONDS),
    reason: "API not configured; using fallback.",
  };
}

function computeCleanSegment(
  payload: Awaited<ReturnType<typeof exportScratchSessionPayload>>,
  seconds: number,
): string {
  const samples = base64ToInt16LE(payload.dataB64);
  const required = payload.fs * payload.leadCount * seconds;
  const segment = samples.subarray(0, Math.min(required, samples.length));
  return int16ToBase64LE(segment);
}
