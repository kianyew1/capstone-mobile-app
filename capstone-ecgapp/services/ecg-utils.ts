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

export const ECG_STATUS_BYTES = 3;
export const ECG_TIMESTAMP_BYTES = 3;
export const ECG_BYTES_PER_SAMPLE = 3;
export const ECG_CHANNELS = 3;
export const ECG_SAMPLES_PER_PACKET = 25;
export const ECG_PACKET_BYTES =
  ECG_STATUS_BYTES +
  ECG_TIMESTAMP_BYTES +
  ECG_BYTES_PER_SAMPLE * ECG_SAMPLES_PER_PACKET * ECG_CHANNELS;
