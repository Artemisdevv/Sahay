import asyncio

from fastapi import HTTPException, WebSocket, WebSocketDisconnect

from app.rate_limit import rate_limiter
from app.settings import settings


ADMIN_EVENTS = {
    "incident.created",
    "incident.updated",
    "dispatch.proposed",
    "dispatch.updated",
    "unit.moved",
    "agent.trace",
    "audit.appended",
}
SERVICE_EVENTS = {"incident.updated", "dispatch.updated"}
CIVILIAN_EVENTS = {"report.status"}
SERVICE_INCIDENT_FIELDS = {
    "incident_id",
    "status",
    "incident_type",
    "severity",
    "urgency_score",
    "location",
    "summary_redacted",
    "people_count",
    "hazards",
    "needed_services",
    "report_count",
    "reason",
    "created_at",
    "updated_at",
}


class ConnectionManager:
    def __init__(self):
        self._clients: dict[WebSocket, dict] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, claims: dict) -> None:
        await websocket.accept()
        async with self._lock:
            self._clients[websocket] = claims

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.pop(websocket, None)

    async def publish(
        self,
        event_type: str,
        data: dict,
        *,
        service_unit_ids: set[str] | None = None,
        civilian_device_id: str | None = None,
    ) -> None:
        from datetime import datetime, timezone

        message = {
            "type": event_type,
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "data": data,
        }
        async with self._lock:
            clients = list(self._clients.items())
        stale = []
        for websocket, claims in clients:
            role = claims.get("role")
            if not self._can_receive(event_type, data, role, claims, service_unit_ids, civilian_device_id):
                continue
            try:
                outgoing = message
                if role == "service" and event_type == "incident.updated":
                    outgoing = {**message, "data": {key: value for key, value in data.items() if key in SERVICE_INCIDENT_FIELDS}}
                await websocket.send_json(outgoing)
            except (OSError, RuntimeError, WebSocketDisconnect):
                stale.append(websocket)
        for websocket in stale:
            await self.disconnect(websocket)

    @staticmethod
    def _can_receive(event_type, data, role, claims, service_unit_ids, civilian_device_id) -> bool:
        if role == "admin":
            return event_type in ADMIN_EVENTS
        if role == "service" and event_type in SERVICE_EVENTS:
            unit_id = claims.get("unit_id")
            if event_type == "dispatch.updated":
                return data.get("unit_id") == unit_id and data.get("status") != "proposed"
            return unit_id in (service_unit_ids or set())
        if role == "civilian" and event_type in CIVILIAN_EVENTS:
            return claims.get("device_id") == civilian_device_id
        return False


manager = ConnectionManager()


async def websocket_loop(websocket: WebSocket, claims: dict) -> None:
    await manager.connect(websocket, claims)
    try:
        while True:
            try:
                message = await websocket.receive_json()
            except ValueError:
                await websocket.close(code=1003, reason="Expected a JSON message")
                break
            subject = claims.get("device_id") or claims["sub"]
            try:
                rate_limiter.check(f"ws-message:{subject}", settings.sahay_rate_limit_per_minute)
            except HTTPException:
                await websocket.close(code=1008, reason="Rate limit exceeded")
                break
            if isinstance(message, dict) and message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(websocket)
