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
