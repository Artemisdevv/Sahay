"""Live response (X-04, contract section 9): who is being called, and units visibly arriving.

Three parts, all optional and off by default except the read-only payload builders:
  * `called_payload`: the ordered candidate list for an incident ("calling Ambulance 01, then Ambulance 02").
  * `Mover`: a background step that glides en_route units to their incident and marks them on scene, can auto-accept
    called assignments and skip units that do not answer. Demo only; it stands aside for a unit whose phone reports a
    real position.
  * `PATCH /units/{id}/location`: a real service phone reports its GPS.
Dispatch decisions stay in `app.dispatch.engine` (deterministic). This module never chooses a unit itself.
"""
from __future__ import annotations

import asyncio
import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import SessionLocal, get_db
from app.dispatch import engine
from app.events import manager
from app.models import AuditEntry, Dispatch, Incident, Unit
from app.settings import settings

log = logging.getLogger("sahay.live")
SYSTEM = {"type": "system", "id": "demo_mover"}
DEPART_DELAY_S = 2.0  # after auto-accept, the unit pulls out
REPORTED_FRESH_S = 15.0  # a unit that reported a real position this recently is not moved by the demo mover
SHOWN_CANDIDATES = 4

STATE_BY_STATUS = {
    "approved": "calling",
    "accepted": "accepted",
    "en_route": "accepted",
    "on_scene": "accepted",
    "completed": "accepted",
    "declined": "declined",
    "proposed": "standby",
}


def _utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ---- payload builders ---------------------------------------------------------------

def called_payload(db: Session, incident_id: str, service_type: str) -> dict | None:
    """Contract 9.2 `dispatch.called`: units ranked by distance, with who was called and what they answered."""
    inc = db.get(Incident, incident_id)
    if inc is None:
        return None
    db.flush()
    dispatches = [
        d for d in db.scalars(
            select(Dispatch).where(Dispatch.incident_id == incident_id, Dispatch.service_type == service_type)
            .order_by(Dispatch.created_at)
        ).all() if d.status != "cancelled"
    ]
    if not dispatches:
        return None
    no_answer_ids = {
        row.details.get("dispatch_id")
        for row in db.scalars(select(AuditEntry).where(AuditEntry.action == "dispatch.no_answer")).all()
        if (row.target or {}).get("id") == incident_id
    }
    units = db.scalars(select(Unit).where(Unit.service_type == service_type)).all()
    ranked = sorted(units, key=lambda u: (engine.haversine_km(inc.lat, inc.lng, u.lat, u.lng), u.unit_id))
    rank_of = {u.unit_id: i + 1 for i, u in enumerate(ranked)}
    candidates, used = [], set()
    for d in dispatches:
        unit = db.get(Unit, d.unit_id)
        state = "no_answer" if d.dispatch_id in no_answer_ids else STATE_BY_STATUS.get(d.status, "standby")
        candidates.append({
            "rank": rank_of.get(d.unit_id, 0), "unit_id": d.unit_id, "name": unit.name if unit else "Unit",
            "distance_km": d.distance_km, "eta_minutes": d.eta_minutes, "state": state,
        })
        used.add(d.unit_id)
    for u in ranked:  # who would be called next
        if len(candidates) >= SHOWN_CANDIDATES:
            break
        if u.unit_id in used or u.status != "available":
            continue
        dist = engine.haversine_km(inc.lat, inc.lng, u.lat, u.lng)
        candidates.append({"rank": rank_of[u.unit_id], "unit_id": u.unit_id, "name": u.name,
                           "distance_km": round(dist, 2), "eta_minutes": engine.eta_minutes(dist), "state": "standby"})
    candidates.sort(key=lambda c: (c["state"] == "standby", c["rank"]))
    return {"incident_id": incident_id, "service_type": service_type, "candidates": candidates}


def bearing_deg(lat1: float, lng1: float, lat2: float, lng2: float) -> int:
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lng2 - lng1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return int(round((math.degrees(math.atan2(y, x)) + 360) % 360))


def moved_payload(unit: Unit, *, incident_id: str | None = None, heading_deg: int | None = None,
                  speed_kmh: float | None = None, eta_seconds: int | None = None) -> dict:
    return {
        "unit_id": unit.unit_id, "name": unit.name, "service_type": unit.service_type,
        "location": {"lat": round(unit.lat, 6), "lng": round(unit.lng, 6)}, "status": unit.status,
        "incident_id": incident_id, "heading_deg": heading_deg,
        "speed_kmh": None if speed_kmh is None else round(speed_kmh, 1), "eta_seconds": eta_seconds,
    }


def peer_unit_ids(db: Session, incident_id: str | None, own_unit_id: str) -> set[str]:
    """Units that may see a given unit.moved: the unit itself and every unit holding the same incident."""
    ids = {own_unit_id}
    if incident_id:
        ids |= {u for (u,) in db.execute(
            select(Dispatch.unit_id).where(Dispatch.incident_id == incident_id, Dispatch.status.in_(engine.OCCUPYING)))}
    return ids


async def publish_moved(db: Session, unit: Unit, **kw) -> None:
    await manager.publish("unit.moved", moved_payload(unit, **kw),
                          service_unit_ids=peer_unit_ids(db, kw.get("incident_id"), unit.unit_id))


async def publish_called(db: Session, dispatches: list[Dispatch]) -> None:
    """One `dispatch.called` per (incident, service) touched. Admin gets all; units get the lists they appear in."""
    for incident_id, service_type in dict.fromkeys((d.incident_id, d.service_type) for d in dispatches):
        payload = called_payload(db, incident_id, service_type)
        if payload is not None:
            await manager.publish("dispatch.called", payload,
                                  service_unit_ids={c["unit_id"] for c in payload["candidates"]})


# ---- the demo mover -----------------------------------------------------------------

@dataclass
class Trip:
    start: tuple[float, float]
    t0: datetime
    total_km: float


@dataclass
class MoverState:
    trips: dict[str, Trip] = field(default_factory=dict)
    reported: dict[str, datetime] = field(default_factory=dict)  # unit_id -> last real position report


@dataclass
class Config:
    mover: bool = False
    arrival_s: float = 60.0
    auto_accept_s: float = 0.0
    auto_complete_s: float = 0.0
    call_timeout_s: float = 0.0

    @property
    def active(self) -> bool:
        return self.mover or self.auto_accept_s > 0 or self.auto_complete_s > 0 or self.call_timeout_s > 0

    @classmethod
    def from_settings(cls) -> "Config":
        return cls(settings.sahay_demo_mover, settings.sahay_demo_arrival_seconds,
                   settings.sahay_demo_auto_accept_seconds, settings.sahay_demo_auto_complete_seconds,
                   settings.sahay_call_timeout_s)


@dataclass
class TickResult:
    outcomes: list[engine.Outcome] = field(default_factory=list)
    moved: list[tuple[Unit, dict]] = field(default_factory=list)


def _age_s(dt: datetime, now: datetime) -> float:
    return (now - _utc(dt)).total_seconds()


def tick(db: Session, now: datetime, cfg: Config, state: MoverState) -> TickResult:
    """One step of the background logic. Pure with respect to time: `now` is passed in so tests control it."""
    res = TickResult()
    # Snapshot first, so a unit accepted in this tick departs in a later one (and tests with injected time behave
    # like the real loop, where an accept stamps "now").
    approved = db.scalars(select(Dispatch).where(Dispatch.status == "approved")).all()
    accepted = db.scalars(select(Dispatch).where(Dispatch.status == "accepted")).all() if cfg.auto_accept_s > 0 else []
    for d in approved:
        age = _age_s(d.updated_at, now)
        if cfg.auto_accept_s > 0 and age >= cfg.auto_accept_s:
            res.outcomes.append(engine.accept(db, d.dispatch_id, d.unit_id, SYSTEM))
        elif cfg.call_timeout_s > 0 and age >= cfg.call_timeout_s:
            res.outcomes.append(engine.no_answer(db, d.dispatch_id, SYSTEM))
    for d in accepted:
        if _age_s(d.updated_at, now) >= DEPART_DELAY_S:
            res.outcomes.append(engine.set_progress(db, d.dispatch_id, d.unit_id, SYSTEM, "en_route"))
    if cfg.mover:
        for d in db.scalars(select(Dispatch).where(Dispatch.status == "en_route")).all():
            unit, inc = db.get(Unit, d.unit_id), db.get(Incident, d.incident_id)
            if unit is None or inc is None:
                continue
            last = state.reported.get(unit.unit_id)
            if last is not None and _age_s(last, now) < REPORTED_FRESH_S:
                continue  # a real phone is reporting this unit's position
            trip = state.trips.get(d.dispatch_id)
            if trip is None:
                total = engine.haversine_km(unit.lat, unit.lng, inc.lat, inc.lng)
                trip = state.trips[d.dispatch_id] = Trip((unit.lat, unit.lng), now, total)
            progress = min(1.0, _age_s(trip.t0, now) / max(cfg.arrival_s, 1.0))
            heading = bearing_deg(trip.start[0], trip.start[1], inc.lat, inc.lng)
            speed = trip.total_km / (max(cfg.arrival_s, 1.0) / 3600) if trip.total_km > 0 else 0.0
            if progress >= 1.0 or trip.total_km < 0.05:
                unit.lat, unit.lng = inc.lat, inc.lng
                unit.updated_at = now
                state.trips.pop(d.dispatch_id, None)
                out = engine.set_progress(db, d.dispatch_id, d.unit_id, SYSTEM, "on_scene")
                res.outcomes.append(out)
                res.moved.append((unit, {"incident_id": inc.incident_id, "heading_deg": heading, "speed_kmh": 0.0,
                                         "eta_seconds": 0}))
            else:
                unit.lat = trip.start[0] + (inc.lat - trip.start[0]) * progress
                unit.lng = trip.start[1] + (inc.lng - trip.start[1]) * progress
                unit.updated_at = now
                db.commit()
                res.moved.append((unit, {"incident_id": inc.incident_id, "heading_deg": heading, "speed_kmh": speed,
                                         "eta_seconds": int(math.ceil((1 - progress) * cfg.arrival_s))}))
    if cfg.auto_complete_s > 0:
        for d in db.scalars(select(Dispatch).where(Dispatch.status == "on_scene")).all():
            if _age_s(d.updated_at, now) >= cfg.auto_complete_s:
                res.outcomes.append(engine.set_progress(db, d.dispatch_id, d.unit_id, SYSTEM, "completed"))
    return res


# ---- wiring -------------------------------------------------------------------------

class LocationBody(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


def install(app: FastAPI, current_user: Callable, incident_json: Callable) -> None:
    from app.dispatch.routes import broadcast

    state = MoverState()
    cfg = Config.from_settings()

    @app.patch("/api/v1/units/{unit_id}/location")
    async def report_location(unit_id: str, body: LocationBody, user: dict = Depends(current_user),
                              db: Session = Depends(get_db)):
        role = user.get("role")
        if role not in ("admin", "service") or (role == "service" and user.get("unit_id") != unit_id):
            raise HTTPException(status_code=403, detail="Forbidden")
        unit = db.get(Unit, unit_id)
        if unit is None:
            raise HTTPException(status_code=404, detail="Unit not found")
        unit.lat, unit.lng, unit.updated_at = body.lat, body.lng, datetime.now(timezone.utc)
        db.commit()
        state.reported[unit_id] = datetime.now(timezone.utc)
        active = db.scalar(select(Dispatch).where(Dispatch.unit_id == unit_id, Dispatch.status.in_(engine.OCCUPYING)))
        await publish_moved(db, unit, incident_id=active.incident_id if active else None)
        return {"unit_id": unit_id, "location": {"lat": unit.lat, "lng": unit.lng}}

    async def run() -> None:
        while True:
            await asyncio.sleep(1.0)
            try:
                with SessionLocal() as db:
                    res = tick(db, datetime.now(timezone.utc), cfg, state)
                    for out in res.outcomes:
                        await broadcast(db, out, incident_json)
                    for unit, extra in res.moved:
                        await publish_moved(db, unit, **extra)
            except Exception:  # keep the loop alive: one bad tick must not stop units from arriving
                log.exception("live tick failed")

    if cfg.active:
        inner = app.router.lifespan_context

        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def lifespan(a: FastAPI):
            task = asyncio.create_task(run())
            try:
                async with inner(a) as st:
                    yield st
            finally:
                task.cancel()

        app.router.lifespan_context = lifespan
    app.state.live_state = state
