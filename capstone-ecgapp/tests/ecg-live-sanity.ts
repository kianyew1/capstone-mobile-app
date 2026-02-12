// Live BLE sanity check (hardware required).
// This verifies: already-connected device -> subscribe -> decode in a short window.
import { Buffer } from "buffer";
import { BleError, Device, State } from "react-native-ble-plx";
import { getBleManager } from "@/features-from-other-repo/ble-stream/bleService";
import { decodeEcgPayload } from "@/services/ecg-packet";

export interface LiveSanityOptions {
  deviceId?: string;
  serviceUUID?: string;
  characteristicUUID?: string;
  listenMs?: number;
}

export interface LiveSanityProgress {
  status: "checking" | "listening" | "done" | "error";
  message?: string;
  packets?: number;
  decodeErrors?: number;
  deviceId?: string;
  deviceName?: string | null;
}

export interface LiveSanityResult {
  ok: boolean;
  packets: number;
  decodeErrors: number;
  deviceId?: string;
  deviceName?: string | null;
  error?: string;
}

const DEFAULT_SERVICE_UUID =
  process.env.EXPO_PUBLIC_ECG_SERVICE_UUID ??
  "12345678-1234-1234-1234-1234567890ab";
const DEFAULT_CHAR_UUID =
  process.env.EXPO_PUBLIC_ECG_CHARACTERISTIC_UUID ??
  "87654321-4321-4321-4321-abcdefabcdef";

export async function runLiveBleSanityCheck(
  options: LiveSanityOptions = {},
  onProgress?: (progress: LiveSanityProgress) => void,
): Promise<LiveSanityResult> {
  let packets = 0;
  let decodeErrors = 0;
  let deviceId: string | undefined;
  let deviceName: string | null | undefined;

  try {
    // Live check assumes device is already paired/connected.
    const bleManager = getBleManager();
    const deviceIdHint = options.deviceId;
    const serviceUUID = options.serviceUUID ?? DEFAULT_SERVICE_UUID;
    const characteristicUUID = options.characteristicUUID ?? DEFAULT_CHAR_UUID;
    const listenMs = options.listenMs ?? 4000;

    onProgress?.({
      status: "checking",
      message: "Checking BLE connection...",
      packets,
      decodeErrors,
    });

    // 1) Bluetooth adapter state check.
    const state = await bleManager.state();
    if (state !== State.PoweredOn) {
      return {
        ok: false,
        packets: 0,
        decodeErrors: 0,
        error: "Bluetooth is not powered on",
      };
    }

    let stopping = false;
    let device: Device | undefined;

    // 2) Require an existing paired connection (no scan/connect in this test).
    if (!deviceIdHint) {
      return {
        ok: false,
        packets: 0,
        decodeErrors: 0,
        error: "Not paired, or reset bluetooth",
      };
    }
    const isConnected = await bleManager.isDeviceConnected(deviceIdHint);
    if (!isConnected) {
      return {
        ok: false,
        packets: 0,
        decodeErrors: 0,
        error: "Not paired, or reset bluetooth",
      };
    }
    const devices = await bleManager.devices([deviceIdHint]);
    if (devices.length === 0) {
      return {
        ok: false,
        packets: 0,
        decodeErrors: 0,
        error: "Device not available. Reset bluetooth.",
      };
    }
    device = devices[0];

    deviceId = device.id;
    deviceName = device.name ?? null;

    // 3) Subscribe to notifications/indications and decode payloads.
    let subscription: { remove: () => void } | null = null;

    return await new Promise<LiveSanityResult>((resolve) => {
      onProgress?.({
        status: "listening",
        message: "Listening for packets...",
        deviceId,
        deviceName,
        packets,
        decodeErrors,
      });

      // Stop after a short listen window.
      const timer = setTimeout(() => {
        stopping = true;
        subscription?.remove();
        const ok = packets > 0 && decodeErrors === 0;
        onProgress?.({
          status: "done",
          packets,
          decodeErrors,
          deviceId,
          deviceName,
        });
        resolve({ ok, packets, decodeErrors, deviceId, deviceName });
      }, listenMs);

      subscription = device.monitorCharacteristicForService(
        serviceUUID,
        characteristicUUID,
        (error, characteristic) => {
          if (error) {
            if (stopping || isIgnorableBleError(error)) {
              // Ignore expected cancellation/disconnect errors during shutdown.
              return;
            }
            clearTimeout(timer);
            const details = formatBleError(error);
            onProgress?.({
              status: "error",
              message: details,
              packets,
              decodeErrors,
              deviceId,
              deviceName,
            });
            resolve({
              ok: false,
              packets,
              decodeErrors,
              deviceId,
              deviceName,
              error: details,
            });
            return;
          }
          if (!characteristic?.value) return;

          // Decode base64 payload to bytes, then decode packet.
          const bytes = Uint8Array.from(
            Buffer.from(characteristic.value, "base64"),
          );
          const decoded = decodeEcgPayload(bytes);
          if (decoded.ok) {
            packets += 1;
          } else {
            decodeErrors += 1;
          }
          onProgress?.({
            status: "listening",
            packets,
            decodeErrors,
            deviceId,
            deviceName,
          });
        },
      );
    });
  } catch (err) {
    const details = formatBleError(err);
    onProgress?.({
      status: "error",
      message: details,
      packets,
      decodeErrors,
      deviceId,
      deviceName,
    });
    return {
      ok: false,
      packets,
      decodeErrors,
      deviceId,
      deviceName,
      error: details,
    };
  }
}

export async function resetBleConnections(): Promise<void> {
  // No-op: live sanity does not own BLE lifecycle.
  return;
}

function formatBleError(err: unknown): string {
  if (!err || typeof err !== "object") return "Unknown BLE error";
  const anyErr = err as {
    message?: string;
    reason?: string;
    errorCode?: number;
  };
  const parts = [
    anyErr.message ?? "Unknown error occurred",
    anyErr.reason ? `reason=${anyErr.reason}` : null,
    typeof anyErr.errorCode === "number" ? `code=${anyErr.errorCode}` : null,
  ].filter(Boolean);
  return parts.join(" | ");
}

function isIgnorableBleError(err: BleError): boolean {
  const message = err.message?.toLowerCase() ?? "";
  const reason = (err as { reason?: string }).reason?.toLowerCase() ?? "";
  return (
    message.includes("cancel") ||
    message.includes("disconnect") ||
    reason.includes("cancel") ||
    reason.includes("disconnect")
  );
}
