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

export const ECG_SAMPLES_PER_PACKET = 25;
export const ECG_PACKET_BYTES =
  (1 + ECG_SAMPLES_PER_PACKET * 3) * 3;
