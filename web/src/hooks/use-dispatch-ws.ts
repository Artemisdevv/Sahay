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
    location: { lat: number; lng: number };
    status: string;
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

    // The token is sent as the first message, never in the URL (URLs are written to access logs).
    let failures = 0;
    const connect = () => {
      if (!active) return;
      const ws = new WebSocket(WS_BASE);
      wsRef.current = ws;
      let authenticated = false;

      ws.onopen = () => {
        if (!active) return;
        ws.send(JSON.stringify({ type: "auth", token: session.token }));
      };

      ws.onmessage = (event) => {
        if (!active) return;
        try {
          const data = JSON.parse(event.data) as
            WSEvent | { type: "auth.ok" | "pong" };
          if (data.type === "auth.ok") {
            authenticated = true;
            failures = 0;
            setConnected(true);
            return;
          }
          if (data.type === "pong") return;
          onEvent(data as WSEvent);
        } catch (e) {
          console.warn("[WS] Failed to parse message", e);
        }
      };

      ws.onclose = () => {
        if (!active) return;
        setConnected(false);
        // Never got in (expired token or server down): back off instead of hammering the server every 3 s.
        if (!authenticated) failures += 1;
        const delay = Math.min(30_000, 3_000 * 2 ** Math.min(failures, 4));
        reconnectTimeoutRef.current = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        /* onclose follows and handles the retry */
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
