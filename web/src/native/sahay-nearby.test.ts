import { describe, expect, it } from "vitest";
import { SahayNearby } from "./sahay-nearby";

describe("SahayNearby in a browser", () => {
  it("reports nothing carried and nothing pending", async () => {
    expect(await SahayNearby.carryingCount()).toEqual({ count: 0 });
    expect(await SahayNearby.pendingForUpload()).toEqual({ envelopes: [] });
  });

  it("rejects calls that need the radio, with an UNAVAILABLE code", async () => {
    await expect(
      SahayNearby.start({ deviceId: "d", mode: "both", serverVerifyKey: "k" }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("lets the app call stop and the delivery hooks without crashing", async () => {
    await expect(SahayNearby.stop()).resolves.toBeUndefined();
    await expect(
      SahayNearby.markDelivered({ reportId: "r" }),
    ).resolves.toBeUndefined();
  });
});
