import { useEffect, useRef, useState } from "react";
import { getSession } from "@/lib/session";

// VITE_WS_URL may be a full ws(s):// URL or a path like "/ws/v1" (same origin as the page, used by the Docker image).
function resolveWsBase(raw: string): string {
  const value = raw.replace(/\/+$/, "");
  if (value.startsWith("/") && typeof window !== "undefined") {
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${window.location.host}${value}`;
  }
  return value.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

const WS_BASE = resolveWsBase(
  import.meta.env["VITE_WS_URL"] || "ws://localhost:8000/ws/v1",
);

export type DispatchUpdatedEvent = {
  type: "dispatch.updated";
  ts: string;
  data: {
    dispatch_id: string;
    incident_id: string;
    unit_id: string;
    service_type: string;
    status: string;
  };
};

export type IncidentUpdatedEvent = {
  type: "incident.updated";
  ts: string;
  data: {
    incident_id: string;
    status: string;
  };
};

export type IncidentCreatedEvent = {
  type: "incident.created";
  ts: string;
  data: Record<string, unknown>;
};

export type UnitMovedEvent = {
  type: "unit.moved";
  ts: string;
  data: {
    unit_id: string;
    name?: string | null;
    service_type?: "ambulance" | "police" | "fire" | "municipal" | null;
    location: { lat: number; lng: number };
    status: string;
    incident_id?: string | null;
    heading_deg?: number | null;
    speed_kmh?: number | null;
    eta_seconds?: number | null;
  };
};

export type WSEvent =
  | DispatchUpdatedEvent
  | IncidentUpdatedEvent
  | IncidentCreatedEvent
  | UnitMovedEvent;

export function useDispatchWS(onEvent: (event: WSEvent) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const session = getSession();
    if (!session?.token) return;
    let active = true;

    const connect = () => {
      if (!active) return;
      const ws = new WebSocket(
        `${WS_BASE}?token=${encodeURIComponent(session.token)}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        if (!active) return;
        setConnected(true);
        console.log("[WS] Connected");
      };

      ws.onmessage = (event) => {
        if (!active) return;
        try {
          const data = JSON.parse(event.data) as WSEvent;
          onEvent(data);
        } catch (e) {
          console.warn("[WS] Failed to parse message", e);
        }
      };

      ws.onclose = () => {
        if (!active) return;
        setConnected(false);
        console.log("[WS] Disconnected, reconnecting in 3s...");
        reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
      };

      ws.onerror = (err) => {
        console.error("[WS] Error", err);
      };
    };

    connect();

    return () => {
      active = false;
      if (reconnectTimeoutRef.current)
        clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [onEvent]);

  return { connected };
}
