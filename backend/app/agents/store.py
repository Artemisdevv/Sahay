"""Field-encrypted PII storage shared by the agent pipeline and audited reveal API."""
from __future__ import annotations

from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import IncidentPII
from app.pii_crypto import decrypt_field, encrypt_field


def _context(incident_id: str, report_id: str, field: str) -> str:
    return f"{incident_id}:{report_id}:{field}"


def store_pii(db: Session, incident_id: str, data: dict) -> None:
    """Encrypt every sensitive property independently before writing it to the database."""
    reporters = data.get("reporters") or []
    if not reporters:
        reporters = [{"report_id": data.get("report_id") or str(uuid4()), "language": data.get("language", "en")}]
    contact = data.get("emergency_contact") or {}
    shared_values = {
        "transcript": data.get("transcript"),
        "emergency_contact_name": contact.get("name"),
        "emergency_contact_phone": contact.get("phone"),
        "pii_spans": data.get("pii_spans", []),
        "audio_url": data.get("audio_url"),
    }

    for reporter in reporters:
        report_id = reporter.get("report_id") or str(uuid4())
        row = db.scalar(
            select(IncidentPII).where(
                IncidentPII.incident_id == incident_id,
                IncidentPII.report_id == report_id,
            )
        )
        if row is None:
            row = IncidentPII(incident_id=incident_id, report_id=report_id)
            db.add(row)
        row.language = reporter.get("language") or data.get("language", "en")
        values = {
            **shared_values,
            "reporter_name": reporter.get("name"),
            "reporter_phone": reporter.get("phone"),
        }
        for field, value in values.items():
            setattr(row, f"{field}_ciphertext", encrypt_field(value, _context(incident_id, report_id, field)))


def load_pii(db: Session, incident_id: str) -> dict | None:
    """Return decrypted PII for trusted server-side callers; HTTP access uses the audited reveal route."""
    rows = db.scalars(
        select(IncidentPII).where(IncidentPII.incident_id == incident_id).order_by(IncidentPII.report_id)
    ).all()
    if not rows:
        return None

    def value(row: IncidentPII, field: str):
        return decrypt_field(getattr(row, f"{field}_ciphertext"), _context(row.incident_id, row.report_id, field))

    first = rows[0]
    reporters = [
        {
            "report_id": row.report_id,
            "name": value(row, "reporter_name"),
            "phone": value(row, "reporter_phone"),
            "language": row.language,
        }
        for row in rows
    ]
    contact = {
        "name": value(first, "emergency_contact_name"),
        "phone": value(first, "emergency_contact_phone"),
    }
    if contact["name"] is None and contact["phone"] is None:
        contact = None
    return {
        "transcript": value(first, "transcript"),
        "language": first.language,
        "reporters": reporters,
        "emergency_contact": contact,
        "pii_spans": value(first, "pii_spans") or [],
        "audio_url": value(first, "audio_url"),
    }
