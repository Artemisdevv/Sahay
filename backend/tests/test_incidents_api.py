from sqlalchemy import select
from fastapi.testclient import TestClient
import base64
import json

from app.database import SessionLocal
from app.main import app, decode_access_token
from app.models import AuditEntry, IncidentPII
from app.pii_crypto import decrypt_field, encrypt_field

client = TestClient(app)


def login(username, password="demo123"):
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def setup():
    response = client.post("/api/v1/dev/seed")
    assert response.status_code == 200, response.text
    return login("admin", "admin123")


def mock_incident():
    response = client.post(
        "/api/v1/dev/mock-report",
        json={
            "category": "medical",
            "severity": 4,
            "location": {"lat": 9.98, "lng": 76.299},
            "text": "help",
            "captured_at": "2026-10-09T10:15:00Z",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["incident"]["incident_id"]


def create_incident(category="medical", needed_services=None, text="Caller at the scene"):
    payload = {
        "category": category,
        "severity": 4,
        "location": {"lat": 9.98, "lng": 76.299},
        "text": text,
        "captured_at": "2026-10-09T10:15:00Z",
        "reporter": {"name": "Asha Nair", "phone": "+919800000000"},
        "emergency_contact": {"name": "Maya Nair", "phone": "+919800000001"},
        "language": "ml",
    }
    if needed_services is not None:
        payload["needed_services"] = needed_services
    response = client.post("/api/v1/dev/mock-report", json=payload)
    assert response.status_code == 201, response.text
    return response.json()["incident"]["incident_id"]


def test_incident_list_filters_and_keyset_cursor():
    admin = setup()
    first = create_incident("medical")
    create_incident("fire", ["fire"])

    page_one = client.get("/api/v1/incidents?type=medical&limit=1", headers=admin)
    assert page_one.status_code == 200
    assert [i["incident_id"] for i in page_one.json()["incidents"]] == [first]
    assert page_one.json()["next_cursor"] is None

    all_first_page = client.get("/api/v1/incidents?limit=1", headers=admin).json()
    assert len(all_first_page["incidents"]) == 1
    assert all_first_page["next_cursor"]
    second_page = client.get(
        "/api/v1/incidents?limit=1", params={"cursor": all_first_page["next_cursor"]}, headers=admin
    ).json()
    assert len(second_page["incidents"]) == 1
    assert second_page["incidents"][0]["incident_id"] != all_first_page["incidents"][0]["incident_id"]
    assert client.get("/api/v1/incidents?cursor=not-a-cursor", headers=admin).status_code == 400
    malformed_cursor = base64.urlsafe_b64encode(
        json.dumps({"created_at": 42, "incident_id": "not-a-date"}).encode()
    ).decode().rstrip("=")
    assert client.get("/api/v1/incidents", params={"cursor": malformed_cursor}, headers=admin).status_code == 400


def test_detail_is_redacted_and_service_scope_is_limited_to_own_dispatch():
    admin = setup()
    medical_id = create_incident("medical", ["ambulance", "police"])
    fire_id = create_incident("fire", ["fire"])

    detail = client.get(f"/api/v1/incidents/{medical_id}", headers=admin)
    assert detail.status_code == 200
    assert detail.json()["incident_id"] == medical_id
    assert detail.json()["dispatches"]
    serialized = detail.text
    assert "Asha Nair" not in serialized and "+919800000000" not in serialized
    assert "Caller at the scene" not in serialized

    ambulance = login("amb-01")
    service_detail = client.get(f"/api/v1/incidents/{medical_id}", headers=ambulance)
    assert service_detail.status_code == 200
    own_unit_id = decode_access_token(ambulance["Authorization"].split()[1])["unit_id"]
    assert {dispatch["unit_id"] for dispatch in service_detail.json()["dispatches"]} == {own_unit_id}
    assert client.get(f"/api/v1/incidents/{fire_id}", headers=ambulance).status_code == 404
    service_list = client.get("/api/v1/incidents", headers=ambulance).json()["incidents"]
    assert {incident["incident_id"] for incident in service_list} == {medical_id}


def test_trace_is_admin_only():
    admin = setup()
    incident_id = mock_incident()
    trace = client.get(f"/api/v1/incidents/{incident_id}/trace", headers=admin)
    assert trace.status_code == 200
    assert len(trace.json()["trace"]) == 5
    assert client.get(f"/api/v1/incidents/{incident_id}/trace", headers=login("amb-01")).status_code == 403


def test_pii_is_encrypted_at_rest_and_reveal_requires_reason_and_audits():
    admin = setup()
    incident_id = create_incident(text="My name is Asha and my number is +919800000000")
    with SessionLocal() as db:
        row = db.scalar(select(IncidentPII).where(IncidentPII.incident_id == incident_id))
        assert row is not None
        for field, plaintext in (
            ("transcript", "My name is Asha and my number is +919800000000"),
            ("reporter_name", "Asha Nair"),
            ("reporter_phone", "+919800000000"),
            ("emergency_contact_name", "Maya Nair"),
            ("emergency_contact_phone", "+919800000001"),
        ):
            ciphertext = getattr(row, f"{field}_ciphertext")
            assert ciphertext and plaintext.encode() not in ciphertext
            assert decrypt_field(ciphertext, f"{incident_id}:{row.report_id}:{field}") == plaintext

    assert client.post(f"/api/v1/incidents/{incident_id}/reveal", headers=admin, json={}).status_code == 422
    assert client.post(
        f"/api/v1/incidents/{incident_id}/reveal", headers=admin, json={"reason": "   "}
    ).status_code == 422

    response = client.post(
        f"/api/v1/incidents/{incident_id}/reveal",
        headers=admin,
        json={"reason": "Call back to confirm identity"},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["transcript"] == "My name is Asha and my number is +919800000000"
    assert len(data["reporters"]) == 1
    assert data["reporters"][0]["name"] == "Asha Nair"
    assert data["reporters"][0]["phone"] == "+919800000000"
    assert data["reporters"][0]["language"] == "ml"
    assert data["reporters"][0]["emergency_contact"] == {"name": "Maya Nair", "phone": "+919800000001"}
    with SessionLocal() as db:
        entry = db.scalar(select(AuditEntry).where(AuditEntry.action == "pii.reveal").order_by(AuditEntry.seq.desc()))
        assert entry is not None
        assert entry.actor == {"type": "admin", "id": "admin"}
        assert entry.target == {"type": "incident", "id": incident_id}
        assert entry.details["reason"] == "Call back to confirm identity"
        assert "Asha" not in str(entry.details) and "+919800000000" not in str(entry.details)


def test_reveal_is_admin_only_and_unknown_incident_is_not_found():
    admin = setup()
    incident_id = mock_incident()
    ambulance = login("amb-01")
    assert client.post(
        f"/api/v1/incidents/{incident_id}/reveal", headers=ambulance, json={"reason": "need details"}
    ).status_code == 403
    assert client.post(
        "/api/v1/incidents/missing/reveal", headers=admin, json={"reason": "need details"}
    ).status_code == 404


def test_pii_ciphertext_cannot_be_tampered_with_or_moved_between_fields():
    encrypted = encrypt_field("private", "incident:report:transcript")
    changed = bytearray(encrypted)
    changed[-1] ^= 1
    try:
        decrypt_field(bytes(changed), "incident:report:transcript")
        assert False, "tampered ciphertext should fail authentication"
    except RuntimeError as exc:
        assert "authentication" in str(exc)
    try:
        decrypt_field(encrypted, "incident:report:reporter_name")
        assert False, "ciphertext should be bound to its field context"
    except RuntimeError as exc:
        assert "context" in str(exc)
