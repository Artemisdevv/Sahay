"""Dispatch endpoints (B-04): admin approve/reject/reassign, service accept/decline/status.

Thin layer: authorise, call the deterministic engine, then broadcast what changed.
"""
from __future__ import annotations

from datetime import timezone
from typing import Callable, Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.dispatch import engine
from app.events import manager
from app.models import Dispatch, Unit

from app.ingest.routes import STATUS_MESSAGES


class RejectBody(BaseModel):
    reason: str = Field(min_length=1, max_length=250)


class ReassignBody(BaseModel):
    needed_service: Literal["ambulance", "police", "fire", "municipal"]
    unit_id: str


class DeclineBody(BaseModel):
    reason: str = Field(default="", max_length=250)


class StatusBody(BaseModel):
    status: Literal["en_route", "on_scene", "completed"]


def _iso(dt) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def dispatch_json(d: Dispatch) -> dict:
    return {
        "dispatch_id": d.dispatch_id,
        "incident_id": d.incident_id,
        "unit_id": d.unit_id,
        "service_type": d.service_type,
        "status": d.status,
        "distance_km": d.distance_km,
        "eta_minutes": d.eta_minutes,
        "proposed_by": d.proposed_by,
        "created_at": _iso(d.created_at),
        "updated_at": _iso(d.updated_at),
    }


async def broadcast(db: Session, out: engine.Outcome, incident_json: Callable) -> None:
    """Push what an engine Outcome changed to admins, the affected unit(s) and the reporting civilian(s)."""
    for d in out.dispatches:
        await manager.publish("dispatch.updated", dispatch_json(d))
    if out.dispatches:
        from app.live import publish_called  # late import: live.py imports this module

        await publish_called(db, out.dispatches)
    if out.incident is not None:
        unit_ids = {
            u for (u,) in db.execute(
                select(Dispatch.unit_id).where(
                    Dispatch.incident_id == out.incident.incident_id, Dispatch.status.in_(engine.OCCUPYING)
                )
            )
        }
        await manager.publish("incident.updated", incident_json(out.incident), service_unit_ids=unit_ids)
    for r in out.reports:
        eta = None
        etas = [d.eta_minutes for d in out.dispatches if d.status in ("approved", "accepted", "en_route")]
        if etas:
            eta = min(etas)
        msg = STATUS_MESSAGES.get(r.status, r.status)
        if r.status == "dispatched" and eta is not None:
            msg = f"Help dispatched, ETA {eta} min"
        await manager.publish(
            "report.status",
            {"report_id": r.report_id, "status": r.status, "eta_minutes": eta, "message": msg},
            civilian_device_id=r.device_id,
        )


def install(app: FastAPI, current_user: Callable, require_admin: Callable, incident_json: Callable) -> None:
    @app.exception_handler(engine.DispatchError)
    async def _dispatch_error(_: Request, exc: engine.DispatchError):
        codes = {400: "bad_request", 404: "not_found", 409: "conflict"}
        return JSONResponse(
            status_code=exc.status,
            content={"error": {"code": codes.get(exc.status, "bad_request"), "message": exc.message}},
        )

    router = APIRouter(prefix="/api/v1")

    def service(user: dict = Depends(current_user)) -> dict:
        if user.get("role") != "service" or not user.get("unit_id"):
            raise HTTPException(status_code=403, detail="Forbidden")
        return user

    def admin_actor(user: dict) -> dict:
        return {"type": "admin", "id": user["sub"]}

    def service_actor(user: dict) -> dict:
        return {"type": "service", "id": user["unit_id"]}

    def result(out: engine.Outcome) -> dict:
        return {
            "incident": incident_json(out.incident),
            "dispatches": [dispatch_json(d) for d in out.dispatches],
            "unfilled_services": out.unfilled,
        }

    # ---- admin -------------------------------------------------------------

    @router.post("/incidents/{incident_id}/approve")
    async def approve(incident_id: str, user: dict = Depends(require_admin), db: Session = Depends(get_db)):
        out = engine.approve_incident(db, incident_id, admin_actor(user))
        await broadcast(db, out, incident_json)
        return result(out)

    @router.post("/incidents/{incident_id}/reject")
    async def reject(incident_id: str, body: RejectBody, user: dict = Depends(require_admin), db: Session = Depends(get_db)):
        out = engine.reject_incident(db, incident_id, admin_actor(user), body.reason)
        await broadcast(db, out, incident_json)
        return result(out)

    @router.post("/incidents/{incident_id}/reassign")
    async def reassign(incident_id: str, body: ReassignBody, user: dict = Depends(require_admin), db: Session = Depends(get_db)):
        out = engine.reassign(db, incident_id, admin_actor(user), body.needed_service, body.unit_id)
        await broadcast(db, out, incident_json)
        return result(out)

    # ---- service -----------------------------------------------------------

    @router.get("/dispatches/mine")
    def mine(user: dict = Depends(service), db: Session = Depends(get_db)):
        rows = db.scalars(
            select(Dispatch)
            .where(Dispatch.unit_id == user["unit_id"], Dispatch.status.in_(["approved", "accepted", "en_route", "on_scene"]))
            .order_by(Dispatch.created_at)
        ).all()
        return {"dispatches": [dispatch_json(d) for d in rows]}

    @router.post("/dispatches/{dispatch_id}/accept")
    async def accept(dispatch_id: str, user: dict = Depends(service), db: Session = Depends(get_db)):
        out = engine.accept(db, dispatch_id, user["unit_id"], service_actor(user))
        await broadcast(db, out, incident_json)
        return dispatch_json(out.dispatches[0])

    @router.post("/dispatches/{dispatch_id}/decline")
    async def decline(dispatch_id: str, body: DeclineBody, user: dict = Depends(service), db: Session = Depends(get_db)):
        out = engine.decline(db, dispatch_id, user["unit_id"], service_actor(user), body.reason)
        await broadcast(db, out, incident_json)
        return {"declined": dispatch_json(out.dispatches[0]),
                "replacement": dispatch_json(out.dispatches[1]) if len(out.dispatches) > 1 else None}

    @router.post("/dispatches/{dispatch_id}/status")
    async def progress(dispatch_id: str, body: StatusBody, user: dict = Depends(service), db: Session = Depends(get_db)):
        out = engine.set_progress(db, dispatch_id, user["unit_id"], service_actor(user), body.status)
        await broadcast(db, out, incident_json)
        return dispatch_json(out.dispatches[0])

    app.include_router(router)
