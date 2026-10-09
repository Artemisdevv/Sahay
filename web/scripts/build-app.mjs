// Static SPA build for the Android WebView (Capacitor). Output: dist/client with an index.html entry.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";

const vite = spawnSync("npx", ["vite", "build"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, CAPACITOR: "1" },
});
if (vite.status !== 0) process.exit(vite.status ?? 1);

// TanStack Start writes the SPA entry as _shell.html; Capacitor serves index.html.
if (!existsSync("dist/client/_shell.html")) {
  console.error("dist/client/_shell.html missing: SPA build did not run");
  process.exit(1);
}
copyFileSync("dist/client/_shell.html", "dist/client/index.html");
console.log("app build ready in dist/client");
