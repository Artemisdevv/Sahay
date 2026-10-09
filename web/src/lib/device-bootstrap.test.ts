// @vitest-environment node
import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";
import { startDeviceBootstrap } from "./device-bootstrap";
import type { SecretStore } from "@/native/secure-storage";

class MemoryStore implements SecretStore {
  data = new Map<string, string>();
  get = async (k: string) => this.data.get(k) ?? null;
  set = async (k: string, v: string) => void this.data.set(k, v);
  remove = async (k: string) => void this.data.delete(k);
}

const b64u = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const goodToken = () => `${b64u({})}.${b64u({ exp: Math.floor(Date.now() / 1000) + 43200 })}.s`;

const tick = () => new Promise((r) => setTimeout(r, 20));

function server(state: { online: boolean }) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    if (!state.online) throw new TypeError("Failed to fetch");
    calls.push(url.split("/auth/")[1]);
    return new Response(
      JSON.stringify(url.endsWith("device-challenge") ? { challenge: "v1.9999999999.N.M" } : { token: goodToken() }),
      { status: url.endsWith("device-challenge") ? 200 : 201 },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

class FakeWindow {
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn); }
  removeEventListener(type: string, fn: () => void) { this.listeners.get(type)?.delete(fn); }
  fire(type: string) { this.listeners.get(type)?.forEach((fn) => fn()); }
}

beforeAll(async () => {
  await sodium.ready;
});

describe("startDeviceBootstrap", () => {
  it("registers in the background on launch and reports ready", async () => {
    const store = new MemoryStore();
    const s = server({ online: true });
    const statuses: string[] = [];
    const stop = startDeviceBootstrap(store, { fetchFn: s.fetchFn, apiBase: "http://x/api/v1", onStatus: (x) => statuses.push(x), onlineTarget: new FakeWindow() as never });
    await tick();
    stop();
    expect(statuses).toEqual(["ready"]);
    expect(s.calls).toEqual(["device-challenge", "register-device"]);
    expect(await store.get("device.token")).toBeTruthy();
  });

  it("stays quiet offline, then registers as soon as the network comes back", async () => {
    const store = new MemoryStore();
    const state = { online: false };
    const s = server(state);
    const win = new FakeWindow();
    const statuses: string[] = [];
    const stop = startDeviceBootstrap(store, {
      fetchFn: s.fetchFn, apiBase: "http://x/api/v1", onStatus: (x) => statuses.push(x),
      onlineTarget: win as never, setTimeoutFn: (() => 0) as unknown as typeof setTimeout, // no timed retry in this test
    });
    await tick();
    expect(statuses).toEqual(["waiting"]);          // no throw, no crash
    expect(await store.get("device.token")).toBeNull();
    state.online = true;
    win.fire("online");
    await tick();
    stop();
    expect(statuses).toEqual(["waiting", "ready"]);
    expect(await store.get("device.token")).toBeTruthy();
  });

  it("retries on a back-off schedule and stops when asked", async () => {
    const delays: number[] = [];
    const state = { online: false };
    const s = server(state);
    const stop = startDeviceBootstrap(new MemoryStore(), {
      fetchFn: s.fetchFn, apiBase: "http://x/api/v1", backoffMs: [5, 50],
      onlineTarget: new FakeWindow() as never,
      setTimeoutFn: ((fn: () => void, ms: number) => { delays.push(ms); return setTimeout(fn, 1); }) as unknown as typeof setTimeout,
    });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    const seen = delays.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(delays.slice(0, 3)).toEqual([5, 50, 50]);   // last delay repeats
    expect(delays.length).toBe(seen);                  // nothing scheduled after stop()
  });

  it("does nothing while a good token is stored (no request offline or online)", async () => {
    const store = new MemoryStore();
    await store.set("device.token", goodToken());
    const s = server({ online: true });
    const stop = startDeviceBootstrap(store, { fetchFn: s.fetchFn, onlineTarget: new FakeWindow() as never });
    await tick();
    stop();
    expect(s.calls).toEqual([]);
  });
});
