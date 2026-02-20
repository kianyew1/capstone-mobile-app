import { Stack } from "expo-router";

export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: "slide_from_right",
      }}
    >
      <Stack.Screen name="welcome" />
      <Stack.Screen name="account" />
      <Stack.Screen name="permissions" />
      <Stack.Screen name="bluetooth" />
    </Stack>
  );
}
