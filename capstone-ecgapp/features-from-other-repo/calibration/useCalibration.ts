import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Buffer } from "buffer";
import type { CalibrationOptions, CalibrationStatus } from "./types";
import { assessCalibration } from "./calibrationService";
import {
  appendCalibrationChunk,
  createCalibrationSession,
  deleteCalibrationChunks,
  exportCalibrationPayload,
  getCalibrationChunkCount,
  getCalibrationChunkPreview,
  initCalibrationTables,
  saveBaselineReference,
  updateCalibrationSession,
} from "./calibrationStore";
import { bytesToBase64, int16ToBytes, sha256Hex } from "./calibrationCodec";

const DEFAULT_SAMPLE_RATE_HZ = 500;
const DEFAULT_DURATION_SEC = 20;
const DEFAULT_CHUNK_DURATION_SEC = 2;

export function useCalibration({
  connectedDevice,
  options,
}: {
  connectedDevice: any | null;
  options: CalibrationOptions;
}) {
  const [status, setStatus] = useState<CalibrationStatus>("idle");
  const [error, setError] = useState("");
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const [packetCount, setPacketCount] = useState(0);
  const [exportPayload, setExportPayload] = useState<any | null>(null);
  const [chunkPreview, setChunkPreview] = useState<any[]>([]);
  const [chunkCount, setChunkCount] = useState(0);
  const subscriptionRef = useRef<any>(null);
  const stopCaptureRef = useRef<null | (() => void)>(null);
  const intervalRef = useRef<any>(null);
  const sessionIdRef = useRef<string | null>(null);
  const chunkIndexRef = useRef(0);
  const chunkSamplesRef = useRef<number[]>([]);
  const chunkStartTsRef = useRef<number | null>(null);
  const failedRef = useRef(false);

  const startCalibration = useCallback(async () => {
    if (!connectedDevice) {
      setStatus("error");
      setError("Device not connected");
      return false;
    }
    if (status === "recording" || status === "uploading") return false;
    setError("");
    setStatus("recording");
    failedRef.current = false;
    setChunkPreview([]);
    setChunkCount(0);

    const durationSec = options.durationSec || DEFAULT_DURATION_SEC;
    const sampleRateHz = options.sampleRateHz || DEFAULT_SAMPLE_RATE_HZ;
    const chunkDurationSec = options.chunkDurationSec || DEFAULT_CHUNK_DURATION_SEC;
    const chunkSampleTarget = Math.max(1, Math.floor(chunkDurationSec * sampleRateHz));
    const samples: number[] = [];
    setPacketCount(0);

    await initCalibrationTables();
    const sessionId = await createCalibrationSession({
      fs: sampleRateHz,
      leadCount: 1,
    });
    sessionIdRef.current = sessionId;
    chunkIndexRef.current = 0;
    chunkSamplesRef.current = [];
    chunkStartTsRef.current = null;

    const failCalibration = async (message: string) => {
      if (failedRef.current) return;
      failedRef.current = true;
      setError(message);
      setStatus("error");
      if (subscriptionRef.current?.remove) {
        subscriptionRef.current.remove();
        subscriptionRef.current = null;
      }
      if (stopCaptureRef.current) stopCaptureRef.current();
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        await updateCalibrationSession({
          sessionId,
          status: "rejected",
          endedAtMs: Date.now(),
        });
      }
    };

    const waitForDuration = () =>
      new Promise<void>((resolve) => {
        const startTs = Date.now();
        setRemainingSec(durationSec);
        intervalRef.current = setInterval(() => {
          const elapsed = (Date.now() - startTs) / 1000;
          const remaining = Math.max(0, Math.ceil(durationSec - elapsed));
          setRemainingSec(remaining);
        }, 500);
        const timer = setTimeout(resolve, durationSec * 1000);
        stopCaptureRef.current = () => {
          clearTimeout(timer);
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          resolve();
        };
      });

    const flushChunk = async (chunkSamples: number[], startTsMs: number) => {
      if (!chunkSamples.length || !sessionIdRef.current) return;
      const bytes = int16ToBytes(chunkSamples);
      const dataB64 = bytesToBase64(bytes);
      const checksum = sha256Hex(bytes);
      const endTsMs =
        startTsMs +
        Math.floor(((chunkSamples.length - 1) / sampleRateHz) * 1000);
      await appendCalibrationChunk({
        sessionId: sessionIdRef.current,
        chunkIndex: chunkIndexRef.current,
        startTsMs,
        endTsMs,
        sampleCount: chunkSamples.length,
        dataB64,
        checksum,
      });
      chunkIndexRef.current += 1;
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        const count = await getCalibrationChunkCount(sessionId);
        setChunkCount(count);
        const preview = await getCalibrationChunkPreview(sessionId, 3);
        setChunkPreview(preview);
      }
    };

    const subscription = connectedDevice.monitorCharacteristicForService(
      options.serviceUUID,
      options.characteristicUUID,
      (err: any, characteristic: any) => {
        if (err) {
          void failCalibration(err.message || "Calibration stream error");
          return;
        }
        const value = characteristic?.value;
        if (!value) return;
        const payload = Buffer.from(value, "base64");
        if (!payload.length) return;
        setPacketCount((prev) => prev + 1);
        const view = new DataView(
          payload.buffer,
          payload.byteOffset,
          payload.byteLength
        );
        for (let i = 0; i + 1 < payload.length; i += 2) {
          const next = view.getInt16(i, true);
          samples.push(next);
          if (chunkSamplesRef.current.length === 0) {
            chunkStartTsRef.current = Date.now();
          }
          chunkSamplesRef.current.push(next);
          if (chunkSamplesRef.current.length >= chunkSampleTarget) {
            const snapshot = chunkSamplesRef.current;
            const startTs = chunkStartTsRef.current || Date.now();
            chunkSamplesRef.current = [];
            chunkStartTsRef.current = null;
            void flushChunk(snapshot, startTs).catch(() => {
              void failCalibration("Failed to store calibration chunk");
            });
          }
        }
      }
    );

    subscriptionRef.current = subscription;
    await waitForDuration();

    if (subscriptionRef.current?.remove) {
      subscriptionRef.current.remove();
      subscriptionRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    stopCaptureRef.current = null;
    setRemainingSec(0);

    if (failedRef.current) return false;

    if (!samples.length) {
      setStatus("error");
      setError("No samples received");
      return false;
    }

    setStatus("uploading");
    try {
      if (chunkSamplesRef.current.length) {
        const snapshot = chunkSamplesRef.current;
        const startTs = chunkStartTsRef.current || Date.now();
        chunkSamplesRef.current = [];
        chunkStartTsRef.current = null;
        await flushChunk(snapshot, startTs);
      }
      if (failedRef.current) return false;
      const sessionId = sessionIdRef.current;
      if (!sessionId) throw new Error("Calibration session missing");
      await updateCalibrationSession({
        sessionId,
        status: "ended",
        endedAtMs: Date.now(),
      });
      const rawExport = await exportCalibrationPayload(sessionId);
      const response = await assessCalibration({
        samplesInt16: samples,
        sampleRateHz,
        durationSec,
        apiUrl: options.apiUrl,
      });
      const qualitySummary = JSON.stringify({
        clean: response.clean,
        total_samples: rawExport.total_samples,
        sha256: rawExport.sha256,
      });
      const exportWithQuality = {
        ...rawExport,
        quality_summary_json: qualitySummary,
      };
      setExportPayload(exportWithQuality);
      if (!response.clean || !response.clean_segment) {
        await updateCalibrationSession({
          sessionId,
          status: "rejected",
          endedAtMs: Date.now(),
          qualitySummaryJson: qualitySummary,
        });
        setStatus("error");
        setError("Signal not clean");
        return false;
      }
      const cleanSegment = response.clean_segment;
      const cleanBytes = int16ToBytes(cleanSegment.samples_int16);
      await saveBaselineReference({
        baselineSessionId: sessionId,
        fs: cleanSegment.sample_rate_hz || sampleRateHz,
        leadCount: 1,
        qualitySummaryJson: qualitySummary,
        signalStartIndex: cleanSegment.start_index,
        signalB64: bytesToBase64(cleanBytes),
        signalSampleCount: cleanSegment.samples_int16.length,
      });
      await updateCalibrationSession({
        sessionId,
        status: "accepted",
        endedAtMs: Date.now(),
        qualitySummaryJson: qualitySummary,
      });
      await deleteCalibrationChunks(sessionId);
      setStatus("success");
      return true;
    } catch (err: any) {
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        await updateCalibrationSession({
          sessionId,
          status: "rejected",
          endedAtMs: Date.now(),
        });
      }
      setStatus("error");
      setError(err.message || "Calibration failed");
      return false;
    }
  }, [connectedDevice, options, status]);

  useEffect(() => {
    return () => {
      if (subscriptionRef.current?.remove) {
        subscriptionRef.current.remove();
        subscriptionRef.current = null;
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (stopCaptureRef.current) {
        stopCaptureRef.current();
        stopCaptureRef.current = null;
      }
    };
  }, []);

  const buttonLabel = useMemo(() => {
    if (status === "recording") return "Calibrating...";
    if (status === "uploading") return "Checking signal...";
    if (status === "success") return "Calibration OK";
    if (status === "error") return "Retry Calibration";
    return "Start Calibration";
  }, [status]);

  return {
    status,
    error,
    buttonLabel,
    remainingSec,
    packetCount,
    exportPayload,
    chunkCount,
    chunkPreview,
    startCalibration,
  };
}
