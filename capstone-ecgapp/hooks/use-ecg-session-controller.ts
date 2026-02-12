import { useCallback, useRef, useState } from "react";
import type { RecorderConfig, RecorderStatus } from "@/services/ecg-recorder";
import { EcgRecorder } from "@/services/ecg-recorder";

export type SessionPhase =
  | "idle"
  | "recording"
  | "stopping"
  | "complete"
  | "error";

export interface EcgSessionController {
  phase: SessionPhase;
  status: RecorderStatus | null;
  start: (config: RecorderConfig) => Promise<void>;
  ingestBytes: (bytes: Uint8Array) => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
  error: string | null;
}

export function useEcgSessionController(): EcgSessionController {
  const recorderRef = useRef<EcgRecorder | null>(null);
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async (config: RecorderConfig) => {
    if (phase !== "idle") return;
    try {
      setError(null);
      const recorder = new EcgRecorder(config);
      recorderRef.current = recorder;
      await recorder.start();
      setStatus(recorder.getStatus());
      setPhase("recording");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to start session");
      setPhase("error");
    }
  }, [phase]);

  const ingestBytes = useCallback(async (bytes: Uint8Array) => {
    const recorder = recorderRef.current;
    if (!recorder || phase !== "recording") return;
    try {
      await recorder.ingestPacketBytes(bytes);
      setStatus(recorder.getStatus());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Recording error");
      setPhase("error");
    }
  }, [phase]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || phase !== "recording") return;
    try {
      setPhase("stopping");
      await recorder.stop();
      setStatus(recorder.getStatus());
      setPhase("complete");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to stop session");
      setPhase("error");
    }
  }, [phase]);

  const reset = useCallback(() => {
    recorderRef.current = null;
    setStatus(null);
    setError(null);
    setPhase("idle");
  }, []);

  return {
    phase,
    status,
    start,
    ingestBytes,
    stop,
    reset,
    error,
  };
}
