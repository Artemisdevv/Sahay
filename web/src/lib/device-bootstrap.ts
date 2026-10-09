import { ensureDeviceToken, type RegisterOptions } from "@/lib/device-identity";
import type { SecretStore } from "@/native/secure-storage";

/**
 * Registers the device and keeps its token fresh in the background, so the user never waits for it.
 *
 * Call once when the app starts (`startDeviceBootstrap(secureStorage)`). It never throws and never blocks the UI:
 * - First launch with a network: identity is created and registered while the screen is loading.
 * - No network: it stays quiet and tries again when the browser reports `online`, and on a slow back-off.
 * - Reports do not wait for it: they are signed with the device key and queued, and only upload needs a token.
 */
export interface BootstrapOptions extends RegisterOptions {
  /** Retry delays in ms after a failure; the last value repeats. */
  backoffMs?: number[];
  setTimeoutFn?: typeof setTimeout;
  onlineTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
  onStatus?: (status: "ready" | "waiting") => void;
}

export function startDeviceBootstrap(
  store: SecretStore,
  options: BootstrapOptions = {},
): () => void {
  const backoff = options.backoffMs ?? [2_000, 10_000, 30_000, 120_000];
  const later = options.setTimeoutFn ?? setTimeout;
  const target =
    options.onlineTarget ??
    (typeof window !== "undefined" ? window : undefined);
  let attempt = 0;
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await ensureDeviceToken(store, options);
      attempt = 0;
      options.onStatus?.("ready");
    } catch {
      options.onStatus?.("waiting");
      const delay = backoff[Math.min(attempt, backoff.length - 1)];
      attempt += 1;
      timer = later(() => void run(), delay);
    } finally {
      running = false;
    }
  };

  const onOnline = () => {
    if (timer) clearTimeout(timer);
    void run();
  };
  target?.addEventListener("online", onOnline);
  void run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    target?.removeEventListener("online", onOnline);
  };
}
