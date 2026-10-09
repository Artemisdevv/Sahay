// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  RegisterError,
  ensureDeviceToken,
  getOrCreateIdentity,
  registerDevice,
  signRegistration,
  tokenExpiry,
} from "./device-identity";
import type { SecretStore } from "@/native/secure-storage";

const vector = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../contract/crypto-test-vector.json"),
    "utf-8",
  ),
) as {
  device: { signing_seed: string; public_key: string };
  register: {
    device_id: string;
    challenge: string;
    signing_input_utf8: string;
    signature: string;
  };
};

class MemoryStore implements SecretStore {
  data = new Map<string, string>();
  get = async (k: string) => this.data.get(k) ?? null;
  set = async (k: string, v: string) => void this.data.set(k, v);
  remove = async (k: string) => void this.data.delete(k);
}

const b64u = (o: object) =>
  btoa(JSON.stringify(o))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const jwt = (exp: number) =>
  `${b64u({ alg: "HS256" })}.${b64u({ exp, role: "civilian" })}.sig`;

/** Fake server: issues a challenge, then checks the proof the same way the backend does. */
function fakeServer(options: { token?: string; registerStatus?: number } = {}) {
  const calls: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(url.split("/auth/")[1] ?? "");
    if (url.endsWith("/auth/device-challenge")) {
      return new Response(
        JSON.stringify({ challenge: "v1.9999999999.NONCE.MAC" }),
        { status: 200 },
      );
    }
    expect(body.challenge).toBe("v1.9999999999.NONCE.MAC");
    const ok = sodium.crypto_sign_verify_detached(
      sodium.from_base64(
        body.challenge_signature,
        sodium.base64_variants.ORIGINAL,
      ),
      new TextEncoder().encode(
        `sahay-register-v1|${body.device_id}|${body.challenge}`,
      ),
      sodium.from_base64(
        body.ed25519_public_key,
        sodium.base64_variants.ORIGINAL,
      ),
    );
    if (!ok)
      return new Response(
        JSON.stringify({ error: { message: "proof failed" } }),
        { status: 401 },
      );
    if (options.registerStatus) {
      return new Response(JSON.stringify({ error: { message: "taken" } }), {
        status: options.registerStatus,
      });
    }
    return new Response(
      JSON.stringify({
        token: options.token ?? jwt(Math.floor(Date.now() / 1000) + 43200),
      }),
      {
        status: 201,
      },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

beforeAll(async () => {
  await sodium.ready;
});

describe("registration proof", () => {
  it("signs exactly what the backend and the frozen contract vector expect", () => {
    const seed = sodium.from_base64(
      vector.device.signing_seed,
      sodium.base64_variants.ORIGINAL,
    );
    expect(vector.register.signing_input_utf8).toBe(
      `sahay-register-v1|${vector.register.device_id}|${vector.register.challenge}`,
    );
    expect(
      signRegistration(
        seed,
        vector.register.device_id,
        vector.register.challenge,
      ),
    ).toBe(vector.register.signature);
  });
});

describe("device identity", () => {
  it("is created once, kept in the store, and reused", async () => {
    const store = new MemoryStore();
    const first = await getOrCreateIdentity(store);
    const second = await getOrCreateIdentity(store);
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.publicKey).toBe(first.publicKey);
    expect(first.seed).toHaveLength(32);
    expect(first.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("only the seed is secret material: it is stored, the public key is derived", async () => {
    const store = new MemoryStore();
    await getOrCreateIdentity(store);
    expect([...store.data.keys()].sort()).toEqual(["device.id", "device.seed"]);
  });
});

describe("registerDevice and ensureDeviceToken", () => {
  it("fetches a challenge, signs it with the device key, and stores the token", async () => {
    const store = new MemoryStore();
    const server = fakeServer();
    const token = await registerDevice(store, {
      fetchFn: server.fetchFn,
      apiBase: "http://x/api/v1",
    });
    expect(server.calls).toEqual(["device-challenge", "register-device"]);
    expect(await store.get("device.token")).toBe(token);
  });

  it("does not touch the network while the stored token is still good (offline use)", async () => {
    const store = new MemoryStore();
    const good = jwt(Math.floor(Date.now() / 1000) + 3600);
    await store.set("device.token", good);
    const server = fakeServer();
    expect(await ensureDeviceToken(store, { fetchFn: server.fetchFn })).toBe(
      good,
    );
    expect(server.calls).toEqual([]);
  });

  it("refreshes a token that is expired or about to expire", async () => {
    const store = new MemoryStore();
    await getOrCreateIdentity(store);
    await store.set("device.token", jwt(Math.floor(Date.now() / 1000) + 60));
    const fresh = jwt(Math.floor(Date.now() / 1000) + 43200);
    const server = fakeServer({ token: fresh });
    expect(
      await ensureDeviceToken(store, {
        fetchFn: server.fetchFn,
        apiBase: "http://x/api/v1",
      }),
    ).toBe(fresh);
    expect(server.calls).toEqual(["device-challenge", "register-device"]);
  });

  it("reports a refused registration with its status and message", async () => {
    const server = fakeServer({ registerStatus: 409 });
    await expect(
      registerDevice(new MemoryStore(), {
        fetchFn: server.fetchFn,
        apiBase: "http://x/api/v1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "taken",
    });
    expect(RegisterError).toBeDefined();
  });
});

describe("tokenExpiry", () => {
  it("reads exp and rejects junk", () => {
    expect(tokenExpiry(jwt(1234567890))).toBe(1234567890);
    expect(tokenExpiry("not-a-jwt")).toBeNull();
    expect(tokenExpiry(`${b64u({})}.${b64u({ exp: "soon" })}.s`)).toBeNull();
  });
});
