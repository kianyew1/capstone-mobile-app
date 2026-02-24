import { useEffect, useState } from "react";
import { useColorScheme as useNativewindColorScheme } from "nativewind";

type AppColorScheme = "light" | "dark";

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web
 */
export function useColorScheme() {
  const [hasHydrated, setHasHydrated] = useState(false);
  const { colorScheme } = useNativewindColorScheme();

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  if (!hasHydrated) {
    return "light" as AppColorScheme;
  }

  return colorScheme === "dark" ? "dark" : "light";
}

export function useThemeController() {
  const [hasHydrated, setHasHydrated] = useState(false);
  const { colorScheme, setColorScheme, toggleColorScheme } =
    useNativewindColorScheme();

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  return {
    colorScheme:
      hasHydrated && colorScheme === "dark"
        ? ("dark" as AppColorScheme)
        : ("light" as AppColorScheme),
    setColorScheme,
    toggleColorScheme,
  };
}
