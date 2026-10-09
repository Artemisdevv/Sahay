import { API_BASE } from "@/lib/api";
import type { ServerKey } from "./envelope";

/**
 * The server public keys (GET /config/server-key) are needed to seal a report, which must also work with no
 * network. So the key is fetched whenever the app is online and cached on the phone. The keys are public: caching
 * them in localStorage is fine. A report sent before the first successful fetch cannot be sealed (see service.ts).
 */
const CACHE_KEY = "sahay.server-key.v1";

export interface KeyDeps {
  storage?: Pick<Storage, "getItem" | "setItem">;
  fetchFn?: typeof fetch;
  apiBase?: string;
}

function storageOf(deps: KeyDeps) {
  if (deps.storage) return deps.storage;
  return typeof window !== "undefined" ? window.localStorage : undefined;
}

const isKey = (v: unknown): v is ServerKey =>
  !!v &&
  typeof v === "object" &&
  typeof (v as ServerKey).key_id === "string" &&
  typeof (v as ServerKey).x25519_public_key === "string" &&
  typeof (v as ServerKey).ed25519_public_key === "string";

export function getCachedServerKey(deps: KeyDeps = {}): ServerKey | null {
  try {
    const raw = storageOf(deps)?.getItem(CACHE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isKey(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Fetch and cache. Rejects when offline or the server answers an error. */
export async function refreshServerKey(deps: KeyDeps = {}): Promise<ServerKey> {
  const fetchFn = deps.fetchFn ?? fetch.bind(globalThis);
  const base = (deps.apiBase ?? API_BASE).replace(/\/+$/, "");
  const response = await fetchFn(`${base}/config/server-key`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`server-key ${response.status}`);
  const body: unknown = await response.json();
  if (!isKey(body)) throw new Error("server-key response is not valid");
  try {
    storageOf(deps)?.setItem(CACHE_KEY, JSON.stringify(body));
  } catch {
    /* private mode: use it this session only */
  }
  return body;
}

/** The cached key if there is one (offline-safe), else try the network once. Null when neither works. */
export async function ensureServerKey(
  deps: KeyDeps = {},
): Promise<ServerKey | null> {
  const cached = getCachedServerKey(deps);
  if (cached) return cached;
  try {
    return await refreshServerKey(deps);
  } catch {
    return null;
  }
}
