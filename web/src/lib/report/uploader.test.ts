// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportEnvelope } from "@/native/sahay-nearby";
import { backoffMs, ReportQueue, type QueueItem } from "./queue";
import { flushReports, type FlushDeps, type RelayHooks } from "./uploader";

const envelope = (id: string): ReportEnvelope => ({
  envelope_version: 1,
  report_id: id,
  device_id: "dev-1",
  created_at: "2026-10-09T10:15:00Z",
  ttl: 5,
  key_id: "k1",
  ciphertext: "AAAA",
  signature: "BBBB",
});
const item = (id: string, patch: Partial<QueueItem> = {}): QueueItem => ({
  report_id: id,
  envelope: envelope(id),
  category: "fire",
  created_at: `2026-10-09T10:15:0${id.slice(-1)}Z`,
  state: "queued",
  attempts: 0,
  next_attempt_at: 0,
  ...patch,
});
const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

let queue: ReportQueue;
beforeEach(() => {
  queue = new ReportQueue(new IDBFactory()); // fresh database per test
});

const deps = (fetchFn: typeof fetch, extra: Partial<FlushDeps> = {}): FlushDeps => ({
  queue,
  getToken: async () => "tok",
  apiBase: "http://api/v1",
  serverKey: async () => null,
  fetchFn,
  now: () => 1_000_000,
  random: () => 0.5,
  ...extra,
});

describe("ReportQueue", () => {
  it("stores, lists newest first and updates atomically", async () => {
    await queue.put(item("r1"));
    await queue.put(item("r2"));
    expect((await queue.all()).map((i) => i.report_id)).toEqual(["r2", "r1"]);
    await queue.update("r1", { attempts: 3 });
    expect((await queue.get("r1"))?.attempts).toBe(3);
    expect(await queue.update("missing", { attempts: 1 })).toBeUndefined();
  });

  it("only returns queued items that are due", async () => {
    await queue.put(item("r1", { next_attempt_at: 5_000 }));
    await queue.put(item("r2", { state: "sent" }));
    await queue.put(item("r3"));
    expect((await queue.due(1_000)).map((i) => i.report_id)).toEqual(["r3"]);
    expect((await queue.due(5_000)).map((i) => i.report_id).sort()).toEqual(["r1", "r3"]);
  });

  it("back-off grows then caps at about five minutes", () => {
    const steps = [0, 1, 2, 3, 4, 9].map((n) => backoffMs(n, () => 0.5));
    expect(steps).toEqual([5_000, 15_000, 45_000, 120_000, 300_000, 300_000]);
  });
});

describe("flushReports", () => {
  it("delivers queued reports and keeps the receipt", async () => {
    await queue.put(item("r1"));
    const fetchFn = vi.fn(async () =>
      reply(202, { receipt: { server_time: "2026-10-09T10:16:00Z", signature: "sig" } }),
    ) as unknown as typeof fetch;
    const res = await flushReports(deps(fetchFn));
    expect(res).toMatchObject({ sent: 1, failed: 0, retrying: 0, offline: false });
    const saved = await queue.get("r1");
    expect(saved).toMatchObject({ state: "sent", attempts: 1, receipt_verified: false });
    expect(saved?.receipt?.server_time).toBe("2026-10-09T10:16:00Z");
    const [url, init] = vi.mocked(fetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api/v1/reports");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
  });

  it("treats a server rejection as final and a network error as retry with back-off", async () => {
    await queue.put(item("r1"));
    await queue.put(item("r2"));
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const id = (JSON.parse(String(init?.body)) as ReportEnvelope).report_id;
      if (id === "r1") return reply(422, { error: { message: "invalid_signature" } });
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const res = await flushReports(deps(fetchFn));
    expect(res).toMatchObject({ sent: 0, failed: 1, retrying: 1 });
    expect(await queue.get("r1")).toMatchObject({ state: "failed", last_error: "invalid_signature" });
    expect(await queue.get("r2")).toMatchObject({ state: "queued", attempts: 1, next_attempt_at: 1_000_000 + 5_000 });
    // not due again until the back-off passes
    expect(await queue.due(1_000_000 + 4_000)).toEqual([]);
  });

  it("retries 429 and 5xx, never marks them failed", async () => {
    await queue.put(item("r1"));
    const fetchFn = vi.fn(async () => reply(503)) as unknown as typeof fetch;
    const res = await flushReports(deps(fetchFn));
    expect(res.retrying).toBe(1);
    expect((await queue.get("r1"))?.state).toBe("queued");
  });

  it("does nothing and reports offline when no token can be obtained", async () => {
    await queue.put(item("r1"));
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const res = await flushReports(deps(fetchFn, { getToken: async () => Promise.reject(new Error("offline")) }));
    expect(res.offline).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await queue.get("r1"))?.attempts).toBe(0);
  });

  it("makes no request and asks for no token when nothing is due", async () => {
    const getToken = vi.fn(async () => "tok");
    const res = await flushReports(deps(vi.fn() as unknown as typeof fetch, { getToken }));
    expect(res).toMatchObject({ sent: 0, offline: false });
    expect(getToken).not.toHaveBeenCalled();
  });

  it("uploads reports carried for other phones and returns their receipts over the relay", async () => {
    const delivered: string[] = [];
    const receipts: string[] = [];
    const relay: RelayHooks = {
      pendingForUpload: async () => ({ envelopes: [envelope("other-1"), envelope("other-2")] }),
      markDelivered: async ({ reportId }) => void delivered.push(reportId),
      relayReceipt: async ({ reportId }) => void receipts.push(reportId),
    };
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      const id = (JSON.parse(String(init?.body)) as ReportEnvelope).report_id;
      return id === "other-1"
        ? reply(202, { receipt: { server_time: "t", signature: "s" } })
        : reply(503);
    }) as unknown as typeof fetch;
    const res = await flushReports(deps(fetchFn, { relay }));
    expect(res.relayed).toBe(1);
    expect(receipts).toEqual(["other-1"]);
    expect(delivered).toEqual(["other-1"]); // other-2 stays carried for the next try
  });

  it("does not upload our own envelope twice when the relay also lists it", async () => {
    await queue.put(item("mine", { state: "sent" }));
    const relay: RelayHooks = {
      pendingForUpload: async () => ({ envelopes: [envelope("mine")] }),
      markDelivered: async () => {},
      relayReceipt: async () => {},
    };
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await flushReports(deps(fetchFn, { relay }));
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
