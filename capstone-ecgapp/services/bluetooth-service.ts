import {
  ENABLE_MOCK_MODE,
  MOCK_DEVICE,
  MOCK_TIMING,
} from "@/config/mock-config";
import { useAppStore } from "@/stores/app-store";
import type { BluetoothStatus, ConnectionStatus, ECGDevice } from "@/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import {
  BleManager,
  Device,
  State,
  type Subscription,
} from "react-native-ble-plx";

// Service/Characteristic UUIDs for the XIAO nRF52840 ECG firmware
// Keep in sync with nrf52480.ino
const ECG_SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab";
const ECG_CHARACTERISTIC_UUID = "87654321-4321-4321-4321-abcdefabcdef";

// Create a singleton BleManager instance
let bleManagerInstance: BleManager | null = null;

const getBleManager = (): BleManager => {
  if (!bleManagerInstance) {
    bleManagerInstance = new BleManager();
  }
  return bleManagerInstance;
};

export function useBluetoothService() {
  const [bluetoothStatus, setBluetoothStatus] = useState<BluetoothStatus>(
    ENABLE_MOCK_MODE ? "poweredOn" : "unknown",
  );
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    ENABLE_MOCK_MODE ? "connected" : "disconnected",
  );
  const [discoveredDevices, setDiscoveredDevices] = useState<ECGDevice[]>(
    ENABLE_MOCK_MODE ? [MOCK_DEVICE] : [],
  );
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { pairedDevice, setPairedDevice } = useAppStore();

  const bleManager = useRef(getBleManager()).current;
  const autoReconnectRef = useRef(false);
  const scanSubscription = useRef<Subscription | null>(null);
  const stateSubscription = useRef<Subscription | null>(null);

  // Initialize mock mode
  useEffect(() => {
    if (ENABLE_MOCK_MODE) {
      setPairedDevice(MOCK_DEVICE);
      setBluetoothStatus("poweredOn");
      setConnectionStatus("connected");
      console.log("🎭 Mock Mode Enabled - Using simulated ECG device");
    }
  }, [setPairedDevice]);

  // Monitor Bluetooth state
  useEffect(() => {
    // Skip real Bluetooth setup in mock mode
    if (ENABLE_MOCK_MODE) return;

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
    // Skip auto-reconnect in mock mode
    if (ENABLE_MOCK_MODE) return;

    if (
      pairedDevice &&
      bluetoothStatus === "poweredOn" &&
      !connectedDevice &&
      autoReconnectRef.current
    ) {
      reconnectToPairedDevice();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairedDevice, bluetoothStatus, connectedDevice]);

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

    // Mock mode: Simulate device discovery
    if (ENABLE_MOCK_MODE) {
      setIsScanning(true);
      setConnectionStatus("scanning");

      setTimeout(() => {
        setDiscoveredDevices([
          MOCK_DEVICE,
          {
            id: "mock-ecg-device-002",
            name: "Mock ECG Device 2",
            rssi: -65,
            isConnected: false,
            isPaired: false,
          },
        ]);
        setIsScanning(false);
        setConnectionStatus("disconnected");
        console.log("🎭 Mock scan completed - Found 2 devices");
      }, MOCK_TIMING.scanDuration);

      return;
    }

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

        // Mock mode: Simulate connection
        if (ENABLE_MOCK_MODE) {
          await new Promise((resolve) =>
            setTimeout(resolve, MOCK_TIMING.connectionDelay),
          );

          const mockDevice =
            discoveredDevices.find((d) => d.id === deviceId) || MOCK_DEVICE;

          setConnectionStatus("connected");
          autoReconnectRef.current = true;

          const connectedMockDevice: ECGDevice = {
            ...mockDevice,
            isConnected: true,
            isPaired: true,
            lastConnected: new Date(),
          };

          setPairedDevice(connectedMockDevice);
          console.log("🎭 Mock connection successful:", mockDevice.name);

          return true;
        }

        // Connect to device
        const device = await bleManager.connectToDevice(deviceId, {
          autoConnect: false,
          timeout: 10000,
        });

        // Discover services and characteristics
        await device.discoverAllServicesAndCharacteristics();

        setConnectedDevice(device);
        setConnectionStatus("connected");
        autoReconnectRef.current = true;

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
      // Mock mode: Simulate disconnection
      if (ENABLE_MOCK_MODE) {
        setConnectedDevice(null);
        setConnectionStatus("disconnected");
        console.log("🎭 Mock device disconnected");
        return;
      }

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

    // Mock mode: Simulate reconnection
    if (ENABLE_MOCK_MODE) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      setConnectionStatus("connected");
      autoReconnectRef.current = true;
      console.log("🎭 Mock device reconnected");
      return true;
    }

    try {
      // Check if device is already connected
      const isConnected = await bleManager.isDeviceConnected(pairedDevice.id);

      if (isConnected) {
        const device = await bleManager.devices([pairedDevice.id]);
        if (device.length > 0) {
          setConnectedDevice(device[0]);
          setConnectionStatus("connected");
          autoReconnectRef.current = true;
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
