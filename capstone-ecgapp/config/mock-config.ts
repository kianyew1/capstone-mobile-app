/**
 * Mock Configuration
 *
 * Enable mock mode to use simulated Bluetooth devices and ECG data
 * for development and prototyping without physical hardware.
 *
 * Use EXPO_PUBLIC_MOCK_MODE=DEV|PROD to control when mock mode is enabled.
 */

const MOCK_MODE_TARGET = (process.env.EXPO_PUBLIC_MOCK_MODE ?? "DEV")
  .toUpperCase()
  .trim();

export const ENABLE_MOCK_MODE =
  MOCK_MODE_TARGET === "PROD"
    ? !__DEV__
    : MOCK_MODE_TARGET === "DEV"
      ? __DEV__
      : false;

/**
 * Mock device configuration
 */
export const MOCK_DEVICE = {
  id: "mock-ecg-device-001",
  name: "Mock ECG Device",
  rssi: -45,
  isConnected: true,
  isPaired: true,
  lastConnected: new Date(),
};

/**
 * Mock heart rate configuration
 */
export const MOCK_HEART_RATE_CONFIG = {
  baseHeartRate: 75, // Base heart rate (BPM)
  variability: 10, // +/- variation
  minHeartRate: 55,
  maxHeartRate: 180,
  updateInterval: 1000, // Update every 1 second
};

/**
 * Mock Bluetooth timing
 */
export const MOCK_TIMING = {
  scanDuration: 2000, // Time to "discover" devices
  connectionDelay: 1500, // Time to "connect"
  disconnectChance: 0.02, // 2% chance of disconnect per minute
};
