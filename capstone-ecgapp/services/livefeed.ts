import { BACKEND_BASE_URL } from "@/config/runtime-config";

const LIVEFEED_BATCH_SAMPLES = 250;
const LIVEFEED_SAMPLE_RATE_HZ = 500;

let queue: number[] = [];
let sending = false;

const sendBatch = async (batch: number[]) => {
  if (!BACKEND_BASE_URL) return;
  const url = `${BACKEND_BASE_URL}/livefeed/ingest`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      samples_mv: batch,
      sample_rate_hz: LIVEFEED_SAMPLE_RATE_HZ,
    }),
  });
};

const flushQueue = async () => {
  if (sending) return;
  sending = true;
  try {
    while (queue.length >= LIVEFEED_BATCH_SAMPLES) {
      const batch = queue.splice(0, LIVEFEED_BATCH_SAMPLES);
      try {
        await sendBatch(batch);
      } catch (error) {
        console.warn("[LIVEFEED] failed to push samples", error);
        // Put samples back at the front and stop for now.
        queue = batch.concat(queue);
        break;
      }
    }
  } finally {
    sending = false;
  }
};

export const enqueueLivefeedSamples = (samples: number[]) => {
  if (!samples.length) return;
  queue.push(...samples);
  void flushQueue();
};

export const resetLivefeedQueue = () => {
  queue = [];
  sending = false;
};
