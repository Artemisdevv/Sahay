from datetime import datetime

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.audit_chain import ZERO_HASH, calculate_hash, initialize_audit_chain
from app.database import SessionLocal
from app.main import app
from app.models import AuditChainHead, AuditEntry

client = TestClient(app)


def admin_headers():
    seeded = client.post("/api/v1/dev/seed")
    assert seeded.status_code == 200, seeded.text
    response = client.post("/api/v1/auth/login", json={"username": "admin", "password": "admin123"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def create_audit_event(headers):
    response = client.post(
        "/api/v1/dev/mock-report",
        json={
            "category": "medical",
            "severity": 2,
            "location": {"lat": 9.98, "lng": 76.299},
            "text": "A redacted test report",
            "captured_at": "2026-10-09T10:15:00Z",
        },
    )
    assert response.status_code == 201, response.text
    return client.get("/api/v1/audit", headers=headers).json()["entries"]


def test_admin_can_list_and_verify_chained_audit_entries():
    headers = admin_headers()
    entries = create_audit_event(headers)

    assert len(entries) >= 2  # successful login and report receipt
    previous_hash = ZERO_HASH
    for entry in entries:
        assert entry["prev_hash"] == previous_hash
        expected_hash = calculate_hash(
            entry["seq"],
            datetime.fromisoformat(entry["ts"].replace("Z", "+00:00")),
            entry["actor"],
            entry["action"],
            entry["target"],
            entry["details"],
            previous_hash,
        )
        assert entry["hash"] == expected_hash
        previous_hash = entry["hash"]

    verification = client.get("/api/v1/audit/verify", headers=headers)
    assert verification.status_code == 200
    assert verification.json() == {"valid": True, "checked": len(entries), "first_bad_seq": None}


def test_audit_listing_is_admin_only_and_supports_after_seq():
    admin = admin_headers()
    entries = create_audit_event(admin)

    service_login = client.post("/api/v1/auth/login", json={"username": "amb-01", "password": "demo123"})
    service = {"Authorization": f"Bearer {service_login.json()['token']}"}
    assert client.get("/api/v1/audit", headers=service).status_code == 403

    page = client.get("/api/v1/audit?limit=1", headers=admin).json()["entries"]
    assert len(page) == 1
    next_page = client.get(f"/api/v1/audit?limit=1&after_seq={page[0]['seq']}", headers=admin).json()["entries"]
    assert next_page and next_page[0]["seq"] > page[0]["seq"]
    assert len(entries) >= 2


def test_verify_reports_first_tampered_entry():
    headers = admin_headers()
    create_audit_event(headers)
    with SessionLocal() as db:
        first = db.scalar(select(AuditEntry).order_by(AuditEntry.seq))
        first.details = {"tampered": True}
        first_bad_seq = first.seq
        db.commit()

    response = client.get("/api/v1/audit/verify", headers=headers)
    assert response.status_code == 200
    assert response.json()["valid"] is False
    assert response.json()["first_bad_seq"] == first_bad_seq


def test_verify_detects_deletion_of_the_chain_tail():
    headers = admin_headers()
    create_audit_event(headers)
    with SessionLocal() as db:
        last = db.scalar(select(AuditEntry).order_by(AuditEntry.seq.desc()))
        deleted_seq = last.seq
        db.delete(last)
        db.commit()

    response = client.get("/api/v1/audit/verify", headers=headers)
    assert response.json() == {
        "valid": False,
        "checked": 1,
        "first_bad_seq": deleted_seq,
    }


def test_existing_audit_rows_are_backfilled_on_upgrade():
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE audit_entries ("
            "seq INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME, actor JSON, action VARCHAR(80), "
            "target JSON, details JSON)"
        )
        AuditChainHead.__table__.create(connection)
        connection.exec_driver_sql(
            "INSERT INTO audit_entries (ts, actor, action, target, details) VALUES "
            "('2026-10-09 10:00:00.000000', '{\"id\":\"admin\",\"type\":\"admin\"}', "
            "'auth.login', '{\"id\":\"admin\",\"type\":\"user\"}', '{}')"
        )

    initialize_audit_chain(engine)
    with Session(engine) as db:
        entries = db.scalars(select(AuditEntry).order_by(AuditEntry.seq)).all()
        head = db.get(AuditChainHead, 1)
        assert len(entries) == 1
        assert entries[0].prev_hash == ZERO_HASH
        assert entries[0].hash == calculate_hash(
            entries[0].seq,
            entries[0].ts,
            entries[0].actor,
            entries[0].action,
            entries[0].target,
            entries[0].details,
            ZERO_HASH,
        )
        assert head.last_seq == entries[0].seq and head.last_hash == entries[0].hash
    engine.dispose()
