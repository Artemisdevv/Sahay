export type UserRole = "civilian" | "service" | "admin";

export type Session = {
  token: string;
  role: UserRole;
  unit_id: string | null;
  display_name: string;
};

const SESSION_KEY = "sahay.session.v1";

export function saveSession(session: Session): void {
  if (typeof window !== "undefined") window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(SESSION_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const session = value as Partial<Session>;
    if (typeof session.token !== "string" || !["civilian", "service", "admin"].includes(session.role ?? "")) return null;
    return session as Session;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  if (typeof window !== "undefined") window.localStorage.removeItem(SESSION_KEY);
}
