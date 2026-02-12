import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BleStreamOptions } from "./types";
import {
  connect,
  disconnect,
  disconnectById,
  ensureBlePoweredOn,
  getBleState,
  requestBlePermissions,
  scanDevices,
  subscribeBleState,
} from "./bleService";

const DEFAULT_SCAN_TIMEOUT = 12000;
const DEFAULT_CONNECT_TIMEOUT = 12000;

export function useBleStream(options: BleStreamOptions) {
  const { serviceUUID, characteristicUUID, scanTimeoutMs } = options;
  const [isPairing, setIsPairing] = useState(false);
  const [connectedDevice, setConnectedDevice] = useState<any>(null);
  const [bluetoothState, setBluetoothState] = useState<string>("Unknown");
  const [error, setError] = useState<string>("");

  const stopScanRef = useRef<null | (() => void)>(null);
  const connectedIdsRef = useRef<Set<string>>(new Set());
  const disconnectSubRef = useRef<{ remove: () => void } | null>(null);

  const startPairing = useCallback(async (): Promise<boolean> => {
    setError("");
    try {
      const ok = await requestBlePermissions();
      if (!ok) throw new Error("Bluetooth permissions not granted");
      await ensureBlePoweredOn();
      setIsPairing(true);
      let resolved = false;
      const timeoutMs = scanTimeoutMs || DEFAULT_SCAN_TIMEOUT;
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        setError("No device found for the service UUID.");
        setIsPairing(false);
        if (stopScanRef.current) stopScanRef.current();
      }, timeoutMs);
      stopScanRef.current = scanDevices({
        serviceUUIDs: [serviceUUID],
        onDevice: async (device) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          if (stopScanRef.current) stopScanRef.current();
          try {
            const connected = await connectWithTimeout(
              device.id,
              DEFAULT_CONNECT_TIMEOUT,
            );
            setConnectedDevice(connected);
            if (connected?.id) connectedIdsRef.current.add(connected.id);
            if (disconnectSubRef.current) {
              disconnectSubRef.current.remove();
              disconnectSubRef.current = null;
            }
            if (connected?.onDisconnected) {
              disconnectSubRef.current = connected.onDisconnected(() => {
                setConnectedDevice(null);
              });
            }
          } catch (err: any) {
            setError(err.message || "Failed to connect");
            try {
              if (connectedDevice) await disconnect(connectedDevice);
              await disconnectById(device.id);
            } catch {
              // ignore cleanup errors
            }
          } finally {
            setIsPairing(false);
          }
        },
        onError: (err) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          setError(err.message);
          setIsPairing(false);
        },
        timeoutMs,
      });
      return true;
    } catch (err: any) {
      setError(err.message || "Failed to start scan");
      setIsPairing(false);
      return false;
    }
  }, [scanTimeoutMs, serviceUUID, characteristicUUID, connectedDevice]);

  const stopScan = useCallback(() => {
    if (stopScanRef.current) {
      stopScanRef.current();
      stopScanRef.current = null;
    }
    setIsPairing(false);
  }, []);

  const disconnectFromDevice = useCallback(async () => {
    if (connectedDevice) {
      await disconnect(connectedDevice);
    }
    if (connectedDevice?.id) {
      connectedIdsRef.current.delete(connectedDevice.id);
    }
    if (disconnectSubRef.current) {
      disconnectSubRef.current.remove();
      disconnectSubRef.current = null;
    }
    setConnectedDevice(null);
  }, [connectedDevice]);

  const disconnectAll = useCallback(async () => {
    if (stopScanRef.current) {
      stopScanRef.current();
      stopScanRef.current = null;
    }
    setIsPairing(false);
    const ids = Array.from(connectedIdsRef.current);
    for (const id of ids) {
      await disconnectById(id);
    }
    connectedIdsRef.current.clear();
    if (disconnectSubRef.current) {
      disconnectSubRef.current.remove();
      disconnectSubRef.current = null;
    }
    setConnectedDevice(null);
  }, []);

  useEffect(() => {
    let unsubscribe: null | (() => void) = null;
    const setup = async () => {
      const initial = await getBleState();
      setBluetoothState(initial);
      unsubscribe = subscribeBleState((nextState) => {
        setBluetoothState(nextState);
      });
    };
    void setup();
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const isBluetoothOn = bluetoothState === "PoweredOn";

  return useMemo(
    () => ({
      isPairing,
      isBluetoothOn,
      error,
      connectedDevice,
      startPairing,
      stopScan,
      disconnectFromDevice,
      disconnectAll,
    }),
    [
      isPairing,
      isBluetoothOn,
      error,
      connectedDevice,
      startPairing,
      stopScan,
      disconnectFromDevice,
      disconnectAll,
    ]
  );
}

async function connectWithTimeout(deviceId: string, timeoutMs: number) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Connection timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([connect(deviceId), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
