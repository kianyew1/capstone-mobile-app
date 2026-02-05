import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, PermissionsAndroid } from "react-native";
import {
  BleManager,
  Device,
  State,
  type Subscription,
} from "react-native-ble-plx";
import type { BluetoothStatus, ConnectionStatus, ECGDevice } from "@/types";
import { useAppStore } from "@/stores/app-store";

// Service UUID for ECG device - replace with your actual device's service UUID
const ECG_SERVICE_UUID = "0000180d-0000-1000-8000-00805f9b34fb"; // Heart Rate Service UUID
const ECG_CHARACTERISTIC_UUID = "00002a37-0000-1000-8000-00805f9b34fb"; // Heart Rate Measurement

// Create a singleton BleManager instance
let bleManagerInstance: BleManager | null = null;

const getBleManager = (): BleManager => {
  if (!bleManagerInstance) {
    bleManagerInstance = new BleManager();
  }
  return bleManagerInstance;
};

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

  // Auto-reconnect to paired device
  useEffect(() => {
    if (pairedDevice && bluetoothStatus === "poweredOn" && !connectedDevice) {
      reconnectToPairedDevice();
    }
  }, [pairedDevice, bluetoothStatus]);

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

    const hasPermissions = await requestPermissions();
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
      bleManager.startDeviceScan(
        null, // Scan for all devices, filter by name/service below
        { allowDuplicates: false },
        (scanError, device) => {
          if (scanError) {
            console.error("Scan error:", scanError);
            setError(scanError.message);
            setIsScanning(false);
            setConnectionStatus("disconnected");
            return;
          }

          if (device && device.name) {
            // Filter for ECG devices - adjust the filter based on your device name
            const isECGDevice =
              device.name.toLowerCase().includes("ecg") ||
              device.name.toLowerCase().includes("heart") ||
              device.name.toLowerCase().includes("cardio");

            // For development, show all devices with names
            setDiscoveredDevices((prev) => {
              const exists = prev.some((d) => d.id === device.id);
              if (exists) return prev;

              const newDevice: ECGDevice = {
                id: device.id,
                name: device.name || "Unknown Device",
                rssi: device.rssi || -100,
                isConnected: false,
                isPaired: false,
              };

              return [...prev, newDevice];
            });
          }
        },
      );

      // Stop scanning after 15 seconds
      setTimeout(() => {
        stopScan();
      }, 15000);
    } catch (err) {
      console.error("Failed to start scan:", err);
      setError("Failed to start scanning");
      setIsScanning(false);
      setConnectionStatus("disconnected");
    }
  }, [isScanning, bluetoothStatus, bleManager]);

  const stopScan = useCallback(() => {
    bleManager.stopDeviceScan();
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
        await connectedDevice.cancelConnection();
      }
      setConnectedDevice(null);
      setConnectionStatus("disconnected");
    } catch (err) {
      console.error("Disconnect error:", err);
    }
  }, [connectedDevice]);

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
