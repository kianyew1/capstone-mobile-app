import Constants from "expo-constants";
import { Platform } from "react-native";

const normalizeEnv = (value?: string) => value?.trim().toUpperCase();
const normalizeUrl = (value?: string) => value?.trim().replace(/\/+$/, "");

const DEV_BACKEND_PORT = "8001";
const PROD_BACKEND_URL = "https://capstone-mobile-app.onrender.com";

const getExpoHost = (): string | null => {
  const constantsObject = Constants as unknown as Record<string, unknown>;
  const expoConfig = (constantsObject["expoConfig"] ?? null) as Record<
    string,
    unknown
  > | null;
  const manifest2 = (constantsObject["manifest2"] ?? null) as Record<
    string,
    unknown
  > | null;
  const manifest = (constantsObject["manifest"] ?? null) as Record<
    string,
    unknown
  > | null;

  const manifest2Extra = (manifest2?.["extra"] ?? null) as Record<
    string,
    unknown
  > | null;
  const expoClient = (manifest2Extra?.["expoClient"] ?? null) as Record<
    string,
    unknown
  > | null;

  const hostUriCandidates = [
    expoConfig?.["hostUri"],
    expoClient?.["hostUri"],
    manifest?.["debuggerHost"],
  ];

  for (const candidate of hostUriCandidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const host = candidate.split(":")[0]?.trim();
    if (host) return host;
  }

  return null;
};

const getDevBackendBaseUrl = (): string => {
  const explicitUrl = normalizeUrl(process.env.EXPO_PUBLIC_BACKEND_BASE_URL);
  if (explicitUrl) return explicitUrl;

  if (Platform.OS === "android") {
    const expoHost = getExpoHost();
    if (expoHost) return `http://${expoHost}:${DEV_BACKEND_PORT}`;
    return `http://10.0.2.2:${DEV_BACKEND_PORT}`;
  }

  return `http://127.0.0.1:${DEV_BACKEND_PORT}`;
};

const defaultAppEnv = __DEV__ ? "DEV" : "PROD";
const rawAppEnv = normalizeEnv(process.env.EXPO_PUBLIC_APP_ENV);
const resolvedAppEnv =
  rawAppEnv === "PROD" ? "PROD" : rawAppEnv === "DEV" ? "DEV" : defaultAppEnv;

export const APP_ENV = resolvedAppEnv;
export const IS_DEV_ENV = APP_ENV === "DEV";
export const BACKEND_BASE_URL = IS_DEV_ENV
  ? getDevBackendBaseUrl()
  : PROD_BACKEND_URL;
