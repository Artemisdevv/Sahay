import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "in.sahay.app",
  appName: "Sahay",
  webDir: "dist/client",
  android: { allowMixedContent: false },
};

export default config;
