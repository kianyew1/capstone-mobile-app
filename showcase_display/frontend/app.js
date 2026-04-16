const ECG_SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab";
const ECG_CHARACTERISTIC_UUID = "87654321-4321-4321-4321-abcdefabcdef";
const PACKET_BYTES = 231;
const SAMPLE_RATE_HZ = 500;
const VISIBLE_SAMPLES = 2500;
const DISPLAY_LAG_SAMPLES = 500;
const STALL_TIMEOUT_MS = 3000;
const PACKETS_PER_UPLOAD = 20; // 20 * 25 samples = 500 samples
const MIN_PACKET_INTERVAL_MS = 10;
const MODAL_VISIBLE_MS = 8000;
const CONNECT_RETRY_COUNT = 3;
let fixedYLimitMv = 0.5;

const connectButton = document.getElementById("connect-button");
const connectionChip = document.getElementById("connection-chip");
const contactDebugEl = document.getElementById("contact-debug");
const captureCountdownEl = document.getElementById("capture-countdown");
const captureProgressValueEl = document.getElementById("capture-progress-value");
const captureProgressFillEl = document.getElementById("capture-progress-fill");
const disconnectOverlay = document.getElementById("disconnect-overlay");
const contactOverlay = document.getElementById("contact-overlay");
const pauseOverlay = document.getElementById("pause-overlay");
const stdMinInput = document.getElementById("std-min-input");
const stdMaxInput = document.getElementById("std-max-input");
const absMeanMaxInput = document.getElementById("abs-mean-max-input");
const scaleSlider = document.getElementById("scale-slider");
const scaleValueEl = document.getElementById("scale-value");
const captureLengthInputs = Array.from(document.querySelectorAll('input[name="capture-length"]'));
const resultModal = document.getElementById("result-modal");
const resultTitle = document.getElementById("result-title");
const resultSubtitle = document.getElementById("result-subtitle");
const resultCountdown = document.getElementById("result-countdown");
const rawResultCanvas = document.getElementById("raw-result-canvas");
const stackResultCanvas = document.getElementById("stack-result-canvas");
const meanResultCanvas = document.getElementById("mean-result-canvas");
const canvas = document.getElementById("live-canvas");
const ctx = canvas.getContext("2d");

function logBle(message, details = undefined) {
  if (!window.SHOWCASE_DEBUG) {
    return;
  }
  console.log(`[BLE] ${message}`, details ?? "");
}

const state = {
  device: null,
  characteristic: null,
  connected: false,
  packetsPendingUpload: [],
  previewCh2: [],
  totalSamplesReceived: 0,
  totalPacketsReceived: 0,
  lastPacketAt: 0,
  stallIntervalId: 0,
  uploading: false,
  skippedWarmupPacket: false,
  lastNotificationPayloadHex: null,
  lastNotificationAtMs: 0,
  lastShownAnalysisId: 0,
  modalTimerId: 0,
  modalCountdownId: 0,
  captureTargetSeconds: 20,
  paused: false,
};

function setConnectionState(mode, label) {
  connectionChip.dataset.state = mode;
  connectionChip.textContent = label;
}

function setControlValue(input, value) {
  if (input && document.activeElement !== input) {
    input.value = value;
  }
}

function clearFrontendState() {
  state.packetsPendingUpload = [];
  state.previewCh2 = [];
  state.totalSamplesReceived = 0;
  state.totalPacketsReceived = 0;
  state.lastPacketAt = 0;
  state.uploading = false;
  state.skippedWarmupPacket = false;
  state.lastNotificationPayloadHex = null;
  state.lastNotificationAtMs = 0;
  state.paused = false;
  pauseOverlay?.classList.remove("visible");
  updateCaptureProgress(0, 'Waiting for electrodes');
}

function updateCaptureProgress(seconds, label, totalSeconds = state.captureTargetSeconds) {
  const targetSeconds = Math.max(1, Number(totalSeconds) || 20);
  const safeSeconds = Math.max(0, Math.min(targetSeconds, Number(seconds) || 0));
  const percent = (safeSeconds / targetSeconds) * 100;
  captureCountdownEl.textContent = label;
  if (captureProgressValueEl) captureProgressValueEl.textContent = `${safeSeconds.toFixed(1)}s / ${targetSeconds.toFixed(1)}s`;
  if (captureProgressFillEl) captureProgressFillEl.style.width = `${percent.toFixed(1)}%`;
}

async function setPaused(paused) {
  state.paused = paused;
  pauseOverlay?.classList.toggle("visible", paused);
  if (paused) {
    contactOverlay.classList.remove("visible");
    updateCaptureProgress(0, "Paused");
  }
  await updateConfig({ paused });
}

function drawChart(samples) {
  const width = canvas.width;
  const height = canvas.height;
  const margin = { top: 22, right: 24, bottom: 76, left: 86 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#f7fbfd';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(121, 147, 167, 0.18)';
  ctx.lineWidth = 1;
  const xTicks = 8;
  for (let index = 0; index <= xTicks; index += 1) {
    const x = margin.left + (plotWidth / xTicks) * index;
    ctx.beginPath();
    ctx.moveTo(x, margin.top);
    ctx.lineTo(x, margin.top + plotHeight);
    ctx.stroke();
  }

  const yMin = -fixedYLimitMv;
  const yMax = fixedYLimitMv;
  const clippedSamples = samples.map((value) =>
    Math.max(yMin, Math.min(yMax, value)),
  );
  const hasClipping = samples.some((value) => value < yMin || value > yMax);

  const span = yMax - yMin || 1;
  const yTicks = [];
  for (let index = 0; index < 5; index += 1) {
    yTicks.push(yMin + ((yMax - yMin) * index) / 4);
  }
  for (const tick of yTicks) {
    const y = margin.top + plotHeight - ((tick - yMin) / span) * plotHeight;
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + plotWidth, y);
    ctx.stroke();
  }

  const zeroY = margin.top + plotHeight - ((0 - yMin) / span) * plotHeight;
  ctx.strokeStyle = 'rgba(16, 71, 111, 0.34)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(margin.left, zeroY);
  ctx.lineTo(margin.left + plotWidth, zeroY);
  ctx.stroke();

  ctx.fillStyle = '#6d8395';
  ctx.font = '13px Segoe UI';
  for (let index = 0; index <= xTicks; index += 1) {
    const x = margin.left + (plotWidth / xTicks) * index;
    const seconds = (VISIBLE_SAMPLES / SAMPLE_RATE_HZ) * (index / xTicks);
    ctx.fillText(`${seconds.toFixed(1)}s`, x - 12, margin.top + plotHeight + 24);
  }
  for (const tick of yTicks) {
    const y = margin.top + plotHeight - ((tick - yMin) / span) * plotHeight;
    ctx.fillText(`${tick.toFixed(2)} mV`, 8, y + 4);
  }

  ctx.fillStyle = '#6d8395';
  ctx.font = '14px Segoe UI';
  ctx.textAlign = 'center';
  ctx.fillText(`Displayed rolling window (latest ${VISIBLE_SAMPLES} samples)`, margin.left + plotWidth / 2, height - 8);
  ctx.textAlign = 'start';

  if (!samples.length) {
    ctx.fillStyle = '#6d8395';
    ctx.font = '16px Segoe UI';
    ctx.fillText('Waiting for live data...', margin.left, margin.top + plotHeight / 2);
    return;
  }

  if (hasClipping) {
    ctx.fillStyle = '#9d2f2f';
    ctx.font = '700 12px Segoe UI';
    ctx.fillText('CLIPPED', width - 88, margin.top + 2);
  }

  ctx.strokeStyle = '#0d697a';
  ctx.lineWidth = 1.35;
  ctx.beginPath();
  clippedSamples.forEach((value, index) => {
    const x = margin.left + (plotWidth * index) / Math.max(clippedSamples.length - 1, 1);
    const y = margin.top + plotHeight - ((value - yMin) / span) * plotHeight;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
}

function finiteValues(values) {
  return (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
}

function drawLineChart(targetCanvas, seriesList, options = {}) {
  const targetCtx = targetCanvas.getContext("2d");
  const width = targetCanvas.width;
  const height = targetCanvas.height;
  const margin = { top: 42, right: 22, bottom: 42, left: 62 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const allY = seriesList.flatMap((series) => finiteValues(series.y));
  const yAbs = Math.max(options.yLimit || 0, ...allY.map((value) => Math.abs(value)), 0.02);
  const yMin = options.yMin ?? -yAbs * 1.12;
  const yMax = options.yMax ?? yAbs * 1.12;
  const span = yMax - yMin || 1;
  const xValues = finiteValues(options.x || []);
  const fallbackLength = Math.max(...seriesList.map((series) => series.y?.length || 0), 1);
  const xMin = options.xMin ?? (xValues.length ? Math.min(...xValues) : 0);
  const xMax = options.xMax ?? (xValues.length ? Math.max(...xValues) : fallbackLength - 1);
  const xSpan = xMax - xMin || 1;

  targetCtx.clearRect(0, 0, width, height);
  targetCtx.fillStyle = "#f7fbfd";
  targetCtx.fillRect(0, 0, width, height);

  targetCtx.strokeStyle = "rgba(121, 147, 167, 0.18)";
  targetCtx.lineWidth = 1;
  for (let index = 0; index <= 5; index += 1) {
    const x = margin.left + (plotWidth / 5) * index;
    targetCtx.beginPath();
    targetCtx.moveTo(x, margin.top);
    targetCtx.lineTo(x, margin.top + plotHeight);
    targetCtx.stroke();
    const y = margin.top + (plotHeight / 4) * Math.min(index, 4);
    if (index <= 4) {
      targetCtx.beginPath();
      targetCtx.moveTo(margin.left, y);
      targetCtx.lineTo(margin.left + plotWidth, y);
      targetCtx.stroke();
    }
  }

  const zeroY = margin.top + plotHeight - ((0 - yMin) / span) * plotHeight;
  targetCtx.strokeStyle = "rgba(16, 71, 111, 0.28)";
  targetCtx.beginPath();
  targetCtx.moveTo(margin.left, zeroY);
  targetCtx.lineTo(margin.left + plotWidth, zeroY);
  targetCtx.stroke();

  targetCtx.fillStyle = "#173049";
  targetCtx.font = "700 15px Segoe UI";
  targetCtx.fillText(options.title || "", margin.left, 22);
  targetCtx.fillStyle = "#6d8395";
  targetCtx.font = "12px Segoe UI";
  targetCtx.fillText(`${xMin.toFixed(2)}s`, margin.left, height - 12);
  targetCtx.fillText(`${xMax.toFixed(2)}s`, margin.left + plotWidth - 34, height - 12);
  targetCtx.fillText(`${yMax.toFixed(2)} mV`, 8, margin.top + 5);
  targetCtx.fillText(`${yMin.toFixed(2)} mV`, 8, margin.top + plotHeight);

  for (const series of seriesList) {
    const y = Array.isArray(series.y) ? series.y : [];
    if (!y.length) continue;
    targetCtx.strokeStyle = series.color || "#0d697a";
    targetCtx.globalAlpha = series.alpha ?? 1;
    targetCtx.lineWidth = series.width || 1.4;
    targetCtx.beginPath();
    let hasStarted = false;
    for (let index = 0; index < y.length; index += 1) {
      const value = y[index];
      if (!Number.isFinite(value)) continue;
      const xValue = Array.isArray(series.x) && Number.isFinite(series.x[index])
        ? series.x[index]
        : Array.isArray(options.x) && Number.isFinite(options.x[index])
          ? options.x[index]
          : index;
      const x = margin.left + ((xValue - xMin) / xSpan) * plotWidth;
      const yPixel = margin.top + plotHeight - ((value - yMin) / span) * plotHeight;
      if (!hasStarted) {
        targetCtx.moveTo(x, yPixel);
        hasStarted = true;
      } else {
        targetCtx.lineTo(x, yPixel);
      }
    }
    targetCtx.stroke();
    targetCtx.globalAlpha = 1;
  }
}

function drawAnalysisModal(analysis) {
  if (analysis?.error) {
    resultTitle.textContent = "CH2 summary could not be computed";
    resultSubtitle.textContent = analysis.error;
  } else {
    resultTitle.textContent = `Participant CH2 summary · ${Number(analysis.average_bpm || 0).toFixed(1)} BPM`;
    resultSubtitle.textContent = `${analysis.kept_beat_count || 0} / ${analysis.raw_beat_count || 0} beats kept after standard-deviation filtering.`;
  }

  drawLineChart(
    rawResultCanvas,
    [{ y: analysis.raw_signal || [], x: analysis.raw_axis || [], color: "#0d697a", width: 1.1 }],
    { title: "Raw 20-second CH2 signal", x: analysis.raw_axis || [], yLimit: fixedYLimitMv },
  );

  const beatStack = Array.isArray(analysis.beat_stack) ? analysis.beat_stack : [];
  drawLineChart(
    stackResultCanvas,
    beatStack.map((beat) => ({ y: beat, x: analysis.epoch_axis || [], color: "#8a61b8", alpha: 0.28, width: 1 })),
    { title: "Segmented beats from CH2 R-peaks", x: analysis.epoch_axis || [] },
  );

  drawLineChart(
    meanResultCanvas,
    [{ y: analysis.mean_beat || [], x: analysis.epoch_axis || [], color: "#d13f3f", width: 2.4 }],
    { title: `Representative mean beat · ${Number(analysis.average_bpm || 0).toFixed(1)} BPM`, x: analysis.epoch_axis || [] },
  );
}

async function resetCaptureCycle() {
  try {
    const response = await fetch("/api/ch2/reset_cycle", { method: "POST" });
    const snapshot = await response.json();
    updateUiFromSnapshot(snapshot);
  } catch (error) {
    console.error("Failed to reset capture cycle", error);
  }
}

function showResultModal(analysis) {
  window.clearTimeout(state.modalTimerId);
  window.clearInterval(state.modalCountdownId);
  drawAnalysisModal(analysis);
  resultModal.classList.add("visible");
  resultModal.setAttribute("aria-hidden", "false");
  let secondsRemaining = 8;
  resultCountdown.textContent = `${secondsRemaining}s`;
  state.modalCountdownId = window.setInterval(() => {
    secondsRemaining -= 1;
    resultCountdown.textContent = `${Math.max(0, secondsRemaining)}s`;
  }, 1000);
  state.modalTimerId = window.setTimeout(async () => {
    window.clearInterval(state.modalCountdownId);
    resultModal.classList.remove("visible");
    resultModal.setAttribute("aria-hidden", "true");
    await resetCaptureCycle();
  }, MODAL_VISIBLE_MS);
}

function updateUiFromSnapshot(snapshot) {
  state.previewCh2 = Array.isArray(snapshot?.channels?.CH2) ? snapshot.channels.CH2 : [];
  state.totalSamplesReceived = Number(snapshot?.total_samples_received || 0);
  state.totalPacketsReceived = Number(snapshot?.total_packets_received || 0);
  if (Number.isFinite(Number(snapshot?.y_limit_mv))) {
    fixedYLimitMv = Number(snapshot.y_limit_mv);
    setControlValue(scaleSlider, fixedYLimitMv.toFixed(2));
    if (scaleValueEl) scaleValueEl.textContent = `±${fixedYLimitMv.toFixed(2)} mV`;
  }
  if (Number.isFinite(Number(snapshot?.contact_std_min_mv))) {
    setControlValue(stdMinInput, Number(snapshot.contact_std_min_mv).toFixed(3));
  }
  if (Number.isFinite(Number(snapshot?.contact_std_max_mv))) {
    setControlValue(stdMaxInput, Number(snapshot.contact_std_max_mv).toFixed(3));
  }
  if (Number.isFinite(Number(snapshot?.contact_abs_mean_max_mv))) {
    setControlValue(absMeanMaxInput, Number(snapshot.contact_abs_mean_max_mv).toFixed(1));
  }
  if (Number.isFinite(Number(snapshot?.capture_target_seconds))) {
    state.captureTargetSeconds = Number(snapshot.capture_target_seconds);
    for (const input of captureLengthInputs) {
      input.checked = Number(input.value) === state.captureTargetSeconds;
    }
  }
  if (typeof snapshot?.paused === "boolean") {
    state.paused = snapshot.paused;
    pauseOverlay?.classList.toggle("visible", state.paused);
  }
  if (contactDebugEl) {
    const std = Number(snapshot?.contact_std_mv || 0);
    const stdMin = Number(snapshot?.contact_std_min_mv || 0);
    const stdMax = Number(snapshot?.contact_std_max_mv || 0);
    const absMean = Number(snapshot?.contact_abs_mean_mv || 0);
    const absMeanMax = Number(snapshot?.contact_abs_mean_max_mv || 0);
    contactDebugEl.textContent = `std ${std.toFixed(6)} in [${stdMin.toFixed(6)}, ${stdMax.toFixed(6)}] mV · |mean| ${absMean.toFixed(6)} / ${absMeanMax.toFixed(6)} mV`;
  }

  const displayEnd = Math.max(0, state.previewCh2.length - DISPLAY_LAG_SAMPLES);
  const displayStart = Math.max(0, displayEnd - VISIBLE_SAMPLES);
  const displayedSamples = state.previewCh2.slice(displayStart, displayEnd);
  if (!state.paused) {
    drawChart(displayedSamples);
  }

  if (state.paused) {
    contactOverlay.classList.remove("visible");
    updateCaptureProgress(0, "Paused");
  } else if (snapshot?.capture_status === "analyzing") {
    contactOverlay.classList.remove("visible");
    updateCaptureProgress(state.captureTargetSeconds, "Computing CH2 summary...");
  } else if (state.connected && snapshot?.capture_status !== "ready") {
    if (snapshot?.contact_detected) {
      contactOverlay.classList.remove("visible");
      const captured = Number(snapshot?.capture_seconds || 0);
      updateCaptureProgress(captured, "Stay connected");
    } else {
      contactOverlay.classList.add("visible");
      updateCaptureProgress(0, "Connect LA RA RL");
    }
  } else {
    contactOverlay.classList.remove("visible");
    updateCaptureProgress(
      snapshot?.capture_status === "ready" ? state.captureTargetSeconds : 0,
      snapshot?.capture_status === "ready" ? `${state.captureTargetSeconds}s capture complete` : "Waiting for electrodes",
    );
  }

  const analysis = snapshot?.analysis_result;
  const analysisId = Number(analysis?.analysis_id || 0);
  if (analysis && analysisId && analysisId !== state.lastShownAnalysisId) {
    state.lastShownAnalysisId = analysisId;
    showResultModal(analysis);
  }
}

async function fetchHealthSnapshot() {
  try {
    const response = await fetch('/api/health');
    const snapshot = await response.json();
    if (response.ok && snapshot.ok) {
      updateUiFromSnapshot(snapshot);
    }
  } catch (error) {
    if (window.SHOWCASE_DEBUG) console.warn('[LIVE] health snapshot failed', error);
  }
}

async function resetCsv() {
  const response = await fetch('/api/ch2/reset', { method: 'POST' });
  const snapshot = await response.json();
  updateUiFromSnapshot(snapshot);
}

async function updateConfig(patch) {
  try {
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const snapshot = await response.json();
    if (!response.ok || !snapshot.ok) {
      throw new Error(snapshot.error || "Config update failed");
    }
    updateUiFromSnapshot(snapshot);
  } catch (error) {
    console.error("Failed to update showcase config", error);
  }
}

function bytesToHex(uint8) {
  return Array.from(uint8, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function flushPendingPackets() {
  if (state.uploading || state.packetsPendingUpload.length < PACKETS_PER_UPLOAD) {
    return;
  }
  state.uploading = true;
  const packets = state.packetsPendingUpload.splice(0, PACKETS_PER_UPLOAD);
  try {
    const response = await fetch('/api/ch2/packets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_name: state.device?.name || null,
        packets,
      }),
    });
    const snapshot = await response.json();
    if (!response.ok || !snapshot.ok) {
      throw new Error(snapshot.error || 'Failed to ingest packets');
    }
    updateUiFromSnapshot(snapshot);
  } catch (error) {
    console.error('Failed to upload packet batch', error);
  } finally {
    state.uploading = false;
    if (state.packetsPendingUpload.length >= PACKETS_PER_UPLOAD) {
      void flushPendingPackets();
    }
  }
}

function handleNotification(event) {
  const value = event.target.value;
  if (!value || value.byteLength <= 0 || value.byteLength % PACKET_BYTES !== 0) {
    console.warn('Unexpected packet length', value?.byteLength);
    return;
  }
  const packetBytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  const payloadHex = bytesToHex(packetBytes);
  const now = performance.now();
  if (
    state.lastNotificationPayloadHex === payloadHex &&
    now - state.lastNotificationAtMs < MIN_PACKET_INTERVAL_MS
  ) {
    return;
  }
  state.lastNotificationPayloadHex = payloadHex;
  state.lastNotificationAtMs = now;
  state.lastPacketAt = now;

  if (!state.skippedWarmupPacket) {
    state.skippedWarmupPacket = true;
    return;
  }

  for (let offset = 0; offset < packetBytes.length; offset += PACKET_BYTES) {
    const packet = packetBytes.subarray(offset, offset + PACKET_BYTES);
    state.packetsPendingUpload.push(bytesToHex(packet));
  }
  void flushPendingPackets();
}

async function handleDisconnect(reason = 'Bluetooth disconnected') {
  if (state.characteristic) {
    state.characteristic.removeEventListener('characteristicvaluechanged', handleNotification);
  }
  if (state.device) {
    state.device.removeEventListener('gattserverdisconnected', onGattDisconnected);
  }
  state.device = null;
  state.characteristic = null;
  state.connected = false;
  setConnectionState('disconnected', 'Disconnected');
  disconnectOverlay.classList.add('visible');
  contactOverlay.classList.remove('visible');
  connectButton.disabled = false;
  connectButton.textContent = 'Connect Device';
  clearFrontendState();
  drawChart([]);
  try {
    await resetCsv();
  } catch (error) {
    console.error('Failed to reset CSV after disconnect', error);
  }
}

function onGattDisconnected() {
  void handleDisconnect('Bluetooth disconnected');
}

function startStallMonitor() {
  window.clearInterval(state.stallIntervalId);
  state.stallIntervalId = window.setInterval(() => {
    if (!state.connected || !state.lastPacketAt) {
      return;
    }
    void fetchHealthSnapshot();
    if (performance.now() - state.lastPacketAt > STALL_TIMEOUT_MS) {
      void handleDisconnect('Signal stream timed out');
    }
  }, 1000);
}

async function connectGattWithRetries(device) {
  let lastError = null;
  for (let attempt = 1; attempt <= CONNECT_RETRY_COUNT; attempt += 1) {
    try {
      logBle(`GATT connect attempt ${attempt}/${CONNECT_RETRY_COUNT}`, device.name || device.id);
      setConnectionState('connecting', `Connecting ${attempt}/${CONNECT_RETRY_COUNT}...`);
      connectButton.textContent = `Connecting ${attempt}/${CONNECT_RETRY_COUNT}...`;

      const server = await device.gatt.connect();
      if (!device.gatt.connected) {
        throw new Error('GATT disconnected immediately after connect');
      }

      logBle('GATT connected. Retrieving ECG service...');
      const service = await server.getPrimaryService(ECG_SERVICE_UUID);
      logBle('ECG service found. Retrieving notify characteristic...');
      const characteristic = await service.getCharacteristic(ECG_CHARACTERISTIC_UUID);
      logBle('ECG characteristic found.');
      return { server, service, characteristic };
    } catch (error) {
      lastError = error;
      console.error(`[BLE] GATT setup attempt ${attempt} failed`, error);
      try {
        if (device.gatt?.connected) {
          device.gatt.disconnect();
        }
      } catch (disconnectError) {
        console.warn('[BLE] disconnect after failed attempt also failed', disconnectError);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700 * attempt));
    }
  }
  throw lastError || new Error('Bluetooth GATT setup failed');
}

async function connectBluetooth() {
  logBle('connectBluetooth start');
  connectButton.disabled = true;
  setConnectionState('connecting', 'Connecting...');
  connectButton.textContent = 'Connecting...';

  try {
    logBle('opening browser Bluetooth picker');
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [ECG_SERVICE_UUID],
    });
    await resetCsv();
    clearFrontendState();

    logBle('device selected', { name: device.name, id: device.id });
    const { characteristic } = await connectGattWithRetries(device);
    await characteristic.startNotifications();
    logBle('notifications started');
    characteristic.addEventListener('characteristicvaluechanged', handleNotification);
    device.addEventListener('gattserverdisconnected', onGattDisconnected);

    state.device = device;
    state.characteristic = characteristic;
    state.connected = true;
    state.lastPacketAt = performance.now();
    setConnectionState('connected', 'Connected');
    connectButton.textContent = 'Connected';
    disconnectOverlay.classList.remove('visible');
    contactOverlay.classList.add('visible');
    updateCaptureProgress(0, 'Connect LA RA RL');
    startStallMonitor();
  } catch (error) {
    console.error(error);
    await handleDisconnect(error?.message || 'Connection failed');
  }
}

connectButton.addEventListener('click', async () => {
  logBle('connect button clicked', {
    connected: state.connected,
    bluetoothAvailable: Boolean(navigator.bluetooth),
  });
  if (!navigator.bluetooth) {
    window.alert('Web Bluetooth is not available in this browser. Use Chrome or Edge on localhost.');
    return;
  }
  if (!state.connected) {
    await connectBluetooth();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.code !== "Space") return;
  const target = event.target;
  const isTyping = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
  if (isTyping) return;
  event.preventDefault();
  void setPaused(!state.paused);
});

stdMinInput?.addEventListener("change", () => {
  const value = Number(stdMinInput.value);
  if (Number.isFinite(value)) {
    void updateConfig({ contact_std_min_mv: value });
  }
});

stdMaxInput?.addEventListener("change", () => {
  const value = Number(stdMaxInput.value);
  if (Number.isFinite(value)) {
    void updateConfig({ contact_std_max_mv: value });
  }
});

absMeanMaxInput?.addEventListener("change", () => {
  const value = Number(absMeanMaxInput.value);
  if (Number.isFinite(value)) {
    void updateConfig({ contact_abs_mean_max_mv: value });
  }
});

for (const input of captureLengthInputs) {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    const value = Number(input.value);
    if (Number.isFinite(value)) {
      state.captureTargetSeconds = value;
      updateCaptureProgress(0, "Waiting for electrodes", value);
      void updateConfig({ capture_target_seconds: value });
    }
  });
}

scaleSlider?.addEventListener("input", () => {
  fixedYLimitMv = Number(scaleSlider.value);
  scaleValueEl.textContent = `±${fixedYLimitMv.toFixed(2)} mV`;
  drawChart(state.previewCh2.slice(Math.max(0, state.previewCh2.length - DISPLAY_LAG_SAMPLES - VISIBLE_SAMPLES), Math.max(0, state.previewCh2.length - DISPLAY_LAG_SAMPLES)));
});

scaleSlider?.addEventListener("change", () => {
  const value = Number(scaleSlider.value);
  if (Number.isFinite(value)) {
    void updateConfig({ y_limit_mv: value });
  }
});

disconnectOverlay.classList.add('visible');
drawChart([]);
