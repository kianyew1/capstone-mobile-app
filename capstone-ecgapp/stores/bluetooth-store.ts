import { create } from "zustand";
import type { BluetoothStatus, ConnectionStatus, ECGDevice } from "@/types";
import type { Device } from "react-native-ble-plx";

type DiscoveredDevicesUpdate =
  | ECGDevice[]
  | ((prev: ECGDevice[]) => ECGDevice[]);

interface BluetoothStoreState {
  bluetoothStatus: BluetoothStatus;
  connectionStatus: ConnectionStatus;
  discoveredDevices: ECGDevice[];
  connectedDevice: Device | null;
  isScanning: boolean;
  error: string | null;

  setBluetoothStatus: (status: BluetoothStatus) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setDiscoveredDevices: (devices: DiscoveredDevicesUpdate) => void;
  setConnectedDevice: (device: Device | null) => void;
  setIsScanning: (isScanning: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const initialState = {
  bluetoothStatus: "unknown" as BluetoothStatus,
  connectionStatus: "disconnected" as ConnectionStatus,
  discoveredDevices: [] as ECGDevice[],
  connectedDevice: null as Device | null,
  isScanning: false,
  error: null as string | null,
};

export const useBluetoothStore = create<BluetoothStoreState>((set) => ({
  ...initialState,
  setBluetoothStatus: (status) => set({ bluetoothStatus: status }),
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setDiscoveredDevices: (devices) =>
    set((state) => ({
      discoveredDevices:
        typeof devices === "function" ? devices(state.discoveredDevices) : devices,
    })),
  setConnectedDevice: (device) => set({ connectedDevice: device }),
  setIsScanning: (isScanning) => set({ isScanning }),
  setError: (error) => set({ error }),
  reset: () => set({ ...initialState }),
}));
