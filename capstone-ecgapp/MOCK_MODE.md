# Mock Mode Documentation

## Overview

Mock Mode allows you to develop and test the entire ECG monitoring flow without physical hardware. The app simulates Bluetooth connectivity and generates realistic ECG data for prototyping and development.

## Enabling/Disabling Mock Mode

Mock mode is controlled by an environment flag:

```bash
# .env
EXPO_PUBLIC_MOCK_MODE=DEV
```

Supported values:

- `DEV` (default): mock mode is enabled in development builds and disabled in production builds.
- `PROD`: mock mode is enabled in production builds and disabled in development builds.

To disable mock mode for real hardware:

- In development builds, set `EXPO_PUBLIC_MOCK_MODE=PROD`.
- In production builds, set `EXPO_PUBLIC_MOCK_MODE=DEV`.

## What Mock Mode Provides

### 1. **Simulated Bluetooth Device**

- Mock ECG device automatically appears as "connected"
- No need for real Bluetooth permissions or scanning
- Instant connection without setup delays

### 2. **Mock Heart Rate Data**

- Realistic heart rate values (55-180 BPM)
- Natural variability and fluctuations
- Simulates different heart rate zones (Rest, Fat Burn, Cardio, Peak)

### 3. **Full App Flow**

- Complete onboarding process
- Device calibration (simulated)
- Start/pause/resume/end sessions
- Event marking and tracking
- Session summary with statistics

## Mock Configuration Options

In [config/mock-config.ts](config/mock-config.ts), you can customize:

```typescript
// Mock device details
MOCK_DEVICE = {
  id: "mock-ecg-device-001",
  name: "Mock ECG Device",
  rssi: -45, // Signal strength
  // ...
};

// Heart rate simulation
MOCK_HEART_RATE_CONFIG = {
  baseHeartRate: 75, // Average BPM
  variability: 10, // +/- variation
  minHeartRate: 55, // Minimum possible
  maxHeartRate: 180, // Maximum possible
  updateInterval: 1000, // Update frequency (ms)
};

// Bluetooth timing
MOCK_TIMING = {
  scanDuration: 2000, // Time to "discover" devices
  connectionDelay: 1500, // Time to "connect"
  disconnectChance: 0.02, // 2% chance of disconnect
};
```

## Visual Indicators

When mock mode is enabled, you'll see:

- **Pre-session screen**: Purple banner showing "Mock Mode Active"
- **Active session**: Purple header showing "MOCK MODE - Simulated Data"
- **Console logs**: Messages prefixed with 🎭 for mock operations

## Switching to Real Hardware

When you're ready to use real ECG hardware:

1. Set `ENABLE_MOCK_MODE = false` in [config/mock-config.ts](config/mock-config.ts)
2. Update device UUIDs in [services/bluetooth-service.ts](services/bluetooth-service.ts):
   ```typescript
   const ECG_SERVICE_UUID = "your-device-service-uuid";
   const ECG_CHARACTERISTIC_UUID = "your-device-characteristic-uuid";
   ```
3. Ensure proper Bluetooth permissions are set up in:
   - `android/app/src/main/AndroidManifest.xml` (Android)
   - `ios/capstoneecgapp/Info.plist` (iOS)
4. Test with your physical device

## Development Tips

### Testing Different Scenarios

You can modify mock behavior for different test cases:

```typescript
// Test high heart rate scenario
MOCK_HEART_RATE_CONFIG.baseHeartRate = 160;

// Test unstable connection
MOCK_TIMING.disconnectChance = 0.1; // 10% chance

// Test slow scanning
MOCK_TIMING.scanDuration = 5000; // 5 seconds
```

### Debugging

- Check console for 🎭 emoji messages indicating mock operations
- Mock mode bypasses all real Bluetooth operations
- No external services or APIs are called (except for calibration API mocks)

## Features Working in Mock Mode

✅ Device discovery and connection  
✅ Session recording (start/pause/resume/end)  
✅ Heart rate monitoring  
✅ Event marking  
✅ Session statistics (avg, min, max HR)  
✅ Session summary  
✅ Calibration flow (mocked)

## Troubleshooting

**Issue**: Mock mode not activating

- **Solution**: Verify `EXPO_PUBLIC_MOCK_MODE=DEV` in `.env`
- Restart the development server after changing the flag

**Issue**: Real hardware interfering

- **Solution**: Disable real Bluetooth on your test device temporarily
- Or ensure mock mode is properly enabled

**Issue**: Data looks unrealistic

- **Solution**: Adjust `MOCK_HEART_RATE_CONFIG` values to match your testing needs

## Architecture

Mock mode implementation locations:

- **Configuration**: `config/mock-config.ts`
- **Bluetooth Service**: `services/bluetooth-service.ts` (mock branches)
- **API Service**: `services/api-service.ts` (already has mock implementations)
- **UI Indicators**: `app/run-session.tsx`

Mock mode uses the same state management and stores as real mode, ensuring parity between development and production code paths.
