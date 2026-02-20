import { Redirect } from "expo-router";

export default function Index() {
  // This file acts as a redirect - the actual routing is handled in _layout.tsx
  return <Redirect href="/(onboarding)/welcome" />;
}
