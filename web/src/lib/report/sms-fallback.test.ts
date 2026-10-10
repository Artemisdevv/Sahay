import { describe, expect, it, vi } from "vitest";
import { buildSmsLine, runSmsFallback, smsDelayMs } from "./sms-fallback";
import type { QueueItem } from "./queue";

const item = (over: Partial<QueueItem> = {}): QueueItem =>
  ({
    report_id: "a1b2c3d4-0000-4000-8000-000000000001",
    envelope: {} as QueueItem["envelope"],
    category: "fire",
    created_at: new Date(1_000_000).toISOString(),
    state: "queued",
    attempts: 1,
    next_attempt_at: 0,
    ...over,
  }) as QueueItem;

function setup(items: QueueItem[], extra: Partial<Parameters<typeof runSmsFallback>[0]> = {}) {
  const update = vi.fn(async () => undefined);
  const send = vi.fn(async () => ({ sent: true }));
  const lines = new Map([[items[0]!.report_id, { line: "SAHAY1|x", sos: false }]]);
  const deps = {
    queue: { all: async () => items, update },
    lines,
    gatewayNumber: () => "+15550001111",
    nearbyPeers: () => 0,
    online: () => false,
    sms: { send },
    now: () => 1_000_000 + 60_000,
    ...extra,
  };
  return { deps, update, send };
}

describe("buildSmsLine", () => {
  it("follows the SAHAY1 contract and fits one SMS", () => {
    const line = buildSmsLine({
      reportId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      deviceId: "04BDD295-3b86-4f46-afe4-27e7ac6b6e72",
      lat: 9.9312,
      lng: 76.2673,
      category: "fire",
      sos: false,
      ts: 1760000000.9,
    });
    expect(line).toBe("SAHAY1|a1b2c3d4|04bdd295|9.93120,76.26730|FI|1760000000");
    expect(line.length).toBeLessThanOrEqual(160);
    expect(/^[\x20-\x7e]+$/.test(line)).toBe(true);
  });
  it("uses SO for an SOS and OT for an unknown category", () => {
    const base = { reportId: "aaaaaaaa", deviceId: "bbbbbbbb", lat: 1, lng: 2, ts: 5 };
    expect(buildSmsLine({ ...base, category: "other", sos: true })).toContain("|SO|");
    expect(buildSmsLine({ ...base, category: "weird", sos: false })).toContain("|OT|");
  });
});

describe("smsDelayMs", () => {
  it("SOS goes first, a carried report waits longest", () => {
    expect(smsDelayMs(true, 3)).toBeLessThan(smsDelayMs(false, 0));
    expect(smsDelayMs(false, 0)).toBeLessThan(smsDelayMs(false, 2));
  });
});

describe("runSmsFallback", () => {
  it("texts a queued report that waited long enough, once", async () => {
    const { deps, send, update } = setup([item()]);
    expect(await runSmsFallback(deps)).toEqual(["a1b2c3d4-0000-4000-8000-000000000001"]);
    expect(send).toHaveBeenCalledWith({ to: "+15550001111", body: "SAHAY1|x" });
    expect(update).toHaveBeenCalledOnce();
  });
  it("waits while the grace period has not passed", async () => {
    const { deps, send } = setup([item()], { now: () => 1_000_000 + 10_000 });
    expect(await runSmsFallback(deps)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
  it("waits longer when a nearby phone is carrying it", async () => {
    const { deps, send } = setup([item()], { nearbyPeers: () => 2 });
    expect(await runSmsFallback(deps)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
  it("does nothing without a gateway number, for sent or already texted items", async () => {
    for (const d of [
      setup([item()], { gatewayNumber: () => null }),
      setup([item({ state: "sent" })]),
      setup([item({ sms_sent_at: 1 })]),
    ]) {
      expect(await runSmsFallback(d.deps)).toEqual([]);
      expect(d.send).not.toHaveBeenCalled();
    }
  });
  it("does not text when the phone is online and no upload has failed", async () => {
    const { deps, send } = setup([item({ attempts: 0 })], { online: () => true });
    expect(await runSmsFallback(deps)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps going and does not mark the item when the SMS is not sent", async () => {
    const { deps, update } = setup([item()], { sms: { send: async () => ({ sent: false }) } });
    expect(await runSmsFallback(deps)).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    const boom = setup([item()], { sms: { send: async () => { throw new Error("denied"); } } });
    expect(await runSmsFallback(boom.deps)).toEqual([]);
  });
});
