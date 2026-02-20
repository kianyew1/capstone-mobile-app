const normalizeEnv = (value?: string) => value?.trim().toUpperCase();

const defaultAppEnv = __DEV__ ? "DEV" : "PROD";
const rawAppEnv = normalizeEnv(process.env.EXPO_PUBLIC_APP_ENV);
const resolvedAppEnv =
  rawAppEnv === "PROD"
    ? "PROD"
    : rawAppEnv === "DEV"
      ? "DEV"
      : defaultAppEnv;

export const APP_ENV = resolvedAppEnv;
export const IS_DEV_ENV = APP_ENV === "DEV";
export const BACKEND_BASE_URL = IS_DEV_ENV
  ? "http://127.0.0.1:8001"
  : "https://capstone-mobile-app.onrender.com";
