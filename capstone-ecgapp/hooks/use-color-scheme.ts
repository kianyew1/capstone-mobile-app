import { useColorScheme as useNativewindColorScheme } from "nativewind";

type AppColorScheme = "light" | "dark";

export function useColorScheme(): AppColorScheme {
  const { colorScheme } = useNativewindColorScheme();
  return colorScheme === "dark" ? "dark" : "light";
}

export function useThemeController() {
  const { colorScheme, setColorScheme, toggleColorScheme } =
    useNativewindColorScheme();

  return {
    colorScheme: colorScheme === "dark" ? "dark" : "light",
    setColorScheme,
    toggleColorScheme,
  };
}
