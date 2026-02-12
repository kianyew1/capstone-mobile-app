import { useEffect, useMemo, useRef } from "react";
import type { BleStreamOptions } from "./types";
import { useBleStream } from "./useBleStream";

export type BleDevConnectState = {
  isBluetoothOn: boolean;
  isPairing: boolean;
  error: string;
  connectedDevice: any | null;
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  resetAutoConnect: () => void;
};

export function useBleDevConnect(
  options: BleStreamOptions & { autoConnect?: boolean },
): BleDevConnectState {
  const { autoConnect = true, ...bleOptions } = options;
  const {
    isPairing,
    isBluetoothOn,
    error,
    connectedDevice,
    startPairing,
    disconnectFromDevice,
  } = useBleStream(bleOptions);
  const autoConnectAttempted = useRef(false);

  const connect = async (): Promise<boolean> => {
    if (isPairing || connectedDevice) return true;
    if (!isBluetoothOn) return false;
    autoConnectAttempted.current = true;
    return await startPairing();
  };

  const disconnect = async (): Promise<void> => {
    await disconnectFromDevice();
  };

  const resetAutoConnect = (): void => {
    autoConnectAttempted.current = false;
  };

  useEffect(() => {
    if (!autoConnect) return;
    if (!isBluetoothOn) {
      autoConnectAttempted.current = false;
      return;
    }
    if (connectedDevice || isPairing) return;
    if (autoConnectAttempted.current) return;
    autoConnectAttempted.current = true;
    void startPairing();
  }, [autoConnect, isBluetoothOn, connectedDevice, isPairing, startPairing]);

  return useMemo(
    () => ({
      isBluetoothOn,
      isPairing,
      error,
      connectedDevice,
      connect,
      disconnect,
      resetAutoConnect,
    }),
    [isBluetoothOn, isPairing, error, connectedDevice],
  );
}
