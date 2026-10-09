import type { Session } from "./session";

const API_BASE = (
  import.meta.env["VITE_API_BASE"] || "http://localhost:8000/api/v1"
).replace(/\/+$/, "");

type ApiError = { error?: { code?: string; message?: string } };

async function request<T>(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
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
    } catch {
      /* Use the HTTP status when the server did not return JSON. */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function login(
  username: string,
  password: string,
): Promise<Session> {
  const result = await request<Session>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (!result.token || (result.role !== "service" && result.role !== "admin")) {
    throw new Error("The server returned an invalid login response.");
  }
  return { ...result, unit_id: result.unit_id ?? null };
}

export interface Dispatch {
  dispatch_id: string;
  incident_id: string;
  unit_id: string;
  service_type: string;
  status:
    "proposed" | "accepted" | "declined" | "en_route" | "arrived" | "completed";
  distance_km: number;
  eta_minutes: number;
  proposed_by: string;
  created_at: string;
  updated_at: string;
}

export interface DispatchesResponse {
  dispatches: Dispatch[];
}

export async function getDispatchesMine(
  token: string,
): Promise<DispatchesResponse> {
  return request<DispatchesResponse>("/dispatches/mine", {}, token);
}

export async function acceptDispatch(
  dispatchId: string,
  token: string,
): Promise<Dispatch> {
  return request<Dispatch>(
    `/dispatches/${dispatchId}/accept`,
    { method: "POST" },
    token,
  );
}

export async function declineDispatch(
  dispatchId: string,
  token: string,
): Promise<Dispatch> {
  return request<Dispatch>(
    `/dispatches/${dispatchId}/decline`,
    { method: "POST" },
    token,
  );
}

export async function updateDispatchStatus(
  dispatchId: string,
  status: string,
  token: string,
): Promise<Dispatch> {
  return request<Dispatch>(
    `/dispatches/${dispatchId}/status`,
    { method: "PATCH", body: JSON.stringify({ status }) },
    token,
  );
}

export interface IncidentPii {
  incident_id: string;
  transcript: string;
  reporters: Array<{
    report_id: string;
    name: string;
    phone: string;
    language: string;
    emergency_contact: { name: string; phone: string };
  }>;
  pii_spans: Array<{ type: string; text: string; start: number; end: number }>;
  audio_url: string;
}

export async function revealIncidentPii(
  incidentId: string,
  token: string,
): Promise<IncidentPii> {
  return request<IncidentPii>(`/incidents/${incidentId}/reveal`, {}, token);
}

export interface AuditVerifyResponse {
  valid: boolean;
  checked: number;
  first_bad_seq: number | null;
}

export async function verifyAuditChain(
  token: string,
): Promise<AuditVerifyResponse> {
  return request<AuditVerifyResponse>("/audit/verify", {}, token);
}

export { API_BASE };
