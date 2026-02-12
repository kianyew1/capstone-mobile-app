import {
  getScratchSession,
  listScratchChunks,
  type SessionType,
} from "@/services/ecg-db";
import {
  base64ToInt16LE,
  concatInt16,
  int16ToBase64LE,
  int16ToBytesLE,
  sha256Hex,
} from "@/services/ecg-encoding";

export interface EcgExportPayload {
  sessionId: string;
  type: SessionType;
  startedAtMs: number;
  endedAtMs: number;
  fs: number;
  leadCount: number;
  layout: string;
  gapCount: number;
  totalSamples: number;
  dataB64: string;
  sha256: string;
}

export async function exportScratchSessionPayload(
  sessionId: string,
): Promise<EcgExportPayload> {
  const session = await getScratchSession(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (!session.endedAtMs) {
    throw new Error("Session not ended");
  }

  const chunks = await listScratchChunks(sessionId);
  if (chunks.length === 0) {
    throw new Error("No chunks found");
  }

  for (let i = 0; i < chunks.length; i += 1) {
    if (chunks[i].chunkIndex !== i) {
      throw new Error(
        `Chunk indices not contiguous at index ${i} (found ${chunks[i].chunkIndex})`,
      );
    }
  }

  const arrays: Int16Array[] = [];
  let totalSamples = 0;
  for (const chunk of chunks) {
    const decoded = base64ToInt16LE(chunk.dataB64);
    if (decoded.length !== chunk.sampleCount) {
      throw new Error(
        `Chunk sample_count mismatch at index ${chunk.chunkIndex}`,
      );
    }
    arrays.push(decoded);
    totalSamples += decoded.length;
  }

  const samples = concatInt16(arrays);
  const dataB64 = int16ToBase64LE(samples);
  const sha256 = sha256Hex(int16ToBytesLE(samples));

  return {
    sessionId,
    type: session.type,
    startedAtMs: session.startedAtMs,
    endedAtMs: session.endedAtMs,
    fs: session.fs,
    leadCount: session.leadCount,
    layout: session.layout,
    gapCount: session.gapCount,
    totalSamples,
    dataB64,
    sha256,
  };
}
