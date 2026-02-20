# React Native Reusables - Quick Start

Your React Native project has been successfully set up with React Native Reusables, Nativewind, and Tailwind CSS!

## 🚀 Quick Commands

### Start Development

```bash
# Navigate to project
cd /Users/kianyew/Desktop/projects/capstone/ky-mobile-app/capstone-ecgapp

# Start for Android (using your installed Android Studio)
npm run android

# Start for iOS
npm run ios

# Start for Web
npm run web
```

### Add New Components

```bash
# Add a button component
npx @react-native-reusables/cli@latest add button

# Add more components (card, input, dialog, etc.)
npx @react-native-reusables/cli@latest add [component-name]
```

## 📁 Project Structure

```
capstone-ecgapp/
├── app/                    # Expo Router routes
├── components/
│   └── ui/                 # UI components (Button, Text)
├── lib/
│   ├── cn.ts              # Class name helper
│   └── theme.ts           # Theme colors
├── global.css             # Tailwind + color variables
├── tailwind.config.js     # Tailwind configuration
├── metro.config.js        # Metro bundler config
└── babel.config.js        # Babel with Nativewind
```

## 🎨 What's Included

✅ **React Native Reusables** - Pre-built, accessible UI components
✅ **Nativewind** - Tailwind CSS for React Native  
✅ **Tailwind CSS** - Utility-first CSS framework
✅ **Expo Router** - File-based routing
✅ **TypeScript** - Full type safety
✅ **Android & iOS** - Native builds ready to go
✅ **Web Support** - Responsive web app support

## 💡 Usage Examples

### Using a Button

```tsx
import { Button } from "@/components/ui/button";

export default function Screen() {
  return (
    <Button
      label="Click me"
      onPress={() => alert("Pressed!")}
      className="bg-accent"
    />
  );
}
```

### Using Tailwind Classes

```tsx
import { View, Text } from "react-native";

export default function Screen() {
  return (
    <View className="flex-1 p-4 bg-background gap-4">
      <Text className="text-2xl font-bold text-foreground">Hello World</Text>
    </View>
  );
}
```

### Merging Classes with cn()

```tsx
import { cn } from "@/lib/cn";

const buttonClass = cn(
  "px-4 py-2 rounded-lg bg-primary",
  isDisabled && "opacity-50",
);
```

## 🎯 Next Steps

1. **Open Android Studio** with the `android/` directory to set up emulator/device
2. **Run `npm run android`** to start the app
3. **Edit files in `app/` directory** to build your app
4. **Add components** using the CLI command above
5. **Customize theme** in `global.css` and `tailwind.config.js`

## 📚 Documentation

- **React Native Reusables**: https://reactnativereusables.com/
- **Nativewind**: https://www.nativewind.dev/
- **Tailwind CSS**: https://tailwindcss.com/
- **Expo**: https://docs.expo.dev/
- **Expo Router**: https://expo.github.io/router/

## ⚙️ Configuration Files

### `global.css`

Contains Tailwind directives and CSS variables for theming. Colors use HSL format for easy adjustment.

### `tailwind.config.js`

Extends Tailwind with color variables and presets from Nativewind.

### `babel.config.js`

Configured with `nativewind/babel` preset for proper compilation.

### `metro.config.js`

Configured with Nativewind integration for CSS processing.

### `app.json`

Expo configuration with Android/iOS settings.

## 🐛 Troubleshooting

### Build fails with missing modules

```bash
npm install
```

### Cache issues

```bash
npm start -- --clear
```

### Port 8081 already in use

Expo will automatically use a different port. You can also specify one:

```bash
npm run web -- --port 3000
```

## 📝 Environment Setup

- ✅ Android Studio installed
- ✅ Xcode installed (for iOS)
- ✅ CocoaPods installed (automatically configured)
- ✅ Node.js and npm configured
- ✅ TypeScript configured
- ✅ All dependencies installed

## 🎉 You're all set!

Your project is ready to use. Start building amazing React Native apps with React Native Reusables and Nativewind!

For more detailed setup information, see `SETUP_GUIDE.md`
