import { expireSession, type Session } from "./session";

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
    if (response.status === 401 && token) expireSession();
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
  service_type: ServiceType;
  status:
    | "proposed"
    | "approved"
    | "accepted"
    | "declined"
    | "en_route"
    | "on_scene"
    | "completed"
    | "cancelled";
  distance_km: number;
  eta_minutes: number;
  proposed_by: string;
  created_at: string;
  updated_at: string;
}

export type ServiceType = "ambulance" | "police" | "fire" | "municipal";

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
): Promise<{ declined: Dispatch; replacement: Dispatch | null }> {
  return request<{ declined: Dispatch; replacement: Dispatch | null }>(
    `/dispatches/${dispatchId}/decline`,
    { method: "POST", body: JSON.stringify({}) },
    token,
  );
}

export async function updateDispatchStatus(
  dispatchId: string,
  status: "en_route" | "on_scene" | "completed",
  token: string,
): Promise<Dispatch> {
  return request<Dispatch>(
    `/dispatches/${dispatchId}/status`,
    { method: "POST", body: JSON.stringify({ status }) },
    token,
  );
}

export interface IncidentSummary {
  incident_id: string;
  status: string;
  incident_type: string;
  severity: number;
  urgency_score: number;
  location: { lat: number; lng: number };
  summary_redacted: string;
  people_count: number;
  hazards: string[];
  needed_services: string[];
  report_count: number;
  report_ids: string[];
  reason: string;
  created_at: string;
  updated_at: string;
}

export interface IncidentDetails extends IncidentSummary {
  dispatches: Dispatch[];
}

export interface AgentTraceStep {
  incident_id: string;
  step: string;
  agent: string;
  status: "running" | "done" | "skipped" | "failed";
  started_at: string;
  finished_at: string | null;
  summary: string;
  output: Record<string, unknown>;
}

export interface IncidentActionResult {
  incident: IncidentSummary;
  dispatches: Dispatch[];
  unfilled_services: string[];
}

export interface CallCandidate {
  rank: number;
  unit_id?: string;
  name?: string;
  distance_km: number;
  eta_minutes: number;
  state: "calling" | "accepted" | "declined" | "no_answer" | "standby";
}

export interface ServiceCallList {
  service_type: ServiceType;
  candidates: CallCandidate[];
}

export async function getIncidents(
  token: string,
): Promise<{ incidents: IncidentSummary[]; next_cursor: string | null }> {
  return request<{ incidents: IncidentSummary[]; next_cursor: string | null }>(
    "/incidents?limit=100",
    {},
    token,
  );
}

export async function getIncidentDetails(
  incidentId: string,
  token: string,
): Promise<IncidentDetails> {
  return request<IncidentDetails>(`/incidents/${incidentId}`, {}, token);
}

export async function getIncidentTrace(
  incidentId: string,
  token: string,
): Promise<{ incident_id: string; trace: AgentTraceStep[] }> {
  return request(`/incidents/${incidentId}/trace`, {}, token);
}

export async function getIncidentCalls(
  incidentId: string,
  token: string,
): Promise<{
  incident_id: string;
  calls: Array<Record<string, unknown>>;
  lists: ServiceCallList[];
}> {
  return request(`/incidents/${incidentId}/calls`, {}, token);
}

export async function approveIncident(
  incidentId: string,
  token: string,
): Promise<IncidentActionResult> {
  return request<IncidentActionResult>(
    `/incidents/${incidentId}/approve`,
    { method: "POST" },
    token,
  );
}

export async function rejectIncident(
  incidentId: string,
  reason: string,
  token: string,
): Promise<IncidentActionResult> {
  return request<IncidentActionResult>(
    `/incidents/${incidentId}/reject`,
    { method: "POST", body: JSON.stringify({ reason }) },
    token,
  );
}

export async function reassignIncident(
  incidentId: string,
  neededService: ServiceType,
  unitId: string,
  token: string,
): Promise<IncidentActionResult> {
  return request<IncidentActionResult>(
    `/incidents/${incidentId}/reassign`,
    {
      method: "POST",
      body: JSON.stringify({ needed_service: neededService, unit_id: unitId }),
    },
    token,
  );
}

export interface Unit {
  unit_id: string;
  service_type: ServiceType;
  name: string;
  status: "available" | "assigned" | "en_route" | "on_scene" | "offline";
  location: { lat: number; lng: number };
  updated_at: string;
}

export async function getUnits(token: string): Promise<{ units: Unit[] }> {
  return request<{ units: Unit[] }>("/units", {}, token);
}

export interface IncidentPii {
  incident_id: string;
  transcript: string | null;
  reporters: Array<{
    report_id: string;
    name: string | null;
    phone: string | null;
    language: string;
    emergency_contact: { name: string | null; phone: string | null } | null;
  }>;
  pii_spans: Array<{ type: string; text: string; start: number; end: number }>;
  audio_url: string | null;
  /** Original voice messages of this incident (admin only, after a logged reveal). */
  audio?: Array<{ report_id: string; mime: string; url: string }>;
}

/** Download one original voice message. The server needs a recent reveal of the incident and audits every play. */
export async function fetchIncidentAudio(
  url: string,
  token: string,
): Promise<Blob> {
  const response = await fetch(`${API_BASE}${url.replace(/^\/api\/v1/, "")}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    let message = `Could not load the audio (${response.status})`;
    try {
      const body = (await response.json()) as ApiError;
      message = body.error?.message || message;
    } catch {
      /* keep the status message */
    }
    throw new Error(message);
  }
  return response.blob();
}

export async function revealIncidentPii(
  incidentId: string,
  reason: string,
  token: string,
): Promise<IncidentPii> {
  return request<IncidentPii>(
    `/incidents/${incidentId}/reveal`,
    { method: "POST", body: JSON.stringify({ reason }) },
    token,
  );
}

export interface AuditEntry {
  seq: number;
  ts: string;
  actor: { type: string; id: string };
  action: string;
  target: { type: string; id: string };
  details: Record<string, unknown>;
}

export async function getAuditEntries(
  token: string,
): Promise<{ entries: AuditEntry[] }> {
  return request<{ entries: AuditEntry[] }>("/audit?limit=50", {}, token);
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

export interface PublicIncident {
  id: string;
  incident_type: string;
  severity: "low" | "medium" | "high" | "critical";
  status: string;
  location: { lat: number; lng: number };
  area_precision_km: number;
  reported_at: string;
}

export interface PublicUnit {
  id: string;
  service_type: ServiceType;
  status: string;
  location: { lat: number; lng: number };
  incident: string;
  eta_minutes: number | null;
}

/** Open map feed: no login, coarse facts only (backend/app/public_routes.py). */
export async function getPublicIncidents(): Promise<{
  incidents: PublicIncident[];
  generated_at: string;
}> {
  return request("/public/incidents");
}

/** Public units feed: no login, coarse facts only (backend/app/main.py). */
export async function getPublicUnits(): Promise<{
  units: PublicUnit[];
  generated_at: string;
}> {
  return request("/public/units");
}

export { API_BASE };

/**
 * ngrok's free tier answers browser-like requests (the Android WebView has a Chrome user agent) with an HTML warning
 * page. For tunnel URLs, add ngrok's documented bypass header to every call to our API. Called once at app start.
 */
export function installTunnelHeader(): void {
  if (
    typeof window === "undefined" ||
    !/\.ngrok[a-z.-]*\//i.test(`${API_BASE}/`)
  )
    return;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.startsWith(API_BASE)) return original(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("ngrok-skip-browser-warning", "1");
    return original(input, { ...init, headers });
  };
}
