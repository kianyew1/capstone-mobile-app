import { PermissionsAndroid, Platform } from "react-native";
import { BleManager, State } from "react-native-ble-plx";
import type { BleDevice } from "./types";

let manager: BleManager | null = null;

function getManager(): BleManager {
  if (manager) return manager;
  manager = new BleManager();
  return manager;
}

export function getBleManager(): BleManager {
  return getManager();
}

export function resetBleManager(): BleManager {
  try {
    manager?.destroy();
  } catch {
    // ignore
  }
  manager = null;
  return getManager();
}

export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const apiLevel = Platform.Version;
  if (apiLevel >= 31) {
    const scan = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN
    );
    const connect = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
    );
    const fine = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
    );
    return (
      scan === PermissionsAndroid.RESULTS.GRANTED &&
      connect === PermissionsAndroid.RESULTS.GRANTED &&
      fine === PermissionsAndroid.RESULTS.GRANTED
    );
  }
  const location = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
  );
  return location === PermissionsAndroid.RESULTS.GRANTED;
}

export async function getBleState(): Promise<State> {
  const managerInstance = getManager();
  return managerInstance.state();
}

export function subscribeBleState(onState: (state: State) => void): () => void {
  const managerInstance = getManager();
  const subscription = managerInstance.onStateChange((nextState) => {
    onState(nextState);
  }, true);
  return () => subscription.remove();
}

export async function ensureBlePoweredOn(): Promise<void> {
  const managerInstance = getManager();
  const state = await managerInstance.state();
  if (state === "PoweredOn") return;
  if (Platform.OS === "android") {
    await managerInstance.enable();
    await waitForPoweredOn();
    return;
  }
  throw new Error("Bluetooth is off. Please enable Bluetooth.");
}


async function waitForPoweredOn(timeoutMs = 8000): Promise<void> {
  const managerInstance = getManager();
  const current = await managerInstance.state();
  if (current === "PoweredOn") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.remove();
      reject(new Error("Bluetooth is still off. Please enable it manually."));
    }, timeoutMs);
    const subscription = managerInstance.onStateChange((nextState) => {
      if (nextState === "PoweredOn") {
        clearTimeout(timeout);
        subscription.remove();
        resolve();
      }
    }, true);
  });
}

export function scanDevices({
  serviceUUIDs = null,
  onDevice,
  onError,
  timeoutMs = 12000,
  includeUnnamed = false,
}: {
  serviceUUIDs?: string[] | null;
  onDevice: (device: BleDevice) => void;
  onError?: (err: Error) => void;
  timeoutMs?: number;
  includeUnnamed?: boolean;
}): () => void {
  const managerInstance = getManager();
  const seen = new Set<string>();
  const timeout = setTimeout(() => {
    managerInstance.stopDeviceScan();
  }, timeoutMs);
  managerInstance.startDeviceScan(serviceUUIDs, { allowDuplicates: false }, (error, device) => {
    if (error) {
      if (onError) onError(error);
      return;
    }
    if (!device?.id || seen.has(device.id)) return;
    seen.add(device.id);
    if (!includeUnnamed && !device.name) return;
    onDevice({ id: device.id, name: device.name ?? null, rssi: device.rssi });
  });
  return () => {
    clearTimeout(timeout);
    managerInstance.stopDeviceScan();
  };
}

export async function connect(deviceId: string) {
  const managerInstance = getManager();
  const device = await managerInstance.connectToDevice(deviceId, { timeout: 10000 });
  await device.discoverAllServicesAndCharacteristics();
  return device;
}

export async function disconnect(device: any) {
  if (!device?.id) return;
  const managerInstance = getManager();
  await managerInstance.cancelDeviceConnection(device.id);
}

export async function disconnectById(deviceId: string) {
  if (!deviceId) return;
  const managerInstance = getManager();
  await managerInstance.cancelDeviceConnection(deviceId);
}
