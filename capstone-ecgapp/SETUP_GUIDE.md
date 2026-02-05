# React Native Reusables Setup Guide

This project has been successfully set up with React Native Reusables and Nativewind as the main UI library.

## Project Structure

```
capstone-ecgapp/
├── app/                          # Expo Router app directory
│   ├── (tabs)/                   # Tab-based navigation
│   │   ├── index.tsx             # Home screen
│   │   ├── explore.tsx           # Explore screen
│   │   └── _layout.tsx           # Tab layout
│   ├── _layout.tsx               # Root layout with PortalHost
│   └── modal.tsx                 # Modal example
├── components/                   # React components
│   └── ui/                       # UI components (Button, Text, etc.)
│       ├── button.tsx
│       ├── text.tsx
│       └── index.ts
├── lib/                          # Utilities and helpers
│   ├── cn.ts                     # Class name merger
│   └── theme.ts                  # Theme configuration
├── global.css                    # Tailwind CSS with color variables
├── tailwind.config.js            # Tailwind CSS configuration
├── metro.config.js               # Metro bundler configuration
├── babel.config.js               # Babel configuration with Nativewind
└── components.json               # Component registry
```

## Installed Dependencies

### Core

- **expo** - Framework for React Native
- **expo-router** - Navigation
- **react-native** - Core framework
- **react-navigation** - Navigation primitives

### UI Library Stack

- **nativewind** - Tailwind CSS for React Native
- **tailwindcss** - CSS utility framework
- **class-variance-authority** - Component variant management
- **clsx** - Conditional class names
- **tailwind-merge** - Merge Tailwind classes
- **tailwindcss-animate** - Animation utilities

### React Native Primitives

- **@rn-primitives/portal** - Portal component for dialogs/modals
- **@rn-primitives/hooks** - Utility hooks
- **@react-native-menu/menu** - Menu primitives
- **@react-native-segmented-control/segmented-control** - Segmented control

## Getting Started

### 1. Run for Android

```bash
cd capstone-ecgapp
npm run android
```

This requires Android Studio to be installed and configured (which you already have).

### 2. Run for iOS

```bash
npm run ios
```

Requires Xcode and CocoaPods (already installed).

### 3. Run for Web

```bash
npm run web
```

Starts a web development server.

## Adding Components

To add components from React Native Reusables, use the CLI:

```bash
npx @react-native-reusables/cli@latest add button
```

This will download and add the component to `components/ui/`.

### Example: Using the Button Component

```tsx
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

export default function Screen() {
  return <Button label="Click me" onPress={() => alert("Button pressed!")} />;
}
```

## Customizing Theme

Colors are defined in `global.css` using CSS variables:

```css
:root {
  --primary: 0 0% 0%;
  --secondary: 0 0% 100%;
  --accent: 217.2 91.2% 59.8%;
  --background: 0 0% 100%;
  --foreground: 0 0% 0%;
  /* ... more colors ... */
}

.dark {
  --primary: 0 0% 100%;
  --secondary: 0 0% 0%;
  /* ... dark mode colors ... */
}
```

Update these to match your app's design system.

## Class Name Merging

Use the `cn()` helper to merge Tailwind classes:

```tsx
import { cn } from "@/lib/cn";

const className = cn(
  "px-4 py-2 rounded-md bg-primary",
  isActive && "opacity-80",
);
```

## Development Workflow

### Clear Cache

If you encounter build issues, clear the Metro bundler cache:

```bash
npm start -- --clear
```

### TypeScript

The project is configured with strict TypeScript. All components use TypeScript for type safety.

### ESLint

Run ESLint to check code quality:

```bash
npm run lint
```

## Next Steps

1. Replace the default home screen with your app's UI
2. Add more components using the React Native Reusables CLI
3. Customize the theme colors in `global.css`
4. Build and deploy to Android/iOS

## Resources

- [React Native Reusables Docs](https://reactnativereusables.com/)
- [Nativewind Docs](https://www.nativewind.dev/)
- [Expo Documentation](https://docs.expo.dev/)
- [Tailwind CSS Docs](https://tailwindcss.com/)

## Common Issues

### Port already in use

If port 8081 is in use, Expo will prompt you to use another port.

### Git repository dirty

You may see warnings about uncommitted changes. Commit your changes or use the `--no-commit` flag if prebuilding.

### Prebuild issues

If prebuild fails, ensure you have:

- Xcode installed (for iOS)
- Android Studio installed and configured (for Android)
- CocoaPods installed (for iOS dependencies)
