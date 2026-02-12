import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, PermissionsAndroid } from "react-native";
import type { BleManager } from "react-native-ble-plx";
import { Device, State, type Subscription } from "react-native-ble-plx";
import type { BluetoothStatus, ConnectionStatus, ECGDevice } from "@/types";
import { useAppStore } from "@/stores/app-store";
import {
  getBleManager as getSharedBleManager,
  resetBleManager as resetSharedBleManager,
  requestBlePermissions,
  scanDevices,
} from "@/features-from-other-repo/ble-stream/bleService";

// Service UUID for ECG device - replace with your actual device's service UUID
const ECG_SERVICE_UUID = "0000180d-0000-1000-8000-00805f9b34fb"; // Heart Rate Service UUID
const ECG_CHARACTERISTIC_UUID = "00002a37-0000-1000-8000-00805f9b34fb"; // Heart Rate Measurement

export const getBleManager = (): BleManager => getSharedBleManager();

export const resetBleManager = (): BleManager => resetSharedBleManager();

export function useBluetoothService() {
  const [bluetoothStatus, setBluetoothStatus] =
    useState<BluetoothStatus>("unknown");
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("disconnected");
  const [discoveredDevices, setDiscoveredDevices] = useState<ECGDevice[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { pairedDevice, setPairedDevice } = useAppStore();

  const bleManager = useRef(getBleManager()).current;
  const scanSubscription = useRef<Subscription | null>(null);
  const stateSubscription = useRef<Subscription | null>(null);
  const stopScanRef = useRef<null | (() => void)>(null);

  // Monitor Bluetooth state
  useEffect(() => {
    const setupBluetooth = async () => {
      try {
        // Check initial state
        const state = await bleManager.state();
        setBluetoothStatus(mapBleState(state));

        // Subscribe to state changes
        stateSubscription.current = bleManager.onStateChange((newState) => {
          setBluetoothStatus(mapBleState(newState));
        }, true);
      } catch (err) {
        console.error("Error setting up Bluetooth:", err);
        setError("Failed to initialize Bluetooth");
      }
    };

    setupBluetooth();

    return () => {
      stateSubscription.current?.remove();
    };
  }, [bleManager]);

  // Auto-reconnect to paired device is intentionally disabled to avoid
  // conflicts with developer BLE flows.

  const mapBleState = (state: State): BluetoothStatus => {
    switch (state) {
      case State.PoweredOn:
        return "poweredOn";
      case State.PoweredOff:
        return "poweredOff";
      case State.Resetting:
        return "resetting";
      case State.Unauthorized:
        return "unauthorized";
      case State.Unsupported:
        return "unsupported";
      default:
        return "unknown";
    }
  };

  const requestPermissions = async (): Promise<boolean> => {
    if (Platform.OS === "android") {
      try {
        const apiLevel = Platform.Version as number;

        if (apiLevel >= 31) {
          // Android 12+
          const results = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          ]);

          return (
            results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] ===
              PermissionsAndroid.RESULTS.GRANTED &&
            results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] ===
              PermissionsAndroid.RESULTS.GRANTED &&
            results[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] ===
              PermissionsAndroid.RESULTS.GRANTED
          );
        } else {
          // Android < 12
          const result = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          );
          return result === PermissionsAndroid.RESULTS.GRANTED;
        }
      } catch (err) {
        console.error("Permission request error:", err);
        return false;
      }
    }

    // iOS permissions are handled via Info.plist
    return true;
  };

  const startScan = useCallback(async () => {
    if (isScanning) return;

    setError(null);
    setDiscoveredDevices([]);

    const hasPermissions = await requestBlePermissions();
    if (!hasPermissions) {
      setError("Bluetooth permissions not granted");
      return;
    }

    if (bluetoothStatus !== "poweredOn") {
      setError("Bluetooth is not enabled");
      return;
    }

    setIsScanning(true);
    setConnectionStatus("scanning");

    try {
      if (stopScanRef.current) stopScanRef.current();
      stopScanRef.current = scanDevices({
        serviceUUIDs: null,
        includeUnnamed: true,
        onDevice: (device) => {
          setDiscoveredDevices((prev) => {
            const exists = prev.some((d) => d.id === device.id);
            if (exists) return prev;
            const newDevice: ECGDevice = {
              id: device.id,
              name: device.name ?? "Unnamed Device",
              rssi: device.rssi ?? -100,
              isConnected: false,
              isPaired: false,
            };
            return [...prev, newDevice];
          });
        },
        onError: (err) => {
          console.error("Scan error:", err);
          setError(err.message);
          setIsScanning(false);
          setConnectionStatus("disconnected");
        },
        timeoutMs: 15000,
      });
    } catch (err) {
      console.error("Failed to start scan:", err);
      setError("Failed to start scanning");
      setIsScanning(false);
      setConnectionStatus("disconnected");
    }
  }, [isScanning, bluetoothStatus, bleManager]);

  const stopScan = useCallback(() => {
    if (stopScanRef.current) {
      stopScanRef.current();
      stopScanRef.current = null;
    }
    setIsScanning(false);
    if (connectionStatus === "scanning") {
      setConnectionStatus("disconnected");
    }
  }, [bleManager, connectionStatus]);

  const connectToDevice = useCallback(
    async (deviceId: string): Promise<boolean> => {
      try {
        setConnectionStatus("connecting");
        setError(null);

        // Stop scanning if active
        stopScan();

        // Connect to device
        const device = await bleManager.connectToDevice(deviceId, {
          autoConnect: false,
          timeout: 10000,
        });

        // Discover services and characteristics
        await device.discoverAllServicesAndCharacteristics();

        setConnectedDevice(device);
        setConnectionStatus("connected");

        // Update paired device in store
        const ecgDevice: ECGDevice = {
          id: device.id,
          name: device.name || "ECG Device",
          rssi: device.rssi || -100,
          isConnected: true,
          isPaired: true,
          lastConnected: new Date(),
        };
        setPairedDevice(ecgDevice);

        // Monitor disconnection
        device.onDisconnected((disconnectError, disconnectedDevice) => {
          console.log(
            "Device disconnected:",
            disconnectedDevice?.name,
            disconnectError,
          );
          setConnectedDevice(null);
          setConnectionStatus("disconnected");
        });

        return true;
      } catch (err: unknown) {
        console.error("Connection error:", err);
        const errorMessage =
          err instanceof Error ? err.message : "Failed to connect to device";
        setError(errorMessage);
        setConnectionStatus("error");
        return false;
      }
    },
    [bleManager, stopScan, setPairedDevice],
  );

  const disconnectDevice = useCallback(async (): Promise<void> => {
    try {
      if (connectedDevice) {
        const isConnected = await bleManager.isDeviceConnected(
          connectedDevice.id,
        );
        if (isConnected) {
          await connectedDevice.cancelConnection();
        }
      }
      setConnectedDevice(null);
      setConnectionStatus("disconnected");
    } catch (err) {
      console.error("Disconnect error:", err);
    }
  }, [connectedDevice, bleManager]);

  const reconnectToPairedDevice = useCallback(async (): Promise<boolean> => {
    if (!pairedDevice) return false;

    setConnectionStatus("reconnecting");

    try {
      // Check if device is already connected
      const isConnected = await bleManager.isDeviceConnected(pairedDevice.id);

      if (isConnected) {
        const device = await bleManager.devices([pairedDevice.id]);
        if (device.length > 0) {
          setConnectedDevice(device[0]);
          setConnectionStatus("connected");
          return true;
        }
      }

      // Try to reconnect
      return await connectToDevice(pairedDevice.id);
    } catch (err) {
      console.error("Reconnection error:", err);
      setConnectionStatus("disconnected");
      return false;
    }
  }, [pairedDevice, bleManager, connectToDevice]);

  const unpairDevice = useCallback(async (): Promise<void> => {
    await disconnectDevice();
    setPairedDevice(null);
    setDiscoveredDevices([]);
  }, [disconnectDevice, setPairedDevice]);

  return {
    // State
    bluetoothStatus,
    connectionStatus,
    discoveredDevices,
    connectedDevice,
    isScanning,
    error,
    pairedDevice,

    // Actions
    startScan,
    stopScan,
    connectToDevice,
    disconnectDevice,
    reconnectToPairedDevice,
    unpairDevice,
    requestPermissions,
  };
}
