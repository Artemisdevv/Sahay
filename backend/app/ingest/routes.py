"""Report ingest endpoints (B-03): POST /reports, GET /reports/mine, GET /reports/{id}/status.

Built as a factory so it can take main.py's `current_user` dependency without a circular import.
Receipts are signed with app.keyring.server_signing_key(), matching /config/server-key ed25519_public_key.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from functools import lru_cache
from typing import Callable

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.ingest import crypto
from app.keyring import server_box_key, server_signing_key
from app.models import AuditEntry, Device, Report

MAX_BODY_BYTES = 600 * 1024
STATUS_MESSAGES = {
    "received": "Report received",
    "processing": "Report is being reviewed",
    "triaged": "Report triaged",
    "pending_approval": "Waiting for dispatcher approval",
    "dispatched": "Help dispatched",
    "en_route": "Help is on the way",
    "on_scene": "Help has arrived",
    "resolved": "Resolved",
    "rejected": "Report could not be acted on",
}


@lru_cache(maxsize=1)
def _box_key():
    return server_box_key()


@lru_cache(maxsize=1)
def _sign_key():
    return server_signing_key()


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _receipt(report: Report) -> dict:
    return {"server_time": report.server_time, "signature": report.receipt_signature}


def _same_submission(report: Report, env: dict, ciphertext: bytes) -> bool:
    return (
        report.device_id == env["device_id"]
        and report.created_at_signed == env["created_at"]
        and report.ciphertext == ciphertext
    )


def install(app: FastAPI, current_user: Callable) -> None:
    """Attach the ingest error handler and routes to the app."""

    @app.exception_handler(crypto.IngestError)
    async def _ingest_error(_: Request, exc: crypto.IngestError):
        return JSONResponse(status_code=exc.status, content={"error": {"code": exc.code, "message": exc.message}})

    router = APIRouter(prefix="/api/v1")

    def civilian(user: dict = Depends(current_user)) -> dict:
        if user.get("role") != "civilian":
            raise HTTPException(status_code=403, detail="Forbidden")
        return user

    @router.post("/reports", status_code=202)
    async def post_report(request: Request, response: Response, user: dict = Depends(civilian), db: Session = Depends(get_db)):
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            raise crypto.IngestError(413, "too_large", "request body too large")
        raw = await request.body()
        if len(raw) > MAX_BODY_BYTES:
            raise crypto.IngestError(413, "too_large", "request body too large")
        try:
            env = json.loads(raw)
        except ValueError:
            raise crypto.IngestError(400, "bad_request", "body is not valid JSON") from None

        ciphertext, _sig = crypto.check_envelope_shape(env)

        existing = db.get(Report, env["report_id"])
        if existing is not None:
            return _replay(existing, env, ciphertext, response)

        device = db.get(Device, env["device_id"])
        if device is None or device.disabled:
            raise crypto.IngestError(422, "invalid_signature", "unknown or disabled device")
        opened = crypto.open_envelope(env, device.ed25519_public_key, _box_key())

        server_time = _now_iso()
        receipt = crypto.make_receipt(env["report_id"], server_time, _sign_key())
        report = Report(
            report_id=env["report_id"],
            device_id=env["device_id"],
            created_at_signed=env["created_at"],
            ciphertext=ciphertext,
            signature=env["signature"],
            kind=opened.payload["kind"],
            category=opened.payload["category"],
            status="received",
            server_time=receipt["server_time"],
            receipt_signature=receipt["signature"],
        )
        db.add(report)
        db.add(
            AuditEntry(
                actor={"type": "device", "id": env["device_id"]},
                action="report.received",
                target={"type": "report", "id": env["report_id"]},
                details={"relayed_by": user.get("device_id") if user.get("device_id") != env["device_id"] else None, "kind": report.kind},
            )
        )
        try:
            db.commit()
        except IntegrityError:
            # Lost a race with a concurrent upload of the same report_id: treat as replay.
            db.rollback()
            winner = db.get(Report, env["report_id"])
            if winner is None:
                raise
            return _replay(winner, env, ciphertext, response)
        return {"report_id": report.report_id, "status": report.status, "receipt": _receipt(report)}

    def _replay(existing: Report, env: dict, ciphertext: bytes, response: Response) -> dict:
        if not _same_submission(existing, env, ciphertext):
            raise HTTPException(status_code=409, detail="report_id already used with different content")
        response.status_code = 200
        return {"report_id": existing.report_id, "status": existing.status, "receipt": _receipt(existing)}

    @router.get("/reports/mine")
    def reports_mine(user: dict = Depends(civilian), db: Session = Depends(get_db)):
        rows = db.scalars(
            select(Report).where(Report.device_id == user["device_id"]).order_by(Report.received_at.desc())
        ).all()
        return {
            "reports": [
                {"report_id": r.report_id, "status": r.status, "eta_minutes": _eta(db, r), "updated_at": _iso(r.updated_at)}
                for r in rows
            ]
        }

    @router.get("/reports/{report_id}/status")
    def report_status(report_id: str, user: dict = Depends(civilian), db: Session = Depends(get_db)):
        report = db.get(Report, report_id)
        if report is None or report.device_id != user["device_id"]:
            raise HTTPException(status_code=404, detail="Not found")
        eta = _eta(db, report)
        message = STATUS_MESSAGES.get(report.status, report.status)
        if report.status == "dispatched" and eta is not None:
            message = f"Help dispatched, ETA {eta} min"
        return {
            "report_id": report.report_id,
            "status": report.status,
            "eta_minutes": eta,
            "message": message,
            "updated_at": _iso(report.updated_at),
        }

    app.include_router(router)


def _eta(db: Session, report: Report) -> int | None:
    """Fastest approved/active dispatch ETA for the report's incident, if any."""
    if not report.incident_id:
        return None
    from app.models import Dispatch

    etas = db.scalars(
        select(Dispatch.eta_minutes).where(
            Dispatch.incident_id == report.incident_id,
            Dispatch.status.in_(["approved", "accepted", "en_route"]),
        )
    ).all()
    return min(etas) if etas else None
