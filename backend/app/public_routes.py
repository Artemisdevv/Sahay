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
from app.dispatch import engine
from app.models import Dispatch, Incident, Unit
from app.rate_limit import rate_limiter

# status shown to the public: raw status -> public word
PUBLIC_STATUS = {
    "dispatched": "help assigned",
    "en_route": "help on the way",
    "on_scene": "help on scene",
    "resolved": "resolved",
}
# Public wording for a unit assigned to a confirmed incident (contract 9.4). Anything else is not published.
UNIT_STATUS = {"accepted": "help assigned", "en_route": "help on the way", "on_scene": "help on scene"}
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


def opaque(salt: str, kind: str, raw_id: str) -> str:
    return hashlib.sha256(f"{salt}|{kind}|{raw_id}".encode("utf-8")).hexdigest()[:12]


def public_unit(db, dispatch: Dispatch, salt: str) -> dict | None:
    """One unit that is on its way to, or at, a confirmed incident. No name, crew or real id; ~100 m position."""
    status = UNIT_STATUS.get(dispatch.status)
    unit, incident = db.get(Unit, dispatch.unit_id), db.get(Incident, dispatch.incident_id)
    if status is None or unit is None or incident is None or incident.status not in PUBLIC_STATUS:
        return None
    remaining = engine.haversine_km(unit.lat, unit.lng, incident.lat, incident.lng)
    return {
        "id": opaque(salt, "unit", unit.unit_id),
        "service_type": unit.service_type,
        "status": status,
        "location": {"lat": round(unit.lat, 3), "lng": round(unit.lng, 3)},
        "incident": hashlib.sha256(f"{salt}|{incident.incident_id}".encode("utf-8")).hexdigest()[:12],
        "eta_minutes": None if dispatch.status == "on_scene" else engine.eta_minutes(remaining),
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

    @router.get("/units")
    def public_units(request: Request, response: Response):
        rate_limiter.check(f"public-units:{request_ip(request)}", limit_per_minute * 2)
        with SessionLocal() as db:
            rows = db.scalars(select(Dispatch).where(Dispatch.status.in_(list(UNIT_STATUS)))).all()
            units = [u for u in (public_unit(db, d, salt) for d in rows) if u is not None]
        response.headers["Cache-Control"] = "public, max-age=2"
        return {"units": units, "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}

    app.include_router(router)
