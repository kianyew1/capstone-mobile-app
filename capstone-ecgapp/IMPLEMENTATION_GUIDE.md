# ECG App - Implementation Guide

## Project Structure

```
app/
├── _layout.tsx              # Root layout with onboarding/main app navigation
├── index.tsx                # Redirect entry point
├── (onboarding)/            # Onboarding flow screens
│   ├── _layout.tsx          # Onboarding stack layout
│   ├── welcome.tsx          # Welcome/intro screen
│   ├── account.tsx          # Account creation screen
│   ├── permissions.tsx      # Permissions request screen
│   └── bluetooth.tsx        # Bluetooth pairing screen
├── (tabs)/                  # Main app tabs (after onboarding)
│   ├── _layout.tsx          # Tab navigation layout
│   ├── index.tsx            # Home/Summary screen
│   ├── explore.tsx          # History screen
│   └── settings.tsx         # Settings screen

stores/
├── index.ts                 # Store exports
└── app-store.ts             # Zustand store for app state

services/
├── index.ts                 # Service exports
└── bluetooth-service.ts     # BLE service hook

hooks/
└── use-permissions.ts       # Permissions management hook

types/
└── index.ts                 # TypeScript type definitions

components/
└── device-connection-card.tsx  # Reusable device connection UI
```

## Implemented Phases

### Phase 1: Account Creation + Permission Handling

- Welcome screen with app features overview
- Account creation form (name + email)
- Permission request screen for:
  - Bluetooth permissions (Android 12+)
  - Location permissions (required for BLE scanning)
- State persisted using Zustand + AsyncStorage

### Phase 2: Bluetooth Pairing (Hardware Handshake)

- BLE device scanning and discovery
- Device connection management
- Paired device persistence (remembers last connected device)
- Auto-reconnect on app launch
- Unpair and connect to different device option
- Connection status indicators throughout the app

## Key Dependencies Added

- `react-native-ble-plx` - Bluetooth Low Energy library
- `expo-location` - Location permissions for BLE
- `@react-native-async-storage/async-storage` - Persistent storage
- `zustand` - State management

## Configuration Updates

- **app.json**: Added BLE plugins and permissions
- **Info.plist**: iOS Bluetooth and location permissions
- **AndroidManifest.xml**: Android Bluetooth and location permissions

## Usage

### Running the App

```bash
# Start development server
npm start

# Run on iOS
npm run ios

# Run on Android
npm run android
```

### Resetting Onboarding (for testing)

Go to Settings tab → Reset Setup

### Testing Bluetooth

1. Complete onboarding up to the Bluetooth screen
2. Turn on your ECG device and put it in pairing mode
3. Scan for devices
4. Select your device to pair

## Next Phases to Implement

- Phase 3: Baseline Calibration
- Phase 4: Run Session (Active Monitoring)
- Phase 5: Post-Run Analysis
