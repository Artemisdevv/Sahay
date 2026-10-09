import sodium from "libsodium-wrappers";
import type { ReportEnvelope } from "@/native/sahay-nearby";
import type { DeviceIdentity } from "@/lib/device-identity";

/**
 * Report payload and envelope, exactly as in docs/api-contract.md sections 1.1 and 1.2.
 * The payload is sealed to the server X25519 key (crypto_box_seal), then the envelope is signed with the device
 * Ed25519 key over `report_id|device_id|created_at|` + raw ciphertext. `ttl` and `hops` are not signed.
 * Everything that leaves the app (HTTP, Nearby relay, local queue) is this sealed envelope: no plaintext.
 */
export const CATEGORIES = [
  "accident",
  "fire",
  "medical",
  "crime",
  "flood",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const MAX_AUDIO_BYTES = 200 * 1024;
export const DEFAULT_TTL = 5;

export interface ServerKey {
  key_id: string;
  x25519_public_key: string;
  ed25519_public_key: string;
}

export interface ReportPayload {
  schema: 1;
  kind: "report" | "sos";
  category: Category;
  language: string;
  captured_at: string;
  location: { lat: number; lng: number; accuracy_m?: number };
  audio?: { mime: string; data: string; duration_s: number } | undefined;
  text?: string | null;
  reporter?: { name?: string; phone?: string };
  emergency_contact?: { name?: string; phone?: string };
}

export class PayloadError extends Error {}

const b64 = (raw: Uint8Array) =>
  sodium.to_base64(raw, sodium.base64_variants.ORIGINAL);
const unb64 = (s: string) =>
  sodium.from_base64(s, sodium.base64_variants.ORIGINAL);

/** ISO-8601 UTC without milliseconds, as in the contract examples. */
export const isoSeconds = (d: Date) =>
  d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function audioBytesToBase64(bytes: Uint8Array): string {
  return b64(bytes);
}

/** Throws PayloadError with a message fit for the user when the report could not be accepted by the server. */
export function validatePayload(p: ReportPayload): ReportPayload {
  if (!CATEGORIES.includes(p.category))
    throw new PayloadError("Choose what is happening.");
  const { lat, lng } = p.location;
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  )
    throw new PayloadError("The location is not valid.");
  const hasText = !!p.text && p.text.trim().length > 0;
  if (!p.audio && !hasText) throw new PayloadError("Add a message to send.");
  if (p.audio) {
    const size = unb64(p.audio.data).length;
    if (size > MAX_AUDIO_BYTES)
      throw new PayloadError(
        "The recording is too long. Record a shorter one.",
      );
  }
  return p;
}

export async function sealPayload(
  payload: ReportPayload,
  serverKey: ServerKey,
): Promise<Uint8Array> {
  await sodium.ready;
  const plain = new TextEncoder().encode(
    JSON.stringify(validatePayload(payload)),
  );
  return sodium.crypto_box_seal(plain, unb64(serverKey.x25519_public_key));
}

export function signingInput(
  reportId: string,
  deviceId: string,
  createdAt: string,
  ciphertext: Uint8Array,
): Uint8Array {
  const prefix = new TextEncoder().encode(
    `${reportId}|${deviceId}|${createdAt}|`,
  );
  const msg = new Uint8Array(prefix.length + ciphertext.length);
  msg.set(prefix);
  msg.set(ciphertext, prefix.length);
  return msg;
}

export interface BuildOptions {
  now?: Date;
  reportId?: string;
  ttl?: number;
}

export async function buildEnvelope(
  payload: ReportPayload,
  identity: Pick<DeviceIdentity, "deviceId" | "seed">,
  serverKey: ServerKey,
  options: BuildOptions = {},
): Promise<ReportEnvelope> {
  const ciphertext = await sealPayload(payload, serverKey);
  const reportId = options.reportId ?? crypto.randomUUID();
  const createdAt = isoSeconds(options.now ?? new Date());
  const key = sodium.crypto_sign_seed_keypair(identity.seed).privateKey;
  const signature = sodium.crypto_sign_detached(
    signingInput(reportId, identity.deviceId, createdAt, ciphertext),
    key,
  );
  return {
    envelope_version: 1,
    report_id: reportId,
    device_id: identity.deviceId,
    created_at: createdAt,
    ttl: options.ttl ?? DEFAULT_TTL,
    key_id: serverKey.key_id,
    ciphertext: b64(ciphertext),
    signature: b64(signature),
  };
}

/** Receipt check: Ed25519 over UTF-8 `report_id|server_time` with the server signing key. */
export async function verifyReceipt(
  reportId: string,
  receipt: { server_time: string; signature: string },
  serverKey: ServerKey,
): Promise<boolean> {
  await sodium.ready;
  try {
    return sodium.crypto_sign_verify_detached(
      unb64(receipt.signature),
      new TextEncoder().encode(`${reportId}|${receipt.server_time}`),
      unb64(serverKey.ed25519_public_key),
    );
  } catch {
    return false;
  }
}
