import { useCallback, useMemo, useRef, useState } from "react";
import { EcgRecorder, type RecorderConfig } from "@/services/ecg-recorder";
import { finalizeCalibration, type CalibrationResult } from "@/services/ecg-calibration";

export type CalibrationPhase =
  | "idle"
  | "recording"
  | "validating"
  | "success"
  | "failed"
  | "error";

export interface CalibrationFlowState {
  phase: CalibrationPhase;
  sessionId: string | null;
  remainingMs: number;
  progress: number;
  error?: string | null;
  result?: CalibrationResult | null;
}

export interface CalibrationFlowConfig {
  fs: number;
  leadCount: number;
  layout: string;
  chunkSeconds?: number;
  durationSeconds?: number;
  apiUrl?: string | null;
  onRetransmit?: RecorderConfig["onRetransmit"];
}

export function useCalibrationFlow(config: CalibrationFlowConfig) {
  const durationSeconds = config.durationSeconds ?? 20;
  const recorderRef = useRef<EcgRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const [state, setState] = useState<CalibrationFlowState>({
    phase: "idle",
    sessionId: null,
    remainingMs: durationSeconds * 1000,
    progress: 0,
    error: null,
    result: null,
  });

  const start = useCallback(async (sessionId?: string) => {
    if (state.phase !== "idle") return;
    const id = sessionId ?? `calib-${Date.now()}`;
    const recorder = new EcgRecorder({
      sessionId: id,
      type: "baseline",
      fs: config.fs,
      leadCount: config.leadCount,
      layout: config.layout,
      chunkSeconds: config.chunkSeconds ?? 2,
      onRetransmit: config.onRetransmit,
    });
    recorderRef.current = recorder;
    try {
      await recorder.start();
      startedAtRef.current = Date.now();
      setState({
        phase: "recording",
        sessionId: id,
        remainingMs: durationSeconds * 1000,
        progress: 0,
        error: null,
        result: null,
      });
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(async () => {
        const startedAt = startedAtRef.current ?? Date.now();
        const elapsed = Date.now() - startedAt;
        const remaining = Math.max(durationSeconds * 1000 - elapsed, 0);
        const progress = Math.min(elapsed / (durationSeconds * 1000), 1);
        setState((prev) => ({
          ...prev,
          remainingMs: remaining,
          progress,
        }));
        if (remaining <= 0) {
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          await stop();
        }
      }, 200);
    } catch (err: unknown) {
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: err instanceof Error ? err.message : "Failed to start calibration",
      }));
    }
  }, [config, durationSeconds, state.phase]);

  const ingestBytes = useCallback(async (bytes: Uint8Array) => {
    const recorder = recorderRef.current;
    if (!recorder || state.phase !== "recording") return;
    await recorder.ingestPacketBytes(bytes);
  }, [state.phase]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || state.phase !== "recording") return;
    setState((prev) => ({ ...prev, phase: "validating" }));
    try {
      await recorder.stop();
      const result = await finalizeCalibration(
        recorder.getStatus().sessionId ?? "",
        config.apiUrl ?? null,
      );
      setState((prev) => ({
        ...prev,
        phase: result.validation.clean ? "success" : "failed",
        result,
      }));
    } catch (err: unknown) {
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: err instanceof Error ? err.message : "Calibration failed",
      }));
    }
  }, [config.apiUrl, state.phase]);

  const reset = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    startedAtRef.current = null;
    recorderRef.current = null;
    setState({
      phase: "idle",
      sessionId: null,
      remainingMs: durationSeconds * 1000,
      progress: 0,
      error: null,
      result: null,
    });
  }, [durationSeconds]);

  return useMemo(
    () => ({
      ...state,
      start,
      ingestBytes,
      stop,
      reset,
    }),
    [state, start, ingestBytes, stop, reset],
  );
}
