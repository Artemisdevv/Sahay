/**
 * Location for a report. The server requires lat/lng, so there is always an answer:
 *   1. a fresh GPS fix (works offline, GPS needs no network),
 *   2. the last fix seen on this phone (marked with its age through a larger accuracy),
 *   3. the Kochi city centre with accuracy 25 km: the report is still sent, and the UI tells the user
 *      the position is only approximate so they can say where they are in the message.
 */
const CACHE_KEY = "sahay.last-location.v1";
const KOCHI = { lat: 9.9312, lng: 76.2673 };

export interface CapturedLocation {
  lat: number;
  lng: number;
  accuracy_m: number;
  /** true when this is not a fresh GPS fix */
  approximate: boolean;
}

function readCache(): CapturedLocation | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null") as {
      lat?: number;
      lng?: number;
    } | null;
    if (v && typeof v.lat === "number" && typeof v.lng === "number") {
      return { lat: v.lat, lng: v.lng, accuracy_m: 5_000, approximate: true };
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Latest fix seen while the app was open. Sending uses it immediately instead of waiting for a new GPS fix.
let latest: { fix: CapturedLocation; at: number } | null = null;
let watchId: number | null = null;
const FRESH_MS = 5 * 60_000;

function remember(p: GeolocationPosition): CapturedLocation {
  const fix: CapturedLocation = {
    lat: p.coords.latitude,
    lng: p.coords.longitude,
    accuracy_m: Math.round(p.coords.accuracy || 50),
    approximate: false,
  };
  latest = { fix, at: Date.now() };
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(fix));
  } catch {
    /* ignore */
  }
  return fix;
}

/** Start following the position in the background (call when the report screen opens). Returns a stop function. */
export function warmLocation(): () => void {
  if (typeof navigator === "undefined" || !navigator.geolocation)
    return () => {};
  if (watchId === null) {
    watchId = navigator.geolocation.watchPosition(remember, () => {}, {
      enableHighAccuracy: true,
      maximumAge: 30_000,
      timeout: 30_000,
    });
  }
  return () => {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  };
}

/**
 * Position for a report, as fast as possible: a recent fix from the background watch is used at once; otherwise wait
 * briefly (default 3 s) for one; otherwise fall back (last known, then the Kochi centre).
 */
export function captureLocation(timeoutMs = 3_000): Promise<CapturedLocation> {
  const fallback = (): CapturedLocation =>
    latest?.fix ??
    readCache() ?? { ...KOCHI, accuracy_m: 25_000, approximate: true };
  if (latest && Date.now() - latest.at < FRESH_MS)
    return Promise.resolve(latest.fix);
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(fallback());
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(remember(p)),
      () => resolve(fallback()),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 120_000 },
    );
  });
}
