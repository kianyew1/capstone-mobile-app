import type { CalibrationOptions, CalibrationResponse } from "./types";
import { int16ToBase64 } from "./calibrationCodec";

const DEFAULT_API_URL = "https://example.com/v1/calibration/assess";

export async function assessCalibration({
  samplesInt16,
  sampleRateHz,
  durationSec,
  apiUrl,
}: {
  samplesInt16: number[];
  sampleRateHz: number;
  durationSec: number;
  apiUrl?: string;
}): Promise<CalibrationResponse> {
  const payload = {
    sample_rate_hz: sampleRateHz,
    duration_s: durationSec,
    format: "int16_le_base64",
    samples_base64: int16ToBase64(samplesInt16),
  };
  const url = apiUrl || DEFAULT_API_URL;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Calibration API failed (${response.status})`);
    }
    return (await response.json()) as CalibrationResponse;
  } catch {
    // TODO: Replace this fallback with the real API when available.
    // Simulate "not clean" so the UI forces a retry.
    return {
      clean: false,
    };
  }
}

export const calibrationDefaults: Required<Pick<CalibrationOptions, "sampleRateHz">> = {
  sampleRateHz: 500,
};
