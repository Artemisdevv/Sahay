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
  if (typeof window !== "undefined") window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const session = value as Partial<Session>;
    if (typeof session.token !== "string" || !["civilian", "service", "admin"].includes(session.role ?? "")) return null;
    return session as Session;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  if (typeof window !== "undefined") window.sessionStorage.removeItem(SESSION_KEY);
}
