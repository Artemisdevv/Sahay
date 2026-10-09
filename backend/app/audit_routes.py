"""Admin-only audit listing and hash-chain verification endpoints."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable

from fastapi import APIRouter, Depends, FastAPI, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit_chain import verify_audit_chain
from app.database import get_db
from app.models import AuditEntry


def _iso(value: datetime, utc_iso: Callable[[datetime], str]) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return utc_iso(value)


def _entry_json(entry: AuditEntry, utc_iso: Callable[[datetime], str]) -> dict:
    return {
        "seq": entry.seq,
        "ts": _iso(entry.ts, utc_iso),
        "actor": entry.actor,
        "action": entry.action,
        "target": entry.target,
        "details": entry.details or {},
        "prev_hash": entry.prev_hash,
        "hash": entry.hash,
    }


def install(app: FastAPI, require_admin: Callable, utc_iso: Callable[[datetime], str]) -> None:
    router = APIRouter(prefix="/api/v1/audit")

    @router.get("")
    def list_audit_entries(
        limit: int = Query(default=50, ge=1, le=100),
        after_seq: int = Query(default=0, ge=0),
        _: dict = Depends(require_admin),
        db: Session = Depends(get_db),
    ):
        rows = db.scalars(
            select(AuditEntry)
            .where(AuditEntry.seq > after_seq)
            .order_by(AuditEntry.seq)
            .limit(limit)
        ).all()
        return {"entries": [_entry_json(row, utc_iso) for row in rows]}

    @router.get("/verify")
    def verify_audit_entries(
        _: dict = Depends(require_admin),
        db: Session = Depends(get_db),
    ):
        return verify_audit_chain(db)

    app.include_router(router)
