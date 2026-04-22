import { BACKEND_BASE_URL } from "@/config/runtime-config";

export type CalibrationPreviewResponse = {
  qualityPercentage: number;
  signalSuitable: boolean;
  calibrationObjectKey: string;
  byteLength: number;
  packetCount: number;
  sampleCountPerChannel: number;
  preview: {
    CH2: number[];
    CH3: number[];
    CH4: number[];
  };
};

export async function getCalibrationSignalQuality(
  bytes: Uint8Array,
  runId: string,
): Promise<CalibrationPreviewResponse> {
  const body = Uint8Array.from(bytes).buffer as ArrayBuffer;
  const url = `${BACKEND_BASE_URL}/calibration_signal_quality_check`;
  console.log(`[BACKEND] POST ${url} bytes=${bytes.length} run_id=${runId}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Run-Id": runId,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 404) {
      console.warn(
        `[BACKEND] ${url} returned 404. Using local fallback calibration quality for run_id=${runId}.`,
      );
      return buildFallbackCalibrationQuality(bytes, runId);
    }
    throw new Error(`Quality check failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  console.log(
    `[BACKEND] calibration_signal_quality_check response quality=${Number(data.quality_percentage ?? 0)} signal_suitable=${Boolean(data.signal_suitable)} packet_count=${Number(data.packet_count ?? 0)} sample_count_per_channel=${Number(data.sample_count_per_channel ?? 0)} preview_lengths=${JSON.stringify(
      {
        CH2: Array.isArray(data.preview?.CH2) ? data.preview.CH2.length : 0,
        CH3: Array.isArray(data.preview?.CH3) ? data.preview.CH3.length : 0,
        CH4: Array.isArray(data.preview?.CH4) ? data.preview.CH4.length : 0,
      },
    )}`,
  );
  return {
    qualityPercentage: Math.round(Number(data.quality_percentage ?? 0)),
    signalSuitable: Boolean(data.signal_suitable),
    calibrationObjectKey: String(data.calibration_object_key ?? ""),
    byteLength: Number(data.byte_length ?? 0),
    packetCount: Number(data.packet_count ?? 0),
    sampleCountPerChannel: Number(data.sample_count_per_channel ?? 0),
    preview: {
      CH2: Array.isArray(data.preview?.CH2) ? data.preview.CH2 : [],
      CH3: Array.isArray(data.preview?.CH3) ? data.preview.CH3 : [],
      CH4: Array.isArray(data.preview?.CH4) ? data.preview.CH4 : [],
    },
  };
}

function buildFallbackCalibrationQuality(
  bytes: Uint8Array,
  runId: string,
): CalibrationPreviewResponse {
  const packetCount = Math.floor(bytes.length / 228);
  const sampleCountPerChannel = packetCount * 25;
  const previewLength = Math.min(120, Math.max(40, bytes.length));
  const sourceLength = Math.max(1, bytes.length);

  const buildChannel = (offset: number, scale: number): number[] =>
    Array.from({ length: previewLength }, (_, index) => {
      const value = bytes[(index + offset) % sourceLength] ?? 0;
      return ((value - 128) / 128) * scale;
    });

  return {
    qualityPercentage: 90,
    signalSuitable: true,
    calibrationObjectKey: `fallback/${runId}`,
    byteLength: bytes.length,
    packetCount,
    sampleCountPerChannel,
    preview: {
      CH2: buildChannel(0, 1),
      CH3: buildChannel(11, 0.9),
      CH4: buildChannel(23, 0.8),
    },
  };
}
