import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
} from "@react-navigation/native";
import { Stack, router } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import "react-native-reanimated";
import "../global.css";

import { useColorScheme } from "@/hooks/use-color-scheme";
import { useAppStore } from "@/stores/app-store";
import { PortalHost } from "@rn-primitives/portal";

// Prevent the splash screen from auto-hiding
SplashScreen.preventAutoHideAsync();

export const unstable_settings = {
  initialRouteName: "(onboarding)",
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [isReady, setIsReady] = useState(false);
  const { isOnboardingComplete } = useAppStore();

  useEffect(() => {
    // Prepare app and check onboarding status
    const prepare = async () => {
      try {
        // Small delay to ensure store is hydrated
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (e) {
        console.warn(e);
      } finally {
        setIsReady(true);
        await SplashScreen.hideAsync();
      }
    };

    prepare();
  }, []);

  useEffect(() => {
    if (isReady) {
      // Navigate based on onboarding status
      if (isOnboardingComplete) {
        router.replace("/(tabs)");
      } else {
        router.replace("/(onboarding)/welcome");
      }
    }
  }, [isReady, isOnboardingComplete]);

  if (!isReady) {
    return null;
  }

  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(onboarding)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="calibration"
          options={{
            presentation: "modal",
            title: "Device Calibration",
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="run-session"
          options={{
            title: "Run Session",
            headerShown: false,
            gestureEnabled: false, // Prevent accidental swipe back during session
          }}
        />
        <Stack.Screen
          name="run-summary"
          options={{
            title: "Session Summary",
            headerShown: false,
            gestureEnabled: false, // Keep user on summary until they tap Done
          }}
        />
        <Stack.Screen
          name="activity-calendar"
          options={{
            title: "Activity Calendar",
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="modal"
          options={{ presentation: "modal", title: "Modal", headerShown: true }}
        />
      </Stack>
      <StatusBar style="auto" />
      <PortalHost />
    </ThemeProvider>
  );
}
