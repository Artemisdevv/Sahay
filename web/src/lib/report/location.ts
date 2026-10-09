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

export function captureLocation(timeoutMs = 8_000): Promise<CapturedLocation> {
  const fallback = (): CapturedLocation =>
    readCache() ?? { ...KOCHI, accuracy_m: 25_000, approximate: true };
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(fallback());
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const fix = {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy_m: Math.round(p.coords.accuracy || 50),
          approximate: false,
        };
        try {
          window.localStorage.setItem(CACHE_KEY, JSON.stringify(fix));
        } catch {
          /* ignore */
        }
        resolve(fix);
      },
      () => resolve(fallback()),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}
