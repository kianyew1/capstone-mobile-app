/**
 * Mock Configuration
 *
 * Enable mock mode to use simulated Bluetooth devices and ECG data
 * for development and prototyping without physical hardware.
 *
 * Set ENABLE_MOCK_MODE to false when you have actual hardware.
 */

export const ENABLE_MOCK_MODE = true;

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
