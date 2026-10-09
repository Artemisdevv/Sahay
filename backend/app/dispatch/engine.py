"""Deterministic dispatch engine (B-04). No LLM, no network, no randomness.

Rules:
- Nearest AVAILABLE unit of the needed service type by Haversine distance; ties break on unit_id.
- ETA = distance / 30 km/h (urban speed), rounded up to whole minutes, minimum 1.
- Proposing does not reserve a unit. Approving does (unit -> assigned), so a unit can never be
  committed to two incidents. If a proposed unit was taken meanwhile, the next nearest replaces it.
- Dispatch status transitions are a closed table; anything else raises DispatchError(409).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditEntry, Dispatch, Incident, Report, Unit

EARTH_RADIUS_KM = 6371.0088
URBAN_SPEED_KMH = 30.0
PROPOSED_BY = "dispatch_agent"
SERVICE_TYPES = ("ambulance", "police", "fire", "municipal")

ACTIVE = ("proposed", "approved", "accepted", "en_route", "on_scene")
OCCUPYING = ("approved", "accepted", "en_route", "on_scene")  # dispatches that hold a unit

TRANSITIONS: dict[str, tuple[str, ...]] = {
    "proposed": ("approved", "cancelled"),
    "approved": ("accepted", "declined", "cancelled"),
    "accepted": ("en_route", "cancelled"),
    "en_route": ("on_scene", "cancelled"),
    "on_scene": ("completed", "cancelled"),
    "declined": (),
    "completed": (),
    "cancelled": (),
}
# Unit status implied by the status of the dispatch holding it.
UNIT_STATUS = {
    "approved": "assigned",
    "accepted": "assigned",
    "en_route": "en_route",
    "on_scene": "on_scene",
    "declined": "available",
    "completed": "available",
    "cancelled": "available",
}
REPORT_STATUSES = {
    "received", "processing", "triaged", "pending_approval", "dispatched",
    "en_route", "on_scene", "resolved", "rejected",
}


class DispatchError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class Candidate:
    unit: Unit
    distance_km: float
    eta_minutes: int


@dataclass
class Outcome:
    """What changed, so the caller can broadcast. The engine itself never does I/O beyond the DB."""

    incident: Incident | None = None
    dispatches: list[Dispatch] = field(default_factory=list)
    reports: list[Report] = field(default_factory=list)
    unfilled: list[str] = field(default_factory=list)  # service types with no available unit

    def touch(self, d: Dispatch) -> None:
        if d not in self.dispatches:
            self.dispatches.append(d)


# ---- pure math ---------------------------------------------------------------

def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat, dlng = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def eta_minutes(distance_km: float) -> int:
    return max(1, math.ceil(distance_km / URBAN_SPEED_KMH * 60 - 1e-9))


def rank_candidates(units: list[Unit], lat: float, lng: float) -> list[Candidate]:
    ranked = []
    for u in units:
        d = haversine_km(lat, lng, u.lat, u.lng)
        ranked.append(Candidate(u, round(d, 2), eta_minutes(d)))
    # Sort on the unrounded-equivalent distance then unit_id so ties are stable across runs.
    return sorted(ranked, key=lambda c: (haversine_km(lat, lng, c.unit.lat, c.unit.lng), c.unit.unit_id))


def find_nearest_available(
    db: Session, service_type: str, lat: float, lng: float, exclude_unit_ids: frozenset[str] | set[str] = frozenset()
) -> Candidate | None:
    if service_type not in SERVICE_TYPES:
        raise DispatchError(400, f"unknown service type: {service_type}")
    db.flush()  # see unit status changes made earlier in this unit of work
    units = db.scalars(
        select(Unit).where(Unit.service_type == service_type, Unit.status == "available")
    ).all()
    units = [u for u in units if u.unit_id not in exclude_unit_ids]
    ranked = rank_candidates(units, lat, lng)
    return ranked[0] if ranked else None


# ---- helpers -----------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(timezone.utc)


def audit(db: Session, actor: dict, action: str, target: dict, details: dict | None = None) -> None:
    """Single audit write point for this module; B-09 will chain hashes behind it."""
    db.add(AuditEntry(actor=actor, action=action, target=target, details=details or {}))


def _incident(db: Session, incident_id: str) -> Incident:
    inc = db.get(Incident, incident_id)
    if inc is None:
        raise DispatchError(404, "Incident not found")
    return inc


def _dispatches(db: Session, incident_id: str, statuses=None, service_type: str | None = None) -> list[Dispatch]:
    db.flush()  # sessions here run autoflush=False; queries must see pending status changes
    q = select(Dispatch).where(Dispatch.incident_id == incident_id)
    if statuses is not None:
        q = q.where(Dispatch.status.in_(statuses))
    if service_type is not None:
        q = q.where(Dispatch.service_type == service_type)
    return list(db.scalars(q.order_by(Dispatch.created_at, Dispatch.dispatch_id)).all())


def _used_unit_ids(db: Session, incident_id: str, service_type: str) -> set[str]:
    """Units already tried for this incident+service (any status), so we never re-pick one."""
    return {d.unit_id for d in _dispatches(db, incident_id, service_type=service_type)}


def _set_status(db: Session, d: Dispatch, new: str, out: Outcome) -> None:
    if new not in TRANSITIONS.get(d.status, ()):
        raise DispatchError(409, f"Cannot move dispatch from {d.status} to {new}")
    d.status = new
    d.updated_at = _now()
    unit = db.get(Unit, d.unit_id)
    if unit is not None and new in UNIT_STATUS:
        unit.status = UNIT_STATUS[new]
        unit.updated_at = _now()
    out.touch(d)


def _new_dispatch(db: Session, inc: Incident, cand: Candidate, status: str, proposed_by: str, out: Outcome) -> Dispatch:
    d = Dispatch(
        incident_id=inc.incident_id,
        unit_id=cand.unit.unit_id,
        service_type=cand.unit.service_type,
        status="proposed",
        distance_km=cand.distance_km,
        eta_minutes=cand.eta_minutes,
        proposed_by=proposed_by,
    )
    db.add(d)
    db.flush()
    out.touch(d)
    if status == "approved":
        _set_status(db, d, "approved", out)
    return d


def _rollup(db: Session, inc: Incident, out: Outcome) -> None:
    """Incident status follows its active dispatches once dispatching has started."""
    if inc.status not in ("dispatched", "en_route", "on_scene"):
        return
    statuses = {d.status for d in _dispatches(db, inc.incident_id, OCCUPYING)}
    if "on_scene" in statuses:
        new = "on_scene"
    elif "en_route" in statuses:
        new = "en_route"
    elif statuses:
        new = "dispatched"
    else:
        return
    if new != inc.status:
        inc.status = new
        inc.updated_at = _now()
    out.incident = inc


def _sync_reports(db: Session, inc: Incident, out: Outcome) -> None:
    if inc.status not in REPORT_STATUSES:
        return
    for rid in inc.report_ids or []:
        rep = db.get(Report, rid)
        if rep is None:
            continue
        if rep.status != inc.status or rep.incident_id != inc.incident_id:
            rep.status = inc.status
            rep.incident_id = inc.incident_id
            rep.updated_at = _now()
            out.reports.append(rep)


def _finish(db: Session, inc: Incident, out: Outcome) -> Outcome:
    _rollup(db, inc, out)
    out.incident = inc
    _sync_reports(db, inc, out)
    db.commit()
    return out


# ---- propose / approve / reject / reassign -----------------------------------

def propose(
    db: Session, inc: Incident, service_types: list[str], *, auto_approve: bool = False,
    actor: dict | None = None,
) -> Outcome:
    """Pick the nearest available unit per needed service. Admin approval is the caller's policy:
    pass auto_approve=True only for severity <= 3 (contract section 4)."""
    out = Outcome(incident=inc)
    actor = actor or {"type": "agent", "id": PROPOSED_BY}
    for st in dict.fromkeys(service_types):  # de-dupe, keep order
        tried = _used_unit_ids(db, inc.incident_id, st)
        cand = find_nearest_available(db, st, inc.lat, inc.lng, tried)
        if cand is None:
            out.unfilled.append(st)
            continue
        d = _new_dispatch(db, inc, cand, "proposed", PROPOSED_BY, out)
        audit(db, actor, "dispatch.propose", {"type": "incident", "id": inc.incident_id},
              {"dispatch_id": d.dispatch_id, "unit_id": d.unit_id, "service_type": st,
               "distance_km": d.distance_km, "eta_minutes": d.eta_minutes})
    db.flush()
    if auto_approve and out.dispatches:
        approved = approve_incident(db, inc.incident_id, actor)
        approved.unfilled = out.unfilled + approved.unfilled
        return approved
    return _finish(db, inc, out)


def approve_incident(db: Session, incident_id: str, actor: dict) -> Outcome:
    inc = _incident(db, incident_id)
    if inc.status in ("resolved", "rejected"):
        raise DispatchError(409, f"Incident is {inc.status}")
    proposed = _dispatches(db, incident_id, ("proposed",))
    if not proposed:
        raise DispatchError(409, "No proposed dispatches to approve")
    out = Outcome(incident=inc)
    for d in proposed:
        unit = db.get(Unit, d.unit_id)
        if unit is None or unit.status != "available":
            # Taken since proposal: replace with the next nearest that is free right now.
            tried = _used_unit_ids(db, incident_id, d.service_type)
            cand = find_nearest_available(db, d.service_type, inc.lat, inc.lng, tried)
            _set_status(db, d, "cancelled", out)
            audit(db, actor, "dispatch.replace", {"type": "incident", "id": incident_id},
                  {"cancelled_dispatch_id": d.dispatch_id, "reason": "unit no longer available"})
            if cand is None:
                out.unfilled.append(d.service_type)
                continue
            d = _new_dispatch(db, inc, cand, "approved", PROPOSED_BY, out)
        else:
            _set_status(db, d, "approved", out)
        audit(db, actor, "dispatch.approve", {"type": "incident", "id": incident_id},
              {"dispatch_id": d.dispatch_id, "unit_id": d.unit_id})
    if _dispatches(db, incident_id, OCCUPYING):
        inc.status = "dispatched"
        inc.updated_at = _now()
    if out.unfilled:
        inc.reason = f"No available unit for: {', '.join(out.unfilled)}"[:250]
    return _finish(db, inc, out)


def reject_incident(db: Session, incident_id: str, actor: dict, reason: str) -> Outcome:
    if not reason or not reason.strip():
        raise DispatchError(400, "reason is required")
    inc = _incident(db, incident_id)
    if inc.status in ("resolved", "rejected"):
        raise DispatchError(409, f"Incident is {inc.status}")
    out = Outcome(incident=inc)
    for d in _dispatches(db, incident_id, ACTIVE):
        _set_status(db, d, "cancelled", out)
    inc.status = "rejected"
    inc.reason = reason.strip()[:250]
    inc.updated_at = _now()
    audit(db, actor, "dispatch.reject", {"type": "incident", "id": incident_id}, {"reason": reason.strip()})
    return _finish(db, inc, out)


def reassign(db: Session, incident_id: str, actor: dict, needed_service: str, unit_id: str) -> Outcome:
    inc = _incident(db, incident_id)
    if inc.status in ("resolved", "rejected"):
        raise DispatchError(409, f"Incident is {inc.status}")
    unit = db.get(Unit, unit_id)
    if unit is None:
        raise DispatchError(404, "Unit not found")
    if unit.service_type != needed_service:
        raise DispatchError(409, f"Unit is {unit.service_type}, not {needed_service}")
    if unit.status != "available":
        raise DispatchError(409, f"Unit is {unit.status}")
    out = Outcome(incident=inc)
    for d in _dispatches(db, incident_id, ACTIVE, needed_service):
        _set_status(db, d, "cancelled", out)
    live = inc.status in ("dispatched", "en_route", "on_scene")
    d_dist = haversine_km(inc.lat, inc.lng, unit.lat, unit.lng)
    cand = Candidate(unit, round(d_dist, 2), eta_minutes(d_dist))
    d = _new_dispatch(db, inc, cand, "approved" if live else "proposed", "admin", out)
    audit(db, actor, "dispatch.reassign", {"type": "incident", "id": incident_id},
          {"dispatch_id": d.dispatch_id, "unit_id": unit_id, "service_type": needed_service})
    return _finish(db, inc, out)


# ---- service-side actions ----------------------------------------------------

def _own_dispatch(db: Session, dispatch_id: str, unit_id: str) -> Dispatch:
    d = db.get(Dispatch, dispatch_id)
    if d is None or d.unit_id != unit_id:
        raise DispatchError(404, "Dispatch not found")
    return d


def accept(db: Session, dispatch_id: str, unit_id: str, actor: dict) -> Outcome:
    d = _own_dispatch(db, dispatch_id, unit_id)
    inc = _incident(db, d.incident_id)
    out = Outcome(incident=inc)
    _set_status(db, d, "accepted", out)
    audit(db, actor, "dispatch.accept", {"type": "incident", "id": inc.incident_id}, {"dispatch_id": d.dispatch_id})
    return _finish(db, inc, out)


def decline(db: Session, dispatch_id: str, unit_id: str, actor: dict, reason: str = "") -> Outcome:
    """Unit declines: mark declined, free the unit, re-propose the next nearest (auto-approved because
    an admin already approved this dispatch)."""
    d = _own_dispatch(db, dispatch_id, unit_id)
    inc = _incident(db, d.incident_id)
    out = Outcome(incident=inc)
    _set_status(db, d, "declined", out)
    audit(db, actor, "dispatch.decline", {"type": "incident", "id": inc.incident_id},
          {"dispatch_id": d.dispatch_id, "reason": reason})
    tried = _used_unit_ids(db, inc.incident_id, d.service_type)
    cand = find_nearest_available(db, d.service_type, inc.lat, inc.lng, tried)
    if cand is None:
        out.unfilled.append(d.service_type)
        inc.reason = f"No available {d.service_type} unit after decline"[:250]
    else:
        nd = _new_dispatch(db, inc, cand, "approved", PROPOSED_BY, out)
        audit(db, {"type": "agent", "id": PROPOSED_BY}, "dispatch.propose",
              {"type": "incident", "id": inc.incident_id},
              {"dispatch_id": nd.dispatch_id, "unit_id": nd.unit_id, "after_decline_of": d.dispatch_id})
    return _finish(db, inc, out)


def set_progress(db: Session, dispatch_id: str, unit_id: str, actor: dict, new_status: str) -> Outcome:
    if new_status not in ("en_route", "on_scene", "completed"):
        raise DispatchError(400, "status must be en_route, on_scene or completed")
    d = _own_dispatch(db, dispatch_id, unit_id)
    inc = _incident(db, d.incident_id)
    out = Outcome(incident=inc)
    _set_status(db, d, new_status, out)
    audit(db, actor, "dispatch.status", {"type": "incident", "id": inc.incident_id},
          {"dispatch_id": d.dispatch_id, "status": new_status})
    return _finish(db, inc, out)
