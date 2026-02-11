# ECG Monitoring Mobile App 📱❤️

A React Native mobile app for real-time ECG monitoring and heart rate tracking, built with Expo and TypeScript.

## 🎭 Mock Mode for Development

**The app includes a complete mock mode** that simulates Bluetooth connectivity and ECG data, allowing you to develop and test the entire flow without physical hardware.

### Quick Start with Mock Mode

Mock mode is **enabled by default**. Just run the app and you can:

- ✅ Skip Bluetooth device pairing (mock device auto-connects)
- ✅ Run full ECG monitoring sessions
- ✅ See realistic heart rate data (55-180 BPM)
- ✅ Mark events and view session summaries
- ✅ Test all app features end-to-end

**Visual indicators**: Look for purple "Mock Mode" banners throughout the app.

**Configuration**: Toggle mock mode in `config/mock-config.ts`

```typescript
export const ENABLE_MOCK_MODE = true; // Set to false for real hardware
```

📖 **[Read full Mock Mode Documentation](MOCK_MODE.md)**

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction/).

## Features

- 📱 Bluetooth ECG device pairing and management
- ❤️ Real-time heart rate monitoring
- 📊 Heart rate zones (Rest, Fat Burn, Cardio, Peak)
- ⏱️ Session tracking (start/pause/resume/end)
- 🚩 Event marking during sessions
- 📈 Session summaries with statistics
- 🔧 Device calibration
- 🎭 **Complete mock mode for development**

## Project Structure

```
app/                  # Main application screens
  (onboarding)/      # Onboarding flow
  (tabs)/            # Tab navigation screens
  run-session.tsx    # Main ECG monitoring screen
components/          # Reusable UI components
  ui/               # shadcn-style UI components
config/             # App configuration
  mock-config.ts    # Mock mode settings
services/           # Business logic services
  bluetooth-service.ts  # Bluetooth connectivity
  api-service.ts        # Backend API calls
stores/             # Zustand state management
types/              # TypeScript type definitions
```

## Development

### Mock Mode (Default)

Develop without hardware - mock mode simulates everything:

```typescript
// config/mock-config.ts
export const ENABLE_MOCK_MODE = true;
```

### Real Hardware Mode

When you have ECG hardware:

1. Set `ENABLE_MOCK_MODE = false` in `config/mock-config.ts`
2. Update device UUIDs in `services/bluetooth-service.ts`
3. Configure Bluetooth permissions (Android/iOS)

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
