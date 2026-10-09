"""Sealed PII storage. Transcript, reporter identity and PII spans are sealed (libsodium sealed box) to the
server public key, so a database dump alone reveals nothing. Reads happen only via the audited reveal."""
from __future__ import annotations

import json

from nacl.public import SealedBox
from sqlalchemy.orm import Session

from app.keyring import server_box_key
from app.models import IncidentPrivate


def store_pii(db: Session, incident_id: str, data: dict) -> None:
    sealed = SealedBox(server_box_key().public_key).encrypt(json.dumps(data, ensure_ascii=False).encode("utf-8"))
    row = db.get(IncidentPrivate, incident_id)
    if row is None:
        db.add(IncidentPrivate(incident_id=incident_id, sealed=sealed))
    else:
        row.sealed = sealed


def load_pii(db: Session, incident_id: str) -> dict | None:
    row = db.get(IncidentPrivate, incident_id)
    if row is None:
        return None
    return json.loads(SealedBox(server_box_key()).decrypt(row.sealed).decode("utf-8"))
