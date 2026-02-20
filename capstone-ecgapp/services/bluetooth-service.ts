import {
  ENABLE_MOCK_MODE,
  MOCK_DEVICE,
  MOCK_HEART_RATE_CONFIG,
  MOCK_TIMING,
} from "@/config/mock-config";
import { useAppStore } from "@/stores/app-store";
import type { BluetoothStatus, ConnectionStatus, ECGDevice } from "@/types";
import { fromByteArray } from "base64-js";
import { useCallback, useEffect, useRef } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import {
  BleManager,
  Device,
  State,
  type Subscription,
} from "react-native-ble-plx";
import { useBluetoothStore } from "@/stores/bluetooth-store";

// Service/Characteristic UUIDs for the XIAO nRF52840 ECG firmware
// Keep in sync with nrf52480.ino
const ECG_SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab";
const ECG_CHARACTERISTIC_UUID = "87654321-4321-4321-4321-abcdefabcdef";

// Create a singleton BleManager instance
let bleManagerInstance: BleManager | null = null;
let ecgSubscription: Subscription | null = null;
let ecgListener: ((payloadBase64: string) => void) | null = null;
let lastEcgPacketAtMs = 0;
let lastEcgPayload: string | null = null;
const MIN_ECG_PACKET_INTERVAL_MS = 10;
let mockEcgInterval: ReturnType<typeof setInterval> | null = null;

const MOCK_SAMPLE_RATE_HZ = 500;
const MOCK_SAMPLES_PER_PACKET = 10;
const MOCK_PACKET_INTERVAL_MS = Math.round(
  (1000 * MOCK_SAMPLES_PER_PACKET) / MOCK_SAMPLE_RATE_HZ,
);
const MOCK_ECG_AMPLITUDE = 1200;
const MOCK_ECG_NOISE_AMPLITUDE = 40;
let mockPhase = 0;

const syntheticEcg = (t: number) => {
  const p = 0.12 * Math.exp(-Math.pow((t - 0.18) / 0.035, 2));
  const q = -0.15 * Math.exp(-Math.pow((t - 0.4) / 0.01, 2));
  const r = 1.2 * Math.exp(-Math.pow((t - 0.42) / 0.012, 2));
  const s = -0.25 * Math.exp(-Math.pow((t - 0.45) / 0.012, 2));
  const tw = 0.35 * Math.exp(-Math.pow((t - 0.7) / 0.06, 2));
  return p + q + r + s + tw;
};

const nextMockSample = () => {
  const baseFreqHz = MOCK_HEART_RATE_CONFIG.baseHeartRate / 60;
  const phaseStep =
    (2 * Math.PI * baseFreqHz) / MOCK_SAMPLE_RATE_HZ;

  const t = mockPhase / (2 * Math.PI);
  const ecg = syntheticEcg(t);

  mockPhase += phaseStep;
  if (mockPhase >= 2 * Math.PI) {
    mockPhase -= 2 * Math.PI;
  }

  const noise =
    Math.floor(Math.random() * (MOCK_ECG_NOISE_AMPLITUDE * 2 + 1)) -
    MOCK_ECG_NOISE_AMPLITUDE;
  let value = Math.round(MOCK_ECG_AMPLITUDE * ecg + noise);

  if (value > 32767) value = 32767;
  if (value < -32768) value = -32768;

  return value;
};

const buildMockPacket = () => {
  const packet = new Uint8Array(MOCK_SAMPLES_PER_PACKET * 2);
  for (let i = 0; i < MOCK_SAMPLES_PER_PACKET; i += 1) {
    const sample = nextMockSample();
    const unsigned = sample < 0 ? 0x10000 + sample : sample;
    packet[i * 2] = unsigned & 0xff;
    packet[i * 2 + 1] = (unsigned >> 8) & 0xff;
  }
  return packet;
};

const getBleManager = (): BleManager => {
  if (!bleManagerInstance) {
    bleManagerInstance = new BleManager();
  }
  return bleManagerInstance;
};

export function useBluetoothService() {
  const {
    bluetoothStatus,
    connectionStatus,
    discoveredDevices,
    connectedDevice,
    isScanning,
    error,
    setBluetoothStatus,
    setConnectionStatus,
    setDiscoveredDevices,
    setConnectedDevice,
    setIsScanning,
    setError,
  } = useBluetoothStore();

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
      setDiscoveredDevices([MOCK_DEVICE]);
      console.log("🎭 Mock Mode Enabled - Using simulated ECG device");
    }
  }, [setPairedDevice, setBluetoothStatus, setConnectionStatus, setDiscoveredDevices]);

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
      ecgListener = null;

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
    ecgListener = null;
    await disconnectDevice();
    setPairedDevice(null);
    setDiscoveredDevices([]);
  }, [disconnectDevice, setPairedDevice]);

  const stopEcgNotifications = useCallback(() => {
    ecgListener = null;
    if (mockEcgInterval) {
      clearInterval(mockEcgInterval);
      mockEcgInterval = null;
      console.log("🎭 Mock ECG stream stopped");
    }
  }, []);

  const startEcgNotifications = useCallback(
    async (onData: (payloadBase64: string) => void): Promise<boolean> => {
      if (ENABLE_MOCK_MODE) {
        setError(null);
        ecgListener = onData;

        if (mockEcgInterval) {
          return true;
        }

        mockEcgInterval = setInterval(() => {
          if (!ecgListener) return;
          const packet = buildMockPacket();
          const payload = fromByteArray(packet);
          ecgListener(payload);
        }, MOCK_PACKET_INTERVAL_MS);

        console.log("🎭 Mock ECG stream started");
        return true;
      }

      setError(null);

      let device = connectedDevice;

      if (!device && pairedDevice) {
        const reconnected = await reconnectToPairedDevice();
        if (reconnected) {
          const isConnected = await bleManager.isDeviceConnected(
            pairedDevice.id,
          );
          if (isConnected) {
            const devices = await bleManager.devices([pairedDevice.id]);
            device = devices[0] ?? null;
            if (device) {
              setConnectedDevice(device);
            }
          }
        }
      }

      if (!device) {
        setError("No connected device available");
        return false;
      }

      try {
        await device.discoverAllServicesAndCharacteristics();
      } catch (err) {
        console.error("Service discovery error:", err);
        setError("Failed to discover services");
        return false;
      }

      ecgListener = onData;

      if (ecgSubscription) {
        return true;
      }

      ecgSubscription = device.monitorCharacteristicForService(
        ECG_SERVICE_UUID,
        ECG_CHARACTERISTIC_UUID,
        (monitorError, characteristic) => {
          if (monitorError) {
            console.error("ECG monitor error:", monitorError);
            setError(monitorError.message);
            ecgSubscription = null;
            return;
          }

          if (characteristic?.value) {
            const now = Date.now();
            const payload = characteristic.value;
            const delta = now - lastEcgPacketAtMs;
            if (
              delta < MIN_ECG_PACKET_INTERVAL_MS &&
              lastEcgPayload === payload
            ) {
              return;
            }
            lastEcgPacketAtMs = now;
            lastEcgPayload = payload;
            ecgListener?.(payload);
          }
        },
      );

      return true;
    },
    [
      bleManager,
      connectedDevice,
      pairedDevice,
      reconnectToPairedDevice,
      setConnectedDevice,
    ],
  );

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
    startEcgNotifications,
    stopEcgNotifications,
  };
}
