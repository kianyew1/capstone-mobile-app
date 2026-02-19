const BACKEND_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:8001";

export async function getCalibrationSignalQuality(
  bytes: Uint8Array,
): Promise<{ qualityPercentage: number; signalSuitable: boolean }> {
  const url = `${BACKEND_URL}/calibration_signal_quality_check`;
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
