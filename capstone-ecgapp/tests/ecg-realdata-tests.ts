import { Buffer } from "buffer";
import { State } from "react-native-ble-plx";
import { getBleManager } from "@/features-from-other-repo/ble-stream/bleService";
import { decodeEcgPayload, type DecodedPacket } from "@/services/ecg-packet";
import { EcgRecorder } from "@/services/ecg-recorder";
import { exportScratchSessionPayload } from "@/services/ecg-export";
import { validateCalibration } from "@/services/ecg-calibration";
import { listScratchChunks, clearScratch } from "@/services/ecg-db";

export interface RealDataTestOptions {
  deviceId?: string;
  durationSeconds?: number;
}

export interface RealDataTestResult {
  name: string;
  ok: boolean;
  details?: string;
}

const DEFAULT_DURATION_SECONDS = 20;

export async function runRealDataPhaseTests(
  options: RealDataTestOptions,
  onProgress?: (message: string) => void,
  onResult?: (result: RealDataTestResult) => void,
): Promise<RealDataTestResult[]> {
  const results: RealDataTestResult[] = [];
  const push = (result: RealDataTestResult) => {
    results.push(result);
    onResult?.(result);
  };
  const deviceId = options.deviceId;
  const durationSeconds = options.durationSeconds ?? DEFAULT_DURATION_SECONDS;
  const serviceUUID =
    process.env.EXPO_PUBLIC_ECG_SERVICE_UUID ??
    "12345678-1234-1234-1234-1234567890ab";
  const characteristicUUID =
    process.env.EXPO_PUBLIC_ECG_CHARACTERISTIC_UUID ??
    "87654321-4321-4321-4321-abcdefabcdef";
  const apiUrl = process.env.EXPO_PUBLIC_CALIBRATION_API_URL ?? null;

  if (!deviceId) {
    onProgress?.("No connected device id.");
    return [
      {
        name: "Real: device connected",
        ok: false,
        details: "No connected device id",
      },
    ];
  }

  const bleManager = getBleManager();
  const state = await bleManager.state();
  push({
    name: "Real: bluetooth powered on",
    ok: state === State.PoweredOn,
    details: `state=${state}`,
  });
  if (state !== State.PoweredOn) return results;

  const devices = await bleManager.devices([deviceId]);
  if (devices.length === 0) {
    push({
      name: "Real: device resolved",
      ok: false,
      details: "Device not found",
    });
    return results;
  }
  const device = devices[0];

  onProgress?.("Listening for BLE packets...");

  let recorder: EcgRecorder | null = null;
  let sessionId = "";
  let sampleCount = 0;
  let decodedOk = 0;
  let decodedErr = 0;
  let format: DecodedPacket["format"] | null = null;
  let leadCount = 0;
  let layout = "unknown";
  let stopRequested = false;

  const startTime = Date.now();

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      stopRequested = true;
      subscription.remove();
      resolve();
    }, durationSeconds * 1000);

    const subscription = device.monitorCharacteristicForService(
      serviceUUID,
      characteristicUUID,
      async (error, characteristic) => {
        if (error) {
          decodedErr += 1;
          return;
        }
        if (!characteristic?.value) return;

        const bytes = Uint8Array.from(
          Buffer.from(characteristic.value, "base64"),
        );
        const decoded = decodeEcgPayload(bytes);
        if (!decoded.ok) {
          decodedErr += 1;
          onProgress?.(`Decode errors: ${decodedErr}`);
          return;
        }

        decodedOk += 1;
        if (decodedOk % 10 === 0) {
          onProgress?.(`Packets received: ${decodedOk}`);
        }
        if (!format) {
          format = decoded.packet.format;
          leadCount = decoded.packet.leadCount;
          layout = decoded.packet.layout;
          sessionId = `realdata-${Date.now()}`;
          recorder = new EcgRecorder({
            sessionId,
            type: "baseline",
            fs: 500,
            leadCount,
            layout,
            chunkSeconds: 2,
          });
          await recorder.start();
        }

        if (recorder) {
          await recorder.ingestDecodedPacket(decoded.packet);
          const status = recorder.getStatus();
          sampleCount = status.totalSamples;
        }
      },
    );

    // Ensure we stop if no packets arrive at all.
    setTimeout(() => {
      if (!stopRequested && decodedOk === 0) {
        clearTimeout(timer);
        subscription.remove();
        resolve();
      }
    }, 5000);
  });

  if (!recorder || !sessionId) {
    push({
      name: "Real: packets received",
      ok: false,
      details: "No valid packets received",
    });
    return results;
  }

  onProgress?.("Stopping recorder...");
  await recorder.stop();

  const durationMs = Date.now() - startTime;
  push({
    name: "Real: recorded duration >= 20s",
    ok: durationMs >= durationSeconds * 1000,
    details: `duration_ms=${durationMs}`,
  });
  push({
    name: "Real: decode success",
    ok: decodedOk > 0,
    details: `ok=${decodedOk},err=${decodedErr}`,
  });
  push({
    name: "Real: packet format detected",
    ok: format !== null,
    details: format ?? "unknown",
  });

  const status = recorder.getStatus();
  push({
    name: "Phase3: recorder total samples > 0",
    ok: status.totalSamples > 0,
    details: `samples=${status.totalSamples}`,
  });

  onProgress?.("Reading chunks...");
  const chunks = await listScratchChunks(sessionId);
  const chunkSamples = 500 * leadCount * 2;
  const expectedChunks = Math.ceil(status.totalSamples / chunkSamples);
  push({
    name: "Phase3: chunk count matches expected",
    ok: chunks.length === expectedChunks,
    details: `chunks=${chunks.length},expected=${expectedChunks}`,
  });

  onProgress?.("Exporting payload...");
  const payload = await exportScratchSessionPayload(sessionId);
  push({
    name: "Phase4: export sample count matches recorder",
    ok: payload.totalSamples === status.totalSamples,
    details: `export=${payload.totalSamples},recorder=${status.totalSamples}`,
  });
  push({
    name: "Phase4: export sha256 present",
    ok: payload.sha256.length === 64,
  });

  if (!apiUrl) {
    push({
      name: "Phase4: calibration API configured",
      ok: false,
      details: "Missing EXPO_PUBLIC_CALIBRATION_API_URL",
    });
  } else {
    onProgress?.("Calling calibration API...");
    const validation = await validateCalibration(payload, apiUrl);
    const expectedCleanLen = Math.min(
      payload.fs * payload.leadCount * 10,
      payload.totalSamples,
    );
    const cleanLen = Buffer.from(validation.cleanSegmentB64, "base64").length / 2;
    push({
      name: "Phase4: calibration API response present",
      ok: typeof validation.clean === "boolean",
    });
    push({
      name: "Phase4: clean segment length matches expected",
      ok: cleanLen === expectedCleanLen,
      details: `clean=${cleanLen},expected=${expectedCleanLen}`,
    });
  }

  onProgress?.("Clearing scratch data...");
  await clearScratch(sessionId);

  return results;
}
