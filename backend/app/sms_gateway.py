"""SMS fallback ingest (B-10, api-contract section 6): POST /api/v1/sms-gateway/inbound.

A phone with no internet and no relay can still send one compact text to the gateway number:
    SAHAY1|<report id 8 hex>|<device id 8 hex>|<lat 5dp>,<lng 5dp>|<category code>|<unix ts>
The gateway (Twilio, an Android SMS-forwarder app, ...) posts it here with a shared secret. The SMS carries no
free text, so it becomes a minimal incident (location + category) that goes through the normal agent pipeline.
The sender's number is the only personal data: it is sealed inside the stored payload like any reporter phone, so it
only appears in the incident after an audited PII reveal.
"""
from __future__ import annotations

import hmac
import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, FastAPI, Header, HTTPException, Response
from nacl.public import SealedBox
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.audit_chain import append_audit_entry
from app.database import SessionLocal
from app.ingest import crypto
from app.keyring import server_box_key, server_signing_key
from app.models import Report
from app.settings import settings

SMS_RE = re.compile(
    r"^SAHAY1\|(?P<rid>[0-9a-f]{8})\|(?P<did>[0-9a-f]{8})\|(?P<lat>-?\d{1,2}\.\d{1,5}),(?P<lng>-?\d{1,3}\.\d{1,5})"
    r"\|(?P<cat>AC|FI|ME|CR|FL|OT|SO)\|(?P<ts>\d{9,11})$"
)
CATEGORY = {"AC": "accident", "FI": "fire", "ME": "medical", "CR": "crime", "FL": "flood", "OT": "other", "SO": "other"}
# Plain description handed to the intake agent. It must read as a civic report, not as noise.
TEXT = {
    "accident": "Accident reported by SMS. A person needs help at the location. No further details.",
    "fire": "Fire reported by SMS. A person needs help at the location. No further details.",
    "medical": "Medical emergency reported by SMS. A person needs help at the location. No further details.",
    "crime": "Crime reported by SMS. A person needs help at the location. No further details.",
    "flood": "Flooding reported by SMS. A person needs help at the location. No further details.",
    "other": "Emergency reported by SMS. A person needs help at the location. No further details.",
}
PHONE_RE = re.compile(r"^\+?[0-9]{6,15}$")
MAX_FUTURE_S = 24 * 3600


class Inbound(BaseModel):
    from_: str = Field(alias="from", max_length=32)
    body: str = Field(max_length=400)
    received_at: str | None = Field(default=None, max_length=40)


def parse(body: str) -> dict | None:
    """Parse one SAHAY1 line. None when it is not a valid message (wrong shape or out-of-range numbers)."""
    m = SMS_RE.match(body.strip())
    if not m:
        return None
    lat, lng = float(m["lat"]), float(m["lng"])
    if not -90 <= lat <= 90 or not -180 <= lng <= 180:
        return None
    return {"rid": m["rid"], "did": m["did"], "lat": lat, "lng": lng, "code": m["cat"], "ts": int(m["ts"])}


def _iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def install(app: FastAPI) -> None:
    router = APIRouter(prefix="/api/v1")

    @router.post("/sms-gateway/inbound", status_code=202)
    def inbound(
        body: Inbound, response: Response, background: BackgroundTasks,
        x_gateway_secret: str | None = Header(default=None),
    ):
        secret = settings.sahay_gateway_secret
        if not secret:
            raise HTTPException(status_code=404, detail="Not found")  # gateway disabled: look like no such route
        if not x_gateway_secret or not hmac.compare_digest(x_gateway_secret.encode(), secret.encode()):
            raise HTTPException(status_code=401, detail="Invalid gateway secret")
        msg = parse(body.body)
        if msg is None:
            raise HTTPException(status_code=422, detail="Not a valid SAHAY1 message")
        if msg["ts"] > datetime.now(timezone.utc).timestamp() + MAX_FUTURE_S:
            raise HTTPException(status_code=422, detail="Timestamp is in the future")

        report_id = f"sms-{msg['rid']}-{msg['did']}"
        category, sos = CATEGORY[msg["code"]], msg["code"] == "SO"
        payload: dict = {
            "schema": 1,
            "kind": "sos" if sos else "report",
            "category": category,
            "language": "en",
            "captured_at": _iso(msg["ts"]),
            "location": {"lat": msg["lat"], "lng": msg["lng"], "accuracy_m": 50},
            "text": ("SOS received by SMS. The sender could not talk or type. A person needs help at the location."
                     if sos else TEXT[category]),
            "source": "sms",
        }
        sender = body.from_.strip().replace(" ", "")
        if PHONE_RE.match(sender):
            payload["reporter"] = {"phone": sender}
        ciphertext = SealedBox(server_box_key().public_key).encrypt(json.dumps(payload).encode("utf-8"))

        with SessionLocal() as db:
            existing = db.get(Report, report_id)
            if existing is not None:  # the gateway retries and phones resend: same SMS, same report
                response.status_code = 200
                return {"report_id": existing.report_id, "status": existing.status, "duplicate": True}
            server_time = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            receipt = crypto.make_receipt(report_id, server_time, server_signing_key())
            report = Report(
                report_id=report_id, device_id=f"sms-{msg['did']}", created_at_signed=_iso(msg["ts"]),
                ciphertext=ciphertext, signature="sms-gateway", kind=payload["kind"], category=category,
                status="received", server_time=server_time, receipt_signature=receipt["signature"],
            )
            db.add(report)
            _audit(db, report_id)
            db.commit()
        if settings.sahay_pipeline_autorun:
            from app.agents.runner import run_report_pipeline  # lazy: runner imports app.main

            background.add_task(run_report_pipeline, report_id)
        return {"report_id": report_id, "status": "received", "duplicate": False}

    app.include_router(router)


def _audit(db: Session, report_id: str) -> None:
    append_audit_entry(
        db, {"type": "system", "id": "sms-gateway"}, "report.received",
        {"type": "report", "id": report_id}, {"via": "sms", "kind": "report"},
    )
