import { useEffect, useRef, useState } from "react";
import { getSession } from "@/lib/session";

const WS_BASE = (
  import.meta.env["VITE_WS_BASE"] || "http://localhost:8000/ws/v1"
).replace(/\/+$/, "");

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

export type WSEvent = DispatchUpdatedEvent | IncidentUpdatedEvent;

export function useDispatchWS(onEvent: (event: WSEvent) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const session = getSession();
    if (!session?.token) return;

    const connect = () => {
      const ws = new WebSocket(
        `${WS_BASE}?token=${encodeURIComponent(session.token)}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        console.log("[WS] Connected");
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WSEvent;
          onEvent(data);
        } catch (e) {
          console.warn("[WS] Failed to parse message", e);
        }
      };

      ws.onclose = () => {
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
      if (reconnectTimeoutRef.current)
        clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [onEvent]);

  return { connected };
}
