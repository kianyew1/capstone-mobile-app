import type { SessionType } from "@/services/ecg-db";
import {
  createScratchSession,
  insertScratchChunk,
  markSessionEnded,
  updateGapCount,
  initEcgDb,
} from "@/services/ecg-db";
import { int16ToBase64LE, concatInt16 } from "@/services/ecg-encoding";
import {
  createSeqTracker,
  decodeEcgPayload,
  type DecodedPacket,
} from "@/services/ecg-packet";

export type RecorderState = "idle" | "recording" | "stopping" | "ended" | "error";

export interface RecorderConfig {
  sessionId: string;
  type: SessionType;
  fs: number;
  leadCount: number;
  layout: string;
  chunkSeconds?: number;
  startedAtMs?: number;
  onRetransmit?: (fromSeq: number, toSeq: number) => Promise<void> | void;
}

export interface RecorderStatus {
  state: RecorderState;
  sessionId: string | null;
  chunkIndex: number;
  bufferedSamples: number;
  totalSamples: number;
  gapCount: number;
  expectedSeq: number | null;
  decodeErrors: number;
}

class ChunkWriter {
  private sessionId: string;
  private fs: number;
  private leadCount: number;
  private layout: string;
  private chunkSeconds: number;
  private chunkIndex = 0;
  private buffer: Int16Array[] = [];
  private bufferCount = 0;
  private chunkStartTsMs: number | null = null;
  private lastSampleTsMs: number | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    sessionId: string,
    fs: number,
    leadCount: number,
    layout: string,
    chunkSeconds: number,
  ) {
    this.sessionId = sessionId;
    this.fs = fs;
    this.leadCount = leadCount;
    this.layout = layout;
    this.chunkSeconds = chunkSeconds;
  }

  getChunkIndex(): number {
    return this.chunkIndex;
  }

  getBufferedSamples(): number {
    return this.bufferCount;
  }

  async append(samples: Int16Array, tsMs: number): Promise<void> {
    if (samples.length === 0) return;
    if (this.bufferCount === 0) {
      this.chunkStartTsMs = tsMs;
    }
    this.lastSampleTsMs = tsMs;
    this.buffer.push(samples);
    this.bufferCount += samples.length;

    const targetSamples = this.fs * this.leadCount * this.chunkSeconds;
    while (this.bufferCount >= targetSamples) {
      const chunkSamples = this.takeSamples(targetSamples);
      const chunkStart = this.chunkStartTsMs ?? tsMs;
      const chunkEnd = this.lastSampleTsMs ?? tsMs;
      await this.enqueueChunkWrite(chunkSamples, chunkStart, chunkEnd);
      this.chunkIndex += 1;
      this.chunkStartTsMs = this.lastSampleTsMs;
    }
  }

  async flush(tsMs: number): Promise<void> {
    if (this.bufferCount === 0) {
      await this.writeChain;
      return;
    }
    const chunkSamples = this.takeSamples(this.bufferCount);
    const chunkStart = this.chunkStartTsMs ?? tsMs;
    const chunkEnd = this.lastSampleTsMs ?? tsMs;
    await this.enqueueChunkWrite(chunkSamples, chunkStart, chunkEnd);
    this.chunkIndex += 1;
    this.chunkStartTsMs = null;
    this.lastSampleTsMs = null;
    await this.writeChain;
  }

  private takeSamples(target: number): Int16Array {
    if (target <= 0) return new Int16Array();
    const out = new Int16Array(target);
    let offset = 0;
    while (offset < target && this.buffer.length > 0) {
      const head = this.buffer[0];
      const remaining = target - offset;
      if (head.length <= remaining) {
        out.set(head, offset);
        offset += head.length;
        this.buffer.shift();
      } else {
        out.set(head.subarray(0, remaining), offset);
        this.buffer[0] = head.subarray(remaining);
        offset += remaining;
      }
    }
    this.bufferCount -= target;
    return out;
  }

  private async enqueueChunkWrite(
    samples: Int16Array,
    startTsMs: number,
    endTsMs: number,
  ): Promise<void> {
    const dataB64 = int16ToBase64LE(samples);
    const input = {
      sessionId: this.sessionId,
      chunkIndex: this.chunkIndex,
      startTsMs,
      endTsMs,
      sampleCount: samples.length,
      dataB64,
    };
    this.writeChain = this.writeChain.then(() => insertScratchChunk(input));
    await this.writeChain;
  }
}

export class EcgRecorder {
  private config: RecorderConfig;
  private state: RecorderState = "idle";
  private chunkWriter: ChunkWriter | null = null;
  private seqTracker: ReturnType<typeof createSeqTracker> | null = null;
  private gapCount = 0;
  private totalSamples = 0;
  private decodeErrors = 0;

  constructor(config: RecorderConfig) {
    this.config = {
      ...config,
      chunkSeconds: config.chunkSeconds ?? 2,
      startedAtMs: config.startedAtMs ?? Date.now(),
    };
  }

  getStatus(): RecorderStatus {
    return {
      state: this.state,
      sessionId: this.config.sessionId,
      chunkIndex: this.chunkWriter?.getChunkIndex() ?? 0,
      bufferedSamples: this.chunkWriter?.getBufferedSamples() ?? 0,
      totalSamples: this.totalSamples,
      gapCount: this.gapCount,
      expectedSeq: this.seqTracker?.getExpectedSeq() ?? null,
      decodeErrors: this.decodeErrors,
    };
  }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    await initEcgDb();
    await createScratchSession({
      sessionId: this.config.sessionId,
      type: this.config.type,
      startedAtMs: this.config.startedAtMs ?? Date.now(),
      fs: this.config.fs,
      leadCount: this.config.leadCount,
      layout: this.config.layout,
    });
    this.chunkWriter = new ChunkWriter(
      this.config.sessionId,
      this.config.fs,
      this.config.leadCount,
      this.config.layout,
      this.config.chunkSeconds ?? 2,
    );
    this.state = "recording";
  }

  async ingestPacketBytes(bytes: Uint8Array, tsMs = Date.now()): Promise<void> {
    if (this.state !== "recording") return;
    const decoded = decodeEcgPayload(bytes);
    if (!decoded.ok) {
      this.decodeErrors += 1;
      return;
    }
    await this.ingestDecodedPacket(decoded.packet, tsMs);
  }

  async ingestDecodedPacket(
    packet: DecodedPacket,
    tsMs = Date.now(),
  ): Promise<void> {
    if (this.state !== "recording" || !this.chunkWriter) return;

    if (packet.seq !== null) {
      if (!this.seqTracker) {
        this.seqTracker = createSeqTracker(packet.seq);
      }
      const result = this.seqTracker.onPacket(packet.seq);
      if (result.action === "gap") {
        const newGap = this.seqTracker.getGapCount();
        if (newGap !== this.gapCount) {
          this.gapCount = newGap;
          await updateGapCount(this.config.sessionId, this.gapCount);
        }
        if (result.missingFrom !== undefined && result.missingTo !== undefined) {
          await this.config.onRetransmit?.(
            result.missingFrom,
            result.missingTo,
          );
        }
        return;
      }
      if (result.action === "duplicate") {
        return;
      }
    }

    const samples = packet.samples;
    this.totalSamples += samples.length;
    await this.chunkWriter.append(samples, tsMs);
  }

  async stop(endedAtMs = Date.now()): Promise<void> {
    if (this.state !== "recording") return;
    this.state = "stopping";
    if (this.chunkWriter) {
      await this.chunkWriter.flush(endedAtMs);
    }
    await markSessionEnded(this.config.sessionId, endedAtMs, "ended");
    this.state = "ended";
  }
}

export function concatPacketSamples(packets: DecodedPacket[]): Int16Array {
  const arrays = packets.map((p) => p.samples);
  return concatInt16(arrays);
}
