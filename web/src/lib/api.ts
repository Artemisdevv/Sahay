import type { Session } from "./session";

const API_BASE = (import.meta.env.VITE_API_BASE || "http://localhost:8000/api/v1").replace(/\/+$/, "");

type ApiError = { error?: { code?: string; message?: string } };

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as ApiError;
      message = body.error?.message || body.error?.code || message;
    } catch { /* Use the HTTP status when the server did not return JSON. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function login(username: string, password: string): Promise<Session> {
  const result = await request<Session>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (!result.token || (result.role !== "service" && result.role !== "admin")) {
    throw new Error("The server returned an invalid login response.");
  }
  return { ...result, unit_id: result.unit_id ?? null };
}

export { API_BASE };
