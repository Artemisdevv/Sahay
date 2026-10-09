import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_EXPIRED_EVENT,
  expireSession,
  getSession,
  hasRole,
  saveSession,
} from "./session";

afterEach(() => {
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("session guards", () => {
  it("hasRole matches only the allowed roles", () => {
    expect(hasRole("admin")).toBe(false);
    saveSession({
      token: "t",
      role: "service",
      unit_id: "u1",
      display_name: "Unit",
    });
    expect(hasRole("service", "admin")).toBe(true);
    expect(hasRole("admin")).toBe(false);
  });

  it("expireSession clears the session and announces it", () => {
    saveSession({
      token: "t",
      role: "admin",
      unit_id: null,
      display_name: "Admin",
    });
    const seen = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, seen);
    expireSession();
    window.removeEventListener(SESSION_EXPIRED_EVENT, seen);
    expect(getSession()).toBeNull();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("a 401 on a signed-in API call expires the session", async () => {
    saveSession({
      token: "t",
      role: "admin",
      unit_id: null,
      display_name: "Admin",
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { code: "unauthorized" } }), {
            status: 401,
          }),
        ),
    );
    const { getIncidents } = await import("./api");
    await expect(getIncidents("t")).rejects.toThrow();
    expect(getSession()).toBeNull();
  });

  it("a 401 on login (no token) does not touch the session", async () => {
    saveSession({
      token: "t",
      role: "admin",
      unit_id: null,
      display_name: "Admin",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 401 })),
    );
    const { login } = await import("./api");
    await expect(login("a", "b")).rejects.toThrow();
    expect(getSession()).not.toBeNull();
  });
});
