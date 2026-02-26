export function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function generateMockSessionBytes(): Uint8Array {
  const sampleRateHz = 500;
  const durationSeconds = 600;
  const totalSamples = sampleRateHz * durationSeconds;
  const amplitude = 1200;
  const noiseAmplitude = 80;

  const syntheticEcg = (t: number) => {
    const p = 0.12 * Math.exp(-Math.pow((t - 0.18) / 0.035, 2));
    const q = -0.15 * Math.exp(-Math.pow((t - 0.4) / 0.01, 2));
    const r = 1.2 * Math.exp(-Math.pow((t - 0.42) / 0.012, 2));
    const s = -0.25 * Math.exp(-Math.pow((t - 0.45) / 0.012, 2));
    const tw = 0.35 * Math.exp(-Math.pow((t - 0.7) / 0.06, 2));
    return p + q + r + s + tw;
  };

  const bytes = new Uint8Array(totalSamples * 2);
  let phase = 0;
  let heartRateBpm = 120;

  for (let i = 0; i < totalSamples; i += 1) {
    heartRateBpm += (Math.random() - 0.5) * 0.2;
    if (heartRateBpm < 80) heartRateBpm = 80;
    if (heartRateBpm > 180) heartRateBpm = 180;

    const phaseStep =
      (2 * Math.PI * (heartRateBpm / 60)) / sampleRateHz;
    const t = phase / (2 * Math.PI);
    const ecg = syntheticEcg(t);
    phase += phaseStep;
    if (phase >= 2 * Math.PI) {
      phase -= 2 * Math.PI;
    }

    const noise =
      Math.floor(Math.random() * (noiseAmplitude * 2 + 1)) -
      noiseAmplitude;
    let value = Math.round(amplitude * ecg + noise);

    if (value > 32767) value = 32767;
    if (value < -32768) value = -32768;

    const unsigned = value < 0 ? 0x10000 + value : value;
    const index = i * 2;
    bytes[index] = unsigned & 0xff;
    bytes[index + 1] = (unsigned >> 8) & 0xff;
  }

  return bytes;
}

export const ECG_SAMPLES_PER_PACKET = 25;
export const ECG_PACKET_BYTES =
  (1 + ECG_SAMPLES_PER_PACKET * 3) * 3;

const ADS1298_DEFAULT_VREF = 2.4;
const ADS1298_DEFAULT_GAIN = 6;
const ADS1298_MAX_CODE = Math.pow(2, 23) - 1;

export function read24SignedBE(bytes: Uint8Array, offset: number): number {
  const value =
    (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
  return value & 0x800000 ? value | 0xff000000 : value;
}

export function countsToMillivolts(
  count: number,
  vref: number = ADS1298_DEFAULT_VREF,
  gain: number = ADS1298_DEFAULT_GAIN,
): number {
  const volts = (count / ADS1298_MAX_CODE) * (vref / gain);
  return volts * 1000;
}

export type EcgChannelsMv = {
  status: number;
  ch2: number[];
  ch3: number[];
  ch4: number[];
};

export function decodeEcgPacketToChannelsMv(
  packet: Uint8Array,
): EcgChannelsMv | null {
  if (packet.length < ECG_PACKET_BYTES) return null;

  let offset = 0;
  const status = read24SignedBE(packet, offset);
  offset += 3;

  const ch2 = new Array<number>(ECG_SAMPLES_PER_PACKET);
  const ch3 = new Array<number>(ECG_SAMPLES_PER_PACKET);
  const ch4 = new Array<number>(ECG_SAMPLES_PER_PACKET);

  for (let i = 0; i < ECG_SAMPLES_PER_PACKET; i += 1) {
    const count = read24SignedBE(packet, offset);
    ch2[i] = countsToMillivolts(count);
    offset += 3;
  }
  for (let i = 0; i < ECG_SAMPLES_PER_PACKET; i += 1) {
    const count = read24SignedBE(packet, offset);
    ch3[i] = countsToMillivolts(count);
    offset += 3;
  }
  for (let i = 0; i < ECG_SAMPLES_PER_PACKET; i += 1) {
    const count = read24SignedBE(packet, offset);
    ch4[i] = countsToMillivolts(count);
    offset += 3;
  }

  return { status, ch2, ch3, ch4 };
}

export function buildChannelsCsvFromPackets(
  packets: Uint8Array[],
): { csv: string; rows: number; invalidPackets: number } {
  const rows: string[] = ["index,ch2,ch3,ch4"];
  let rowIndex = 1;
  let invalidPackets = 0;

  for (const packet of packets) {
    const decoded = decodeEcgPacketToChannelsMv(packet);
    if (!decoded) {
      invalidPackets += 1;
      continue;
    }
    for (let i = 0; i < decoded.ch2.length; i += 1) {
      rows.push(
        `${rowIndex},${decoded.ch2[i].toFixed(6)},${decoded.ch3[i].toFixed(6)},${decoded.ch4[i].toFixed(6)}`,
      );
      rowIndex += 1;
    }
  }

  return { csv: rows.join("\n"), rows: rowIndex - 1, invalidPackets };
}
