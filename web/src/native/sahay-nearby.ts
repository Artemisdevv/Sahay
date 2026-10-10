import { WebPlugin, registerPlugin } from "@capacitor/core";

/** Types follow docs/api-contract.md section 5. snake_case fields are the wire format, camelCase are plugin args. */
export interface Receipt {
  server_time: string;
  signature: string;
}

export interface ReportEnvelope {
  envelope_version: 1;
  report_id: string;
  device_id: string;
  created_at: string;
  ttl: number;
  hops?: number;
  key_id: string;
  ciphertext: string;
  signature: string;
}

export type RelayMode = "advertise" | "discover" | "both";

export interface SahayNearbyPlugin {
  /** serverVerifyKey = `ed25519_public_key` from GET /config/server-key. Receipts and statuses that do not verify are dropped. */
  start(opts: {
    deviceId: string;
    mode: RelayMode;
    serverVerifyKey: string;
    /** Base URL of the API (`.../api/v1`). The native layer uploads carried reports there while the screen is off. */
    apiBase?: string;
  }): Promise<void>;
  stop(): Promise<void>;
  /** Hand our own new report to the native queue so it is forwarded to nearby phones. */
  enqueue(opts: { envelope: ReportEnvelope }): Promise<void>;
  /** The report was delivered (uploaded or receipt verified): stop carrying it. */
  markDelivered(opts: { reportId: string }): Promise<void>;
  /** After uploading someone else's report: return the server receipt along the path it arrived on. */
  relayReceipt(opts: { reportId: string; receipt: Receipt }): Promise<void>;
  /** `signature` and `updatedAt` come from GET /reports/{id}/status. */
  relayStatus(opts: {
    reportId: string;
    status: string;
    message: string;
    signature: string;
    updatedAt: string;
  }): Promise<void>;
  /** Everything carried and not yet delivered (own and others'), for upload when this phone gets online. */
  pendingForUpload(): Promise<{ envelopes: ReportEnvelope[] }>;
  /** Reports carried for other people. The UI shows only this count, never contents. */
  carryingCount(): Promise<{ count: number }>;
  addListener(
    event: "peerConnected" | "peerLost",
    cb: (e: { peerId: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: "envelopeReceived",
    cb: (e: { envelope: ReportEnvelope; fromPeer: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: "receiptReceived",
    cb: (e: { reportId: string; receipt: Receipt }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: "statusReceived",
    cb: (e: { reportId: string; status: string; message: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/** Browser and PWA: there is no Nearby. Reads return empty, anything that would need the radio rejects. */
const notAvailable = () =>
  Object.assign(
    new Error("Nearby relay is only available in the Android app"),
    { code: "UNAVAILABLE" },
  );

class SahayNearbyWeb extends WebPlugin implements Partial<SahayNearbyPlugin> {
  start = () => Promise.reject<void>(notAvailable());
  stop = async () => {};
  enqueue = () => Promise.reject<void>(notAvailable());
  markDelivered = async () => {};
  relayReceipt = async () => {};
  relayStatus = async () => {};
  pendingForUpload = async () => ({ envelopes: [] as ReportEnvelope[] });
  carryingCount = async () => ({ count: 0 });
}

export const SahayNearby = registerPlugin<SahayNearbyPlugin>("SahayNearby", {
  web: () => new SahayNearbyWeb() as unknown as SahayNearbyPlugin,
});
