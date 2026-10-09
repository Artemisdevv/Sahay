import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "in.sahay.app",
  appName: "Sahay",
  webDir: "dist/client",
  // Dev builds (CAP_DEV=1) may call a plain-http backend over adb reverse. Production talks https only.
  android: { allowMixedContent: process.env.CAP_DEV === "1" },
  // Native HTTP for fetch/XHR: no CORS preflight (one round trip per call instead of two) and no mixed-content limits.
  plugins: { CapacitorHttp: { enabled: true } },
  // Dev only: CAP_START_PATH=/relay-test.html opens the relay test page instead of the app.
  server: process.env.CAP_START_PATH ? { appStartPath: process.env.CAP_START_PATH } : undefined,
};

export default config;
