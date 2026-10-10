"""Incident list, detail, trace, and audited PII reveal endpoints (B-08)."""
from __future__ import annotations

import base64
import binascii
import json
from datetime import datetime, timedelta, timezone
from typing import Callable

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.agents.store import list_audio, load_audio, load_pii
from app.dispatch.engine import audit
from app.events import SERVICE_INCIDENT_FIELDS
from app.models import AgentTrace, AuditEntry, Dispatch, Incident, IncidentPII


# A service unit only sees an incident once an admin has approved its dispatch and only while that
# dispatch is live or finished. Proposed, declined and cancelled dispatches stay invisible to it.
REVEAL_WINDOW_MIN = 30
SERVICE_VISIBLE_DISPATCH_STATUSES = ("approved", "accepted", "en_route", "on_scene", "completed")


def _for_role(incident: dict, role: str) -> dict:
    """Services get the same redacted subset as the WebSocket incident.updated event."""
    if role == "service":
        return {key: value for key, value in incident.items() if key in SERVICE_INCIDENT_FIELDS}
    return incident


class RevealRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=250)

    @field_validator("reason")
    @classmethod
    def reason_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("reason is required")
        return value


def _cursor_encode(incident: Incident, iso: Callable[[datetime], str]) -> str:
    raw = json.dumps(
        {"created_at": iso(incident.created_at), "incident_id": incident.incident_id},
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _cursor_decode(cursor: str) -> tuple[datetime, str]:
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.b64decode(cursor + padding, altchars=b"-_", validate=True))
        timestamp = payload["created_at"]
        if not isinstance(timestamp, str):
            raise ValueError
        created_at = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        incident_id = payload["incident_id"]
        if created_at.tzinfo is None or not isinstance(incident_id, str) or not incident_id:
            raise ValueError
        return created_at, incident_id
    except (binascii.Error, ValueError, TypeError, KeyError, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="Invalid cursor") from None


def _dispatch_json(dispatch: Dispatch, iso: Callable[[datetime], str]) -> dict:
    return {
        "dispatch_id": dispatch.dispatch_id,
        "incident_id": dispatch.incident_id,
        "unit_id": dispatch.unit_id,
        "service_type": dispatch.service_type,
        "status": dispatch.status,
        "distance_km": dispatch.distance_km,
        "eta_minutes": dispatch.eta_minutes,
        "proposed_by": dispatch.proposed_by,
        "created_at": iso(dispatch.created_at),
        "updated_at": iso(dispatch.updated_at),
    }


def _calls_json(dispatch: Dispatch, iso: Callable[[datetime], str]) -> dict:
    return {
        "dispatch_id": dispatch.dispatch_id,
        "service_type": dispatch.service_type,
        "status": dispatch.status,
        "distance_km": dispatch.distance_km,
        "eta_minutes": dispatch.eta_minutes,
        "created_at": iso(dispatch.created_at),
        "updated_at": iso(dispatch.updated_at),
    }


def install(
    app: FastAPI,
    current_user: Callable,
    require_admin: Callable,
    incident_json: Callable,
    trace_json: Callable,
    utc_iso: Callable,
) -> None:
    router = APIRouter(prefix="/api/v1")

    def incident_reader(user: dict = Depends(current_user)) -> dict:
        if user.get("role") not in {"admin", "service"}:
            raise HTTPException(status_code=403, detail="Forbidden")
        if user.get("role") == "service" and not user.get("unit_id"):
            raise HTTPException(status_code=403, detail="Forbidden")
        return user

    def visible_incident_query(user: dict):
        query = select(Incident)
        if user["role"] == "service":
            visible_ids = select(Dispatch.incident_id).where(
                Dispatch.unit_id == user["unit_id"],
                Dispatch.status.in_(SERVICE_VISIBLE_DISPATCH_STATUSES),
            )
            query = query.where(Incident.incident_id.in_(visible_ids))
        return query

    def require_visible(incident_id: str, user: dict, db: Session) -> Incident:
        incident = db.scalar(visible_incident_query(user).where(Incident.incident_id == incident_id))
        if incident is None:
            raise HTTPException(status_code=404, detail="Not found")
        return incident

    @router.get("/incidents")
    def list_incidents(
        status: str | None = Query(default=None, min_length=1, max_length=32),
        incident_type: str | None = Query(default=None, alias="type", min_length=1, max_length=24),
        limit: int = Query(default=50, ge=1, le=100),
        cursor: str | None = Query(default=None, max_length=512),
        user: dict = Depends(incident_reader),
        db: Session = Depends(get_db),
    ):
        query = visible_incident_query(user)
        if status is not None:
            query = query.where(Incident.status == status)
        if incident_type is not None:
            query = query.where(Incident.incident_type == incident_type)
        if cursor:
            created_at, incident_id = _cursor_decode(cursor)
            query = query.where(
                or_(
                    Incident.created_at < created_at,
                    and_(Incident.created_at == created_at, Incident.incident_id < incident_id),
                )
            )
        rows = db.scalars(
            query.order_by(Incident.created_at.desc(), Incident.incident_id.desc()).limit(limit + 1)
        ).all()
        has_more = len(rows) > limit
        rows = rows[:limit]
        next_cursor = _cursor_encode(rows[-1], utc_iso) if has_more and rows else None
        return {"incidents": [_for_role(incident_json(row), user["role"]) for row in rows], "next_cursor": next_cursor}

    @router.get("/incidents/{incident_id}")
    def get_incident(
        incident_id: str,
        user: dict = Depends(incident_reader),
        db: Session = Depends(get_db),
    ):
        incident = require_visible(incident_id, user, db)
        dispatch_query = select(Dispatch).where(Dispatch.incident_id == incident_id)
        if user["role"] == "service":
            dispatch_query = dispatch_query.where(
                Dispatch.unit_id == user["unit_id"],
                Dispatch.status.in_(SERVICE_VISIBLE_DISPATCH_STATUSES),
            )
        dispatches = db.scalars(dispatch_query.order_by(Dispatch.created_at, Dispatch.dispatch_id)).all()
        result = _for_role(incident_json(incident), user["role"])
        result["dispatches"] = [_dispatch_json(dispatch, utc_iso) for dispatch in dispatches]
        return result

    @router.get("/incidents/{incident_id}/calls")
    def get_incident_calls(
        incident_id: str,
        user: dict = Depends(incident_reader),
        db: Session = Depends(get_db),
    ):
        incident = require_visible(incident_id, user, db)
        dispatch_query = select(Dispatch).where(Dispatch.incident_id == incident_id)
        if user["role"] == "service":
            dispatch_query = dispatch_query.where(
                Dispatch.unit_id == user["unit_id"],
                Dispatch.status.in_(SERVICE_VISIBLE_DISPATCH_STATUSES),
            )
        dispatches = db.scalars(dispatch_query.order_by(Dispatch.created_at, Dispatch.dispatch_id)).all()
        from app.live import called_payload  # late import: live imports the dispatch package

        types = dict.fromkeys(dispatch.service_type for dispatch in dispatches)
        lists = [payload for payload in (called_payload(db, incident_id, t) for t in types) if payload is not None]
        # `calls` = raw dispatch rows; `lists` = the same ranked candidate lists that `dispatch.called` pushes (contract 9.2)
        return {"incident_id": incident_id, "calls": [_calls_json(dispatch, utc_iso) for dispatch in dispatches], "lists": lists}

    @router.get("/incidents/{incident_id}/trace")
    def get_incident_trace(
        incident_id: str,
        _: dict = Depends(require_admin),
        db: Session = Depends(get_db),
    ):
        if db.get(Incident, incident_id) is None:
            raise HTTPException(status_code=404, detail="Not found")
        traces = db.scalars(
            select(AgentTrace)
            .where(AgentTrace.incident_id == incident_id)
            .order_by(AgentTrace.started_at, AgentTrace.trace_id)
        ).all()
        return {"incident_id": incident_id, "trace": [trace_json(trace) for trace in traces]}

    @router.post("/incidents/{incident_id}/reveal")
    def reveal_incident_pii(
        incident_id: str,
        body: RevealRequest,
        user: dict = Depends(require_admin),
        db: Session = Depends(get_db),
    ):
        if db.get(Incident, incident_id) is None:
            raise HTTPException(status_code=404, detail="Not found")
        pii_record_count = db.scalar(
            select(func.count()).select_from(IncidentPII).where(IncidentPII.incident_id == incident_id)
        )
        audit(
            db,
            {"type": "admin", "id": user["sub"]},
            "pii.reveal",
            {"type": "incident", "id": incident_id},
            {"reason": body.reason, "pii_record_count": pii_record_count},
        )
        # Commit the audit record before decrypting or returning any PII. A failed
        # audit write must never allow a reveal to succeed without an audit trail.
        db.commit()
        pii = load_pii(db, incident_id)
        if pii is None:
            pii = {"transcript": None, "reporters": [], "pii_spans": [], "audio_url": None}
        reporters = [
            {
                **reporter,
                "emergency_contact": pii["emergency_contact"],
            }
            for reporter in pii["reporters"]
            if reporter["name"] is not None or reporter["phone"] is not None
            or pii["emergency_contact"] is not None
        ]
        audio = [
            {"report_id": rid, "mime": mime, "url": f"/api/v1/incidents/{incident_id}/audio/{rid}"}
            for rid, mime in list_audio(db, incident_id)
        ]
        return {
            "incident_id": incident_id,
            "transcript": pii["transcript"],
            "reporters": reporters,
            "pii_spans": pii["pii_spans"],
            "audio_url": audio[0]["url"] if audio else pii["audio_url"],
            "audio": audio,
        }

    @router.get("/incidents/{incident_id}/audio/{report_id}")
    def play_audio(incident_id: str, report_id: str, user: dict = Depends(require_admin), db: Session = Depends(get_db)):
        """The original voice message. Needs a logged reveal of this incident by the same admin in the last 30 minutes,
        and every play is audited. Never cached."""
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=REVEAL_WINDOW_MIN)
        reveals = db.scalars(
            select(AuditEntry).where(AuditEntry.action == "pii.reveal").order_by(AuditEntry.seq.desc()).limit(200)
        ).all()
        revealed = any(
            (r.target or {}).get("id") == incident_id and (r.actor or {}).get("id") == user["sub"]
            and (r.ts if r.ts.tzinfo else r.ts.replace(tzinfo=timezone.utc)) >= cutoff
            for r in reveals
        )
        if not revealed:
            raise HTTPException(status_code=403, detail="Reveal this incident with a reason before playing its audio")
        found = load_audio(db, incident_id, report_id)
        if found is None:
            raise HTTPException(status_code=404, detail="No audio for this report")
        audit(db, {"type": "admin", "id": user["sub"]}, "pii.audio.play",
              {"type": "incident", "id": incident_id}, {"report_id": report_id})
        db.commit()
        mime, data = found
        return Response(
            content=data,
            media_type=mime,
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": "attachment",
                "Content-Security-Policy": "sandbox; default-src 'none'",
            },
        )

    app.include_router(router)
