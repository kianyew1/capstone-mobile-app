const ECG_SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab";
const ECG_CHARACTERISTIC_UUID = "87654321-4321-4321-4321-abcdefabcdef";
const PACKET_BYTES = 231;
const SAMPLE_RATE_HZ = 500;
const VISIBLE_SAMPLES = 2500;
const DISPLAY_LAG_SAMPLES = 500;
const STALL_TIMEOUT_MS = 3000;
const PACKETS_PER_UPLOAD = 20; // 20 * 25 samples = 500 samples
const MIN_PACKET_INTERVAL_MS = 10;
const FIXED_Y_LIMIT_MV = 0.15;

const connectButton = document.getElementById("connect-button");
const connectionChip = document.getElementById("connection-chip");
const deviceNameEl = document.getElementById("device-name");
const samplesReceivedEl = document.getElementById("samples-received");
const chartMetaEl = document.getElementById("chart-meta");
const disconnectOverlay = document.getElementById("disconnect-overlay");
const canvas = document.getElementById("live-canvas");
const ctx = canvas.getContext("2d");

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
};

function setConnectionState(mode, label) {
  connectionChip.dataset.state = mode;
  connectionChip.textContent = label;
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
  samplesReceivedEl.textContent = '0';
  chartMetaEl.textContent = 'Waiting for signal...';
}

function drawChart(samples) {
  const width = canvas.width;
  const height = canvas.height;
  const margin = { top: 22, right: 24, bottom: 50, left: 86 };
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

  const yMin = -FIXED_Y_LIMIT_MV;
  const yMax = FIXED_Y_LIMIT_MV;
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
    ctx.fillText(`${seconds.toFixed(1)}s`, x - 12, height - 14);
  }
  for (const tick of yTicks) {
    const y = margin.top + plotHeight - ((tick - yMin) / span) * plotHeight;
    ctx.fillText(`${tick.toFixed(2)} mV`, 8, y + 4);
  }

  ctx.save();
  ctx.translate(22, height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#6d8395';
  ctx.font = '14px Segoe UI';
  ctx.fillText('Amplitude (mV)', 0, 0);
  ctx.restore();

  ctx.fillStyle = '#6d8395';
  ctx.font = '14px Segoe UI';
  ctx.fillText('Displayed rolling window (latest 1500 samples)', margin.left, height - 14);

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

function updateUiFromSnapshot(snapshot) {
  state.previewCh2 = Array.isArray(snapshot?.channels?.CH2) ? snapshot.channels.CH2 : [];
  state.totalSamplesReceived = Number(snapshot?.total_samples_received || 0);
  state.totalPacketsReceived = Number(snapshot?.total_packets_received || 0);
  samplesReceivedEl.textContent = state.totalSamplesReceived.toLocaleString();
  chartMetaEl.textContent = `${Math.min(state.previewCh2.length, VISIBLE_SAMPLES).toLocaleString()} displayed · ${state.previewCh2.length.toLocaleString()} buffered · ${state.totalPacketsReceived.toLocaleString()} packets`;
  const displayEnd = Math.max(0, state.previewCh2.length - DISPLAY_LAG_SAMPLES);
  const displayStart = Math.max(0, displayEnd - VISIBLE_SAMPLES);
  const displayedSamples = state.previewCh2.slice(displayStart, displayEnd);
  drawChart(displayedSamples);
}

async function resetCsv() {
  const response = await fetch('/api/ch2/reset', { method: 'POST' });
  const snapshot = await response.json();
  updateUiFromSnapshot(snapshot);
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
  deviceNameEl.textContent = reason;
  setConnectionState('disconnected', 'Disconnected');
  disconnectOverlay.classList.add('visible');
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
    if (performance.now() - state.lastPacketAt > STALL_TIMEOUT_MS) {
      void handleDisconnect('Signal stream timed out');
    }
  }, 1000);
}

async function connectBluetooth() {
  connectButton.disabled = true;
  setConnectionState('connecting', 'Connecting...');
  connectButton.textContent = 'Connecting...';

  try {
    await resetCsv();
    clearFrontendState();

    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [ECG_SERVICE_UUID],
    });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(ECG_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(ECG_CHARACTERISTIC_UUID);
    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', handleNotification);
    device.addEventListener('gattserverdisconnected', onGattDisconnected);

    state.device = device;
    state.characteristic = characteristic;
    state.connected = true;
    state.lastPacketAt = performance.now();
    deviceNameEl.textContent = device.name || 'Unnamed ECG device';
    setConnectionState('connected', 'Connected');
    connectButton.textContent = 'Connected';
    disconnectOverlay.classList.remove('visible');
    startStallMonitor();
  } catch (error) {
    console.error(error);
    await handleDisconnect(error?.message || 'Connection failed');
  }
}

connectButton.addEventListener('click', async () => {
  if (!navigator.bluetooth) {
    window.alert('Web Bluetooth is not available in this browser. Use Chrome or Edge on localhost.');
    return;
  }
  if (!state.connected) {
    await connectBluetooth();
  }
});

disconnectOverlay.classList.add('visible');
drawChart([]);
