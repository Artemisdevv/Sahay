import { API_BASE } from "@/lib/api";
import { ensureDeviceToken, getOrCreateIdentity } from "@/lib/device-identity";
import { secureStorage } from "@/native/secure-storage";
import { SahayNearby } from "@/native/sahay-nearby";
import {
  attachRelayListeners,
  isRelayEnabled,
  relayStartedFor,
  setRelayEnabledFlag,
  startRelay,
  stopRelay,
} from "./relay";
import { Capacitor } from "@capacitor/core";
import {
  audioBytesToBase64,
  buildEnvelope,
  isoSeconds,
  PayloadError,
  type Category,
  type ReportPayload,
} from "./envelope";
import { captureLocation, type CapturedLocation } from "./location";
import { ReportQueue, type QueueItem } from "./queue";
import { ensureServerKey, refreshServerKey } from "./server-key";
import { flushReports, type FlushResult } from "./uploader";

/**
 * Glue for the civilian report flow (F-03): build -> seal + sign -> save in the local queue -> upload when possible.
 * Saving to the queue is the moment a report is "safe"; sending happens in the background and survives restarts.
 * UI code uses submitReport(), listReports() and startReportSync() only.
 */
export class NotReadyError extends Error {}

let queue: ReportQueue | null = null;
const getQueue = () => (queue ??= new ReportQueue());

export interface SubmitInput {
  kind?: "report" | "sos";
  category: Category;
  language?: string;
  audio?: { blob: Blob; seconds: number };
  text?: string;
  location?: CapturedLocation;
  reporter?: { name?: string; phone?: string };
  emergency_contact?: { name?: string; phone?: string };
}

export interface SubmitResult {
  item: QueueItem;
  /** true when the position is not a fresh GPS fix */
  approximateLocation: boolean;
}

export async function submitReport(input: SubmitInput): Promise<SubmitResult> {
  const serverKey = await ensureServerKey();
  if (!serverKey) {
    throw new NotReadyError(
      "This phone needs the internet once to get ready. Connect and try again, or call 112.",
    );
  }
  const identity = await getOrCreateIdentity(secureStorage);
  const location = input.location ?? (await captureLocation());
  const now = new Date();
  const payload: ReportPayload = {
    schema: 1,
    kind: input.kind ?? "report",
    category: input.category,
    language: input.language ?? "en",
    captured_at: isoSeconds(now),
    location: {
      lat: location.lat,
      lng: location.lng,
      accuracy_m: location.accuracy_m,
    },
    text: input.text?.trim() ? input.text.trim() : null,
    ...(input.reporter ? { reporter: input.reporter } : {}),
    ...(input.emergency_contact
      ? { emergency_contact: input.emergency_contact }
      : {}),
  };
  if (input.audio) {
    const bytes = new Uint8Array(await input.audio.blob.arrayBuffer());
    payload.audio = {
      mime: input.audio.blob.type || "audio/webm",
      data: audioBytesToBase64(bytes),
      duration_s: input.audio.seconds,
    };
  }
  const envelope = await buildEnvelope(payload, identity, serverKey, { now });
  const item: QueueItem = {
    report_id: envelope.report_id,
    envelope,
    category: input.category,
    created_at: envelope.created_at,
    state: "queued",
    attempts: 0,
    next_attempt_at: 0,
  };
  await getQueue().put(item);
  void handOffToRelay(envelope);
  void syncNow();
  return { item, approximateLocation: location.approximate };
}

export const listReports = () => getQueue().all();

export interface ReportStatus {
  status: string;
  message: string;
}

/** Latest status of one of our reports (GET /reports/{id}/status). Null when offline or not known yet. */
export async function fetchStatus(
  reportId: string,
): Promise<ReportStatus | null> {
  try {
    const token = await ensureDeviceToken(secureStorage);
    const response = await fetch(`${API_BASE}/reports/${reportId}/status`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<ReportStatus>;
    return typeof body.status === "string"
      ? { status: body.status, message: body.message ?? "" }
      : null;
  } catch {
    return null;
  }
}

export async function retryFailedNow(reportId: string): Promise<void> {
  await getQueue().update(reportId, { state: "queued", next_attempt_at: 0 });
  void syncNow();
}

/**
 * Nearby relay (Android only). Runs on every phone from app start (not only when it sends), so a phone with no
 * reports of its own can still carry other people's sealed reports. Best effort: without permissions or a cached
 * server key the internet path still works.
 */
let relayStarting: Promise<boolean> | null = null;
export function ensureRelay(): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || !isRelayEnabled())
    return Promise.resolve(false);
  relayStarting ??= (async () => {
    try {
      const key = await ensureServerKey();
      if (!key) return false; // receipts cannot be verified without the server key: wait until the app is online once
      const { deviceId } = await getOrCreateIdentity(secureStorage);
      if (relayStartedFor() === deviceId) return true;
      return await startRelay(deviceId, key.ed25519_public_key);
    } finally {
      relayStarting = null;
    }
  })();
  return relayStarting;
}

/** Settings switch: turn the relay on or off now and remember the choice. */
export async function setRelayEnabled(on: boolean): Promise<boolean> {
  setRelayEnabledFlag(on);
  if (!on) {
    await stopRelay();
    return false;
  }
  return ensureRelay();
}

async function handOffToRelay(envelope: QueueItem["envelope"]): Promise<void> {
  try {
    if (await ensureRelay()) await SahayNearby.enqueue({ envelope });
  } catch {
    /* radio off or permission denied: the internet path still works */
  }
}

let flushing: Promise<FlushResult> | null = null;

/** Single-flight: concurrent triggers (online event, timer, new report) share one run. */
export function syncNow(): Promise<FlushResult> {
  flushing ??= (async () => {
    try {
      return await flushReports({
        queue: getQueue(),
        getToken: () => ensureDeviceToken(secureStorage),
        apiBase: API_BASE,
        serverKey: () => ensureServerKey(),
        relay: Capacitor.isNativePlatform() ? SahayNearby : undefined,
      });
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/**
 * Call once at app start. Keeps the server key fresh, flushes the queue when the phone comes online, when the app
 * returns to the foreground and every 30 s while there is something waiting. Returns a stop function.
 */
export function startReportSync(onChange?: () => void): () => void {
  const run = () => {
    void refreshServerKey()
      .catch(() => {}) // offline is fine: the cached key is used
      .then(() => ensureRelay());
    void syncNow()
      .then(() => onChange?.())
      .catch(() => {});
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") run();
  };
  run();
  void ensureRelay();
  let removeListeners: () => void = () => {};
  void attachRelayListeners({
    queue: getQueue(),
    syncNow,
    onChange,
  }).then((remove) => (removeListeners = remove));
  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(() => {
    void getQueue()
      .due(Date.now())
      .then((due) => {
        if (due.length) run();
      })
      .catch(() => {});
  }, 30_000);
  return () => {
    window.removeEventListener("online", run);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
    removeListeners();
  };
}

export { PayloadError };
