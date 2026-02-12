export type PacketFormat = "packet96" | "notify20";
export type LeadLayout = "interleaved" | "single";

export interface DecodedPacket {
  format: PacketFormat;
  seq: number | null;
  t0Ticks: number | null;
  flags: number | null;
  nFrames: number | null;
  samples: Int16Array;
  leadCount: number;
  layout: LeadLayout;
  rawBytes: Uint8Array;
}

export interface DecodeOptions {
  magicU16?: number;
  magicAscii?: string;
}

const PACKET96_LEN = 96;
const NOTIFY20_LEN = 20;
const DEFAULT_MAGIC_ASCII = "ECG1";

export function decodeEcgPayload(
  bytes: Uint8Array,
  options: DecodeOptions = {},
): { ok: true; packet: DecodedPacket } | { ok: false; error: string } {
  if (bytes.length === NOTIFY20_LEN) {
    const samples = decodeInt16LE(bytes);
    return {
      ok: true,
      packet: {
        format: "notify20",
        seq: null,
        t0Ticks: null,
        flags: null,
        nFrames: null,
        samples,
        leadCount: 1,
        layout: "single",
        rawBytes: bytes,
      },
    };
  }

  if (bytes.length !== PACKET96_LEN) {
    return { ok: false, error: `Unsupported packet length: ${bytes.length}` };
  }

  const layout = detectHeaderLayout(bytes, options);
  if (!layout) {
    return { ok: false, error: "Invalid magic header" };
  }

  const header = parseHeader(bytes, layout);
  if (!header) {
    return { ok: false, error: "Invalid header fields" };
  }

  const crcStored = readUint32LE(bytes, bytes.length - 4);
  const crcComputed = crc32(bytes.subarray(0, bytes.length - 4));
  if (crcStored !== crcComputed) {
    return { ok: false, error: "CRC32 mismatch" };
  }

  const payloadOffset = 16;
  const payloadBytes = bytes.subarray(
    payloadOffset,
    payloadOffset + header.nFrames * 6,
  );
  const samples = decodeInt16LE(payloadBytes);

  const leadProcessed = postProcessPacketToLeads(samples, 3, "interleaved");

  return {
    ok: true,
    packet: {
      format: "packet96",
      seq: header.seq,
      t0Ticks: header.t0Ticks,
      flags: header.flags,
      nFrames: header.nFrames,
      samples: leadProcessed.samples,
      leadCount: leadProcessed.leadCount,
      layout: leadProcessed.layout,
      rawBytes: bytes,
    },
  };
}

type HeaderLayout = "u16" | "ascii4";

function detectHeaderLayout(
  bytes: Uint8Array,
  options: DecodeOptions,
): HeaderLayout | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (typeof options.magicU16 === "number") {
    const magic = view.getUint16(0, true);
    return magic === options.magicU16 ? "u16" : null;
  }

  const magicAscii = options.magicAscii ?? DEFAULT_MAGIC_ASCII;
  if (magicAscii.length === 4) {
    const expected = [
      magicAscii.charCodeAt(0),
      magicAscii.charCodeAt(1),
      magicAscii.charCodeAt(2),
      magicAscii.charCodeAt(3),
    ];
    if (
      bytes[0] === expected[0] &&
      bytes[1] === expected[1] &&
      bytes[2] === expected[2] &&
      bytes[3] === expected[3]
    ) {
      return "ascii4";
    }
  }
  return null;
}

function parseHeader(bytes: Uint8Array, layout: HeaderLayout): {
  ver: number;
  flags: number;
  seq: number;
  t0Ticks: number;
  nFrames: number;
} | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const verOffset = layout === "u16" ? 2 : 4;
  const flagsOffset = layout === "u16" ? 3 : 5;
  const seqOffset = layout === "u16" ? 4 : 6;
  const t0Offset = layout === "u16" ? 8 : 10;
  const nFramesOffset = layout === "u16" ? 12 : 14;

  const ver = view.getUint8(verOffset);
  const flags = view.getUint8(flagsOffset);
  const seq = view.getUint32(seqOffset, true);
  const t0Ticks = view.getUint32(t0Offset, true);
  const nFrames = view.getUint16(nFramesOffset, true);

  if (ver !== 1) return null;
  if (nFrames !== 12) return null;

  return { ver, flags, seq, t0Ticks, nFrames };
}

function decodeInt16LE(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(offset, true);
}

export interface LeadProcessed {
  leadCount: number;
  layout: LeadLayout;
  samples: Int16Array;
}

export function postProcessPacketToLeads(
  samples: Int16Array,
  leadCount: number,
  layout: LeadLayout,
): LeadProcessed {
  // TODO: map interleaved leads into per-lead arrays when lead layout is finalized.
  return { leadCount, layout, samples };
}

export interface SeqTrackerResult {
  action: "accept" | "duplicate" | "gap";
  missingFrom?: number;
  missingTo?: number;
}

export function createSeqTracker(initialSeq = 0): {
  getExpectedSeq: () => number;
  getGapCount: () => number;
  onPacket: (seq: number) => SeqTrackerResult;
} {
  let expectedSeq = initialSeq;
  let gapCount = 0;

  return {
    getExpectedSeq: () => expectedSeq,
    getGapCount: () => gapCount,
    onPacket: (seq: number) => {
      if (seq < expectedSeq) {
        return { action: "duplicate" };
      }
      if (seq > expectedSeq) {
        const missingFrom = expectedSeq;
        const missingTo = seq - 1;
        gapCount += seq - expectedSeq;
        return { action: "gap", missingFrom, missingTo };
      }
      expectedSeq += 1;
      return { action: "accept" };
    },
  };
}

// CRC32 (standard IEEE) over bytes
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    let x = (crc ^ bytes[i]) & 0xff;
    for (let k = 0; k < 8; k += 1) {
      x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
    }
    crc = (crc >>> 8) ^ x;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
