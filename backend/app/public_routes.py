"""Public incident feed for the open map (no login).

Only coarse, non-identifying facts are published, and only for incidents that are confirmed (an admin approved
or the system auto-dispatched). Never exposed here: summary text, people count, hazards, report ids, reporter or
device data, exact coordinates. Position is rounded to 2 decimals (about 1 km) so a person asking for help cannot
be located to a street or a house from the public page.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Callable

from fastapi import APIRouter, FastAPI, Query, Request, Response
from sqlalchemy import select

from app.database import SessionLocal
from app.models import Incident
from app.rate_limit import rate_limiter

# status shown to the public: raw status -> public word
PUBLIC_STATUS = {
    "dispatched": "help assigned",
    "en_route": "help on the way",
    "on_scene": "help on scene",
    "resolved": "resolved",
}
SEVERITY_LABEL = {1: "low", 2: "low", 3: "medium", 4: "high", 5: "critical"}


def public_incident(incident: Incident, salt: str) -> dict | None:
    status = PUBLIC_STATUS.get(incident.status)
    if status is None:
        return None
    opaque = hashlib.sha256(f"{salt}|{incident.incident_id}".encode("utf-8")).hexdigest()[:12]
    created = incident.created_at if incident.created_at.tzinfo else incident.created_at.replace(tzinfo=timezone.utc)
    return {
        "id": opaque,
        "incident_type": incident.incident_type,
        "severity": SEVERITY_LABEL.get(incident.severity, "medium"),
        "status": status,
        "location": {"lat": round(incident.lat, 2), "lng": round(incident.lng, 2)},
        "area_precision_km": 1,
        "reported_at": created.astimezone(timezone.utc).replace(second=0, microsecond=0, tzinfo=None).isoformat() + "Z",
    }


def install(app: FastAPI, salt: str, request_ip: Callable[[Request], str], limit_per_minute: int = 60) -> None:
    router = APIRouter(prefix="/api/v1/public")

    @router.get("/incidents")
    def public_incidents(request: Request, response: Response, limit: int = Query(default=100, ge=1, le=200)):
        rate_limiter.check(f"public:{request_ip(request)}", limit_per_minute)
        with SessionLocal() as db:
            rows = db.scalars(select(Incident).order_by(Incident.created_at.desc()).limit(limit * 3)).all()
        items = [p for p in (public_incident(r, salt) for r in rows) if p is not None][:limit]
        response.headers["Cache-Control"] = "public, max-age=5"
        return {"incidents": items, "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}

    app.include_router(router)
