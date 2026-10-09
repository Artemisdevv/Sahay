// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItem } from "./queue";
import { ReportQueue } from "./queue";

type Handler = (e: never) => void;
const handlers: Record<string, Handler> = {};
const markDelivered = vi.fn(async () => {});

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({}),
  WebPlugin: class {},
}));
vi.mock("@/native/sahay-nearby", () => ({
  SahayNearby: {
    addListener: async (event: string, cb: Handler) => {
      handlers[event] = cb;
      return { remove: async () => {} };
    },
    markDelivered: (...a: unknown[]) =>
      (markDelivered as (...x: unknown[]) => Promise<void>)(...a),
    start: async () => {},
    stop: async () => {},
  },
}));

const { attachRelayListeners, getRelayState } = await import("./relay");

const item = (id: string, patch: Partial<QueueItem> = {}): QueueItem => ({
  report_id: id,
  envelope: {
    envelope_version: 1,
    report_id: id,
    device_id: "d",
    created_at: "2026-10-09T10:15:00Z",
    ttl: 5,
    key_id: "k1",
    ciphertext: "AAAA",
    signature: "BBBB",
  },
  category: "fire",
  created_at: "2026-10-09T10:15:00Z",
  state: "queued",
  attempts: 0,
  next_attempt_at: 0,
  ...patch,
});

let queue: ReportQueue;
const fire = (event: string, payload: unknown) =>
  (handlers[event] as (e: unknown) => void)(payload);
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(async () => {
  queue = new ReportQueue(new IDBFactory());
  markDelivered.mockClear();
});

describe("relay listeners", () => {
  it("counts nearby phones and never goes below zero", async () => {
    await attachRelayListeners({ queue, syncNow: async () => {} });
    fire("peerLost", { peerId: "x" });
    expect(getRelayState().nearby).toBe(0);
    fire("peerConnected", { peerId: "a" });
    fire("peerConnected", { peerId: "b" });
    expect(getRelayState().nearby).toBe(2);
    fire("peerLost", { peerId: "a" });
    expect(getRelayState().nearby).toBe(1);
  });

  it("uploads right away when a sealed report from another phone arrives, without opening it", async () => {
    const syncNow = vi.fn(async () => {});
    await attachRelayListeners({ queue, syncNow });
    fire("envelopeReceived", {
      envelope: { ciphertext: "opaque" },
      fromPeer: "a",
    });
    await settle();
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(await queue.all()).toEqual([]); // carried reports never enter "My reports"
  });

  it("marks our own report delivered when the verified receipt comes back through a nearby phone", async () => {
    await queue.put(item("mine"));
    const onChange = vi.fn();
    await attachRelayListeners({ queue, syncNow: async () => {}, onChange });
    fire("receiptReceived", {
      reportId: "mine",
      receipt: { server_time: "t", signature: "s" },
    });
    await settle();
    expect(await queue.get("mine")).toMatchObject({
      state: "sent",
      via: "relay",
      receipt_verified: true,
    });
    expect(markDelivered).toHaveBeenCalledWith({ reportId: "mine" });
    expect(onChange).toHaveBeenCalled();
  });

  it("ignores receipts and statuses for reports that are not ours", async () => {
    await attachRelayListeners({ queue, syncNow: async () => {} });
    fire("receiptReceived", {
      reportId: "stranger",
      receipt: { server_time: "t", signature: "s" },
    });
    fire("statusReceived", {
      reportId: "stranger",
      status: "dispatched",
      message: "x",
    });
    await settle();
    expect(await queue.all()).toEqual([]);
  });

  it("keeps the latest relayed status on our report", async () => {
    await queue.put(item("mine", { state: "sent", via: "relay" }));
    await attachRelayListeners({ queue, syncNow: async () => {} });
    fire("statusReceived", {
      reportId: "mine",
      status: "dispatched",
      message: "Help dispatched",
    });
    await settle();
    expect((await queue.get("mine"))?.relay_status).toEqual({
      status: "dispatched",
      message: "Help dispatched",
    });
  });
});
