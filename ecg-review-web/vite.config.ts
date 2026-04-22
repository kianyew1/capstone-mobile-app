import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  //const backendTarget = env.VITE_BACKEND_URL || "http://127.0.0.1:8001";
  const backendTarget = "http://127.0.0.1:8001";

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: backendTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  };
});
