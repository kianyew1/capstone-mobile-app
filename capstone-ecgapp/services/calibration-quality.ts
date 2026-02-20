import { BACKEND_BASE_URL } from "@/config/runtime-config";

export async function getCalibrationSignalQuality(
  bytes: Uint8Array,
): Promise<{ qualityPercentage: number; signalSuitable: boolean }> {
  const url = `${BACKEND_BASE_URL}/calibration_signal_quality_check`;
  console.log(`LOG ${url}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Quality check failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  return {
    qualityPercentage: Math.round(Number(data.quality_percentage ?? 0)),
    signalSuitable: Boolean(data.signal_suitable),
  };
}
