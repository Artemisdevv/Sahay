import { Capacitor } from "@capacitor/core";
import { API_BASE } from "@/lib/api";
import { SahayNearby } from "@/native/sahay-nearby";
import type { ReportQueue } from "./queue";

/**
 * App side of the Nearby relay (Android only). Every phone running the app is both a sender and a relay:
 *  - it advertises and discovers nearby Sahay phones (plugin `SahayNearby`, see docs/api-contract.md section 5),
 *  - it carries other people's sealed envelopes without ever opening them (they are encrypted to the server),
 *  - when it has internet it uploads what it carries, and the server receipt travels back along the same path.
 * The UI never shows carried reports: only how many phones are nearby.
 */
const FLAG = "sahay.relay.enabled.v1";

export const relaySupported = () => Capacitor.isNativePlatform();

export function isRelayEnabled(): boolean {
  try {
    return window.localStorage.getItem(FLAG) !== "0"; // on by default
  } catch {
    return true;
  }
}

export function setRelayEnabledFlag(on: boolean): void {
  try {
    window.localStorage.setItem(FLAG, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export interface RelayState {
  running: boolean;
  nearby: number;
}
let state: RelayState = { running: false, nearby: 0 };
const watchers = new Set<(s: RelayState) => void>();
const publish = (patch: Partial<RelayState>) => {
  state = { ...state, ...patch };
  watchers.forEach((w) => w(state));
};
export const getRelayState = () => state;
export function watchRelay(cb: (s: RelayState) => void): () => void {
  watchers.add(cb);
  return () => void watchers.delete(cb);
}

let startedFor: string | null = null;

/** Start (or re-apply) advertising and discovery. Resolves false when permissions or the radio are missing. */
export async function startRelay(
  deviceId: string,
  serverVerifyKey: string,
): Promise<boolean> {
  if (!relaySupported()) return false;
  try {
    await SahayNearby.start({
      deviceId,
      mode: "both",
      serverVerifyKey,
      apiBase: API_BASE,
    });
    startedFor = deviceId;
    publish({ running: true });
    return true;
  } catch {
    publish({ running: false });
    return false;
  }
}

export async function stopRelay(): Promise<void> {
  startedFor = null;
  publish({ running: false, nearby: 0 });
  if (relaySupported()) await SahayNearby.stop().catch(() => {});
}

export const relayStartedFor = () => startedFor;

export interface ListenerDeps {
  queue: ReportQueue;
  /** Upload what we carry as soon as something new arrives. */
  syncNow: () => Promise<unknown>;
  onChange?: (() => void) | undefined;
}

/** Wire native events to the queue. Returns a function that removes the listeners. */
export async function attachRelayListeners(
  deps: ListenerDeps,
): Promise<() => void> {
  if (!relaySupported()) return () => {};
  const handles = await Promise.all([
    SahayNearby.addListener("peerConnected", () =>
      publish({ nearby: state.nearby + 1 }),
    ),
    SahayNearby.addListener("peerLost", () =>
      publish({ nearby: Math.max(0, state.nearby - 1) }),
    ),
    // Someone else's sealed report arrived. We cannot read it; if we are online, upload it now.
    SahayNearby.addListener("envelopeReceived", () => {
      void deps.syncNow().then(() => deps.onChange?.());
    }),
    // The server receipt for OUR report came back through the relay (the plugin already verified the signature).
    SahayNearby.addListener("receiptReceived", ({ reportId, receipt }) => {
      void (async () => {
        const item = await deps.queue.get(reportId);
        if (!item || item.state === "sent") return;
        await deps.queue.update(reportId, {
          state: "sent",
          via: "relay",
          receipt,
          receipt_verified: true,
          last_error: undefined,
        });
        await SahayNearby.markDelivered({ reportId }).catch(() => {});
        deps.onChange?.();
      })();
    }),
    SahayNearby.addListener(
      "statusReceived",
      ({ reportId, status, message }) => {
        void (async () => {
          if (!(await deps.queue.get(reportId))) return;
          await deps.queue.update(reportId, {
            relay_status: { status, message },
          });
          deps.onChange?.();
        })();
      },
    ),
  ]);
  return () => handles.forEach((h) => void h.remove());
}
