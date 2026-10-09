import sodium from "libsodium-wrappers";
import { API_BASE } from "@/lib/api";
import type { SecretStore } from "@/native/secure-storage";

/**
 * A civilian's identity is a random device_id plus an Ed25519 key pair made on the phone. The private key (as a
 * 32-byte seed) and the bearer token live only in secure storage. The token is obtained by proving possession of
 * the key: fetch a challenge, sign it, send the signature (api-contract.md section 2.1). Reports are signed with
 * the same key, so a report is attributable to this device and nobody else can mint its token.
 */
const KEYS = { id: "device.id", seed: "device.seed", token: "device.token" } as const;
const REFRESH_MARGIN_SECONDS = 10 * 60;

export interface DeviceIdentity {
  deviceId: string;
  /** base64 Ed25519 public key, as sent to /auth/register-device */
  publicKey: string;
  /** 32-byte Ed25519 seed. Never log it, never send it anywhere. */
  seed: Uint8Array;
}

export interface RegisterOptions {
  apiBase?: string;
  fetchFn?: typeof fetch;
  language?: string;
  now?: () => number; // seconds
}

export class RegisterError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const b64 = (raw: Uint8Array) => sodium.to_base64(raw, sodium.base64_variants.ORIGINAL);
const unb64 = (s: string) => sodium.from_base64(s, sodium.base64_variants.ORIGINAL);

export async function getOrCreateIdentity(store: SecretStore): Promise<DeviceIdentity> {
  await sodium.ready;
  const id = await store.get(KEYS.id);
  const seedB64 = await store.get(KEYS.seed);
  if (id && seedB64) {
    const seed = unb64(seedB64);
    return { deviceId: id, seed, publicKey: b64(sodium.crypto_sign_seed_keypair(seed).publicKey) };
  }
  const seed = sodium.randombytes_buf(sodium.crypto_sign_SEEDBYTES);
  const deviceId = crypto.randomUUID();
  await store.set(KEYS.seed, b64(seed));
  await store.set(KEYS.id, deviceId); // written last: an interrupted first run leaves no half identity
  await store.remove(KEYS.token);
  return { deviceId, seed, publicKey: b64(sodium.crypto_sign_seed_keypair(seed).publicKey) };
}

/** Signature the server expects over `sahay-register-v1|<device_id>|<challenge>`. Must run after sodium.ready. */
export function signRegistration(seed: Uint8Array, deviceId: string, challenge: string): string {
  const key = sodium.crypto_sign_seed_keypair(seed).privateKey;
  return b64(sodium.crypto_sign_detached(new TextEncoder().encode(`sahay-register-v1|${deviceId}|${challenge}`), key));
}

async function call<T>(fetchFn: typeof fetch, url: string, body: unknown): Promise<T> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      message = payload.error?.message ?? message;
    } catch {
      /* keep the status message */
    }
    throw new RegisterError(message, response.status);
  }
  return (await response.json()) as T;
}

/** Register (first run) or re-authenticate (token refresh). Needs the network. */
export async function registerDevice(store: SecretStore, options: RegisterOptions = {}): Promise<string> {
  const identity = await getOrCreateIdentity(store);
  const base = (options.apiBase ?? API_BASE).replace(/\/+$/, "");
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);
  const { challenge } = await call<{ challenge: string }>(fetchFn, `${base}/auth/device-challenge`, {
    device_id: identity.deviceId,
  });
  const result = await call<{ token: string }>(fetchFn, `${base}/auth/register-device`, {
    device_id: identity.deviceId,
    ed25519_public_key: identity.publicKey,
    language: options.language ?? "en",
    challenge,
    challenge_signature: signRegistration(identity.seed, identity.deviceId, challenge),
  });
  await store.set(KEYS.token, result.token);
  return result.token;
}

/** Seconds since epoch from a JWT `exp` claim, or null if it cannot be read. Not a signature check. */
export function tokenExpiry(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const exp = (JSON.parse(atob(payload)) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

/** The stored token if it is still good, otherwise a fresh one. Offline with a good token makes no request. */
export async function ensureDeviceToken(store: SecretStore, options: RegisterOptions = {}): Promise<string> {
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))();
  const token = await store.get(KEYS.token);
  const exp = token ? tokenExpiry(token) : null;
  if (token && exp !== null && exp - now > REFRESH_MARGIN_SECONDS) return token;
  return registerDevice(store, options);
}
