export type CalibrationOptions = {
  serviceUUID: string;
  characteristicUUID: string;
  sampleRateHz?: number;
  durationSec?: number;
  chunkDurationSec?: number;
  apiUrl?: string;
};

export type CalibrationStatus =
  | "idle"
  | "recording"
  | "uploading"
  | "success"
  | "error";

export type CalibrationResponse = {
  clean: boolean;
  clean_segment?: {
    start_index: number;
    sample_rate_hz: number;
    samples_int16: number[];
  };
};
