import { beforeEach, describe, expect, it } from "vitest";
import { secureStorage } from "./secure-storage";

describe("secureStorage in a browser (development fallback)", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips a value and reports a missing one as null", async () => {
    expect(await secureStorage.get("k")).toBeNull();
    await secureStorage.set("k", "v");
    expect(await secureStorage.get("k")).toBe("v");
    await secureStorage.remove("k");
    expect(await secureStorage.get("k")).toBeNull();
  });

  it("says plainly that it is not hardware backed", async () => {
    expect(await secureStorage.info()).toEqual({
      native: false,
      hardwareBacked: false,
    });
  });
});
