import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "in.sahay.app",
  appName: "Sahay",
  webDir: "dist/client",
  android: { allowMixedContent: false },
  // Dev only: CAP_START_PATH=/relay-test.html opens the relay test page instead of the app.
  server: process.env.CAP_START_PATH ? { appStartPath: process.env.CAP_START_PATH } : undefined,
};

export default config;
