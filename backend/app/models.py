from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, Float, Integer, JSON, LargeBinary, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class Unit(Base):
    __tablename__ = "units"
    unit_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    service_type: Mapped[str] = mapped_column(String(24), index=True)
    name: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(24), default="available", index=True)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class DemoUser(Base):
    __tablename__ = "demo_users"
    username: Mapped[str] = mapped_column(String(40), primary_key=True)
    password_hash: Mapped[str] = mapped_column("password", String(120))
    role: Mapped[str] = mapped_column(String(16))
    display_name: Mapped[str] = mapped_column(String(80))
    unit_id: Mapped[str | None] = mapped_column(String(36), nullable=True)


class Device(Base):
    __tablename__ = "devices"
    device_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    ed25519_public_key: Mapped[str] = mapped_column(String(128))
    language: Mapped[str] = mapped_column(String(12), default="en")
    registered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)


class Incident(Base):
    __tablename__ = "incidents"
    incident_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    status: Mapped[str] = mapped_column(String(32), default="pending_approval", index=True)
    incident_type: Mapped[str] = mapped_column(String(24))
    severity: Mapped[int] = mapped_column(Integer)
    urgency_score: Mapped[float] = mapped_column(Float)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    summary_redacted: Mapped[str] = mapped_column(String(500))
    people_count: Mapped[int] = mapped_column(Integer, default=0)
    hazards: Mapped[list] = mapped_column(JSON, default=list)
    needed_services: Mapped[list] = mapped_column(JSON, default=list)
    report_count: Mapped[int] = mapped_column(Integer, default=1)
    report_ids: Mapped[list] = mapped_column(JSON, default=list)
    reason: Mapped[str] = mapped_column(String(250), default="Development mock pipeline")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class Dispatch(Base):
    __tablename__ = "dispatches"
    dispatch_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    incident_id: Mapped[str] = mapped_column(String(36), index=True)
    unit_id: Mapped[str] = mapped_column(String(36), index=True)
    service_type: Mapped[str] = mapped_column(String(24))
    status: Mapped[str] = mapped_column(String(24), default="proposed")
    distance_km: Mapped[float] = mapped_column(Float)
    eta_minutes: Mapped[int] = mapped_column(Integer)
    proposed_by: Mapped[str] = mapped_column(String(40), default="dev_mock")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class AuditEntry(Base):
    __tablename__ = "audit_entries"
    seq: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    actor: Mapped[dict] = mapped_column(JSON)
    action: Mapped[str] = mapped_column(String(80))
    target: Mapped[dict] = mapped_column(JSON)
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    prev_hash: Mapped[str] = mapped_column(String(64), default="0" * 64)
    hash: Mapped[str] = mapped_column(String(64), default="0" * 64)


class AgentTrace(Base):
    __tablename__ = "agent_traces"
    trace_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    incident_id: Mapped[str] = mapped_column(String(36), index=True)
    step: Mapped[str] = mapped_column(String(24))
    agent: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(16), default="done")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    finished_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    summary: Mapped[str] = mapped_column(String(250))
    output: Mapped[dict] = mapped_column(JSON, default=dict)


class IncidentPII(Base):
    """Per-field authenticated ciphertext for sensitive incident details."""

    __tablename__ = "incident_pii"
    __table_args__ = (UniqueConstraint("incident_id", "report_id", name="uq_incident_pii_report"),)
    pii_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    incident_id: Mapped[str] = mapped_column(String(36), index=True)
    report_id: Mapped[str] = mapped_column(String(64), index=True)
    language: Mapped[str] = mapped_column(String(12), default="en")
    transcript_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    reporter_name_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    reporter_phone_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    emergency_contact_name_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    emergency_contact_phone_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    pii_spans_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    audio_url_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)


class Report(Base):
    """Opaque stored envelope (B-03). Plaintext/PII is never stored here; the pipeline decrypts on demand."""

    __tablename__ = "reports"
    report_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    created_at_signed: Mapped[str] = mapped_column(String(40))  # exact string covered by the signature
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary)
    signature: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(8))
    category: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(24), default="received", index=True)
    incident_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    server_time: Mapped[str] = mapped_column(String(40))
    receipt_signature: Mapped[str] = mapped_column(String(128))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


