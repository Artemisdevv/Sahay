export type UserRole = "civilian" | "service" | "admin";

export type Session = {
  token: string;
  role: UserRole;
  unit_id: string | null;
  display_name: string;
};

// Service/admin sessions use sessionStorage: gone when the app closes, so a lost phone does not keep a staff login.
// Civilian device keys and tokens are separate and live in secure storage (src/native/secure-storage.ts).
const SESSION_KEY = "sahay.session.v1";

export function saveSession(session: Session): void {
  if (typeof window !== "undefined")
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const value: unknown = JSON.parse(
      window.sessionStorage.getItem(SESSION_KEY) ?? "null",
    );
    if (!value || typeof value !== "object") return null;
    const session = value as Partial<Session>;
    if (
      typeof session.token !== "string" ||
      !["civilian", "service", "admin"].includes(session.role ?? "")
    )
      return null;
    return session as Session;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  if (typeof window !== "undefined")
    window.sessionStorage.removeItem(SESSION_KEY);
}

export const SESSION_EXPIRED_EVENT = "sahay:session-expired";

// Staff tokens last 12 h. When the server answers 401 to a signed-in call, drop the session and tell the app to go to /login.
export function expireSession(): void {
  if (typeof window === "undefined") return;
  clearSession();
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

// Route guard helper: true when a staff session with one of the roles exists. Browser only (sessionStorage).
export function hasRole(...roles: UserRole[]): boolean {
  const session = getSession();
  return !!session && roles.includes(session.role);
}
