// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// `npm run build:app` (CAPACITOR=1) emits a static SPA in dist/client for the Android WebView: no SSR server,
// no Cloudflare worker. The default build is unchanged, so the Lovable preview and deploy keep working.
const staticApp = process.env["CAPACITOR"] === "1";

export default defineConfig({
  ...(staticApp ? { nitro: false as const } : {}),
  tanstackStart: staticApp
    ? { spa: { enabled: true } }
    : {
        // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
        // nitro/vite builds from this
        server: { entry: "server" },
      },
});
