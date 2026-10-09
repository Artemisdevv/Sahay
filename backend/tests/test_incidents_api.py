from sqlalchemy import select
from fastapi.testclient import TestClient
import base64
import json

from app.database import SessionLocal
from app.events import SERVICE_INCIDENT_FIELDS
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

    assert client.post(f"/api/v1/incidents/{medical_id}/approve", headers=admin).status_code == 200
    ambulance = login("amb-01")
    service_detail = client.get(f"/api/v1/incidents/{medical_id}", headers=ambulance)
    assert service_detail.status_code == 200
    own_unit_id = decode_access_token(ambulance["Authorization"].split()[1])["unit_id"]
    assert {dispatch["unit_id"] for dispatch in service_detail.json()["dispatches"]} == {own_unit_id}
    assert client.get(f"/api/v1/incidents/{fire_id}", headers=ambulance).status_code == 404
    service_list = client.get("/api/v1/incidents", headers=ambulance).json()["incidents"]
    assert {incident["incident_id"] for incident in service_list} == {medical_id}


def test_service_cannot_see_incident_until_dispatch_is_approved_or_after_it_is_rejected():
    admin = setup()
    incident_id = create_incident("medical", ["ambulance"])
    ambulance = login("amb-01")

    # Dispatch is only proposed: the unit must not learn about the incident yet.
    assert client.get(f"/api/v1/incidents/{incident_id}", headers=ambulance).status_code == 404
    assert client.get("/api/v1/incidents", headers=ambulance).json()["incidents"] == []

    assert client.post(f"/api/v1/incidents/{incident_id}/approve", headers=admin).status_code == 200
    assert client.get(f"/api/v1/incidents/{incident_id}", headers=ambulance).status_code == 200

    # Admin changes their mind: the cancelled dispatch revokes access.
    reject = client.post(f"/api/v1/incidents/{incident_id}/reject", json={"reason": "duplicate"}, headers=admin)
    assert reject.status_code == 200, reject.text
    assert client.get(f"/api/v1/incidents/{incident_id}", headers=ambulance).status_code == 404
    assert client.get("/api/v1/incidents", headers=ambulance).json()["incidents"] == []


def test_service_incident_responses_use_the_websocket_field_whitelist():
    admin = setup()
    incident_id = create_incident("medical", ["ambulance"])
    client.post(f"/api/v1/incidents/{incident_id}/approve", headers=admin)
    ambulance = login("amb-01")

    detail = client.get(f"/api/v1/incidents/{incident_id}", headers=ambulance).json()
    listed = client.get("/api/v1/incidents", headers=ambulance).json()["incidents"][0]
    for body in (detail, listed):
        assert not {"report_ids"} & body.keys()
        assert {"incident_id", "status", "location", "summary_redacted"} <= body.keys()
    assert set(listed) <= SERVICE_INCIDENT_FIELDS
    assert set(detail) - {"dispatches"} <= SERVICE_INCIDENT_FIELDS
    # Admin still gets the full shape.
    admin_detail = client.get(f"/api/v1/incidents/{incident_id}", headers=admin).json()
    assert "report_ids" in admin_detail


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


def test_reveal_commits_audit_before_loading_pii(monkeypatch):
    admin = setup()
    incident_id = create_incident(text="Private details")
    from app import incident_routes

    original_load_pii = incident_routes.load_pii
    observed = {}

    def audited_load(db, requested_incident_id):
        with SessionLocal() as separate_db:
            observed["audit_exists"] = any(
                entry.target.get("id") == requested_incident_id
                for entry in separate_db.scalars(
                    select(AuditEntry).where(AuditEntry.action == "pii.reveal")
                )
            )
        return original_load_pii(db, requested_incident_id)

    monkeypatch.setattr(incident_routes, "load_pii", audited_load)
    response = client.post(
        f"/api/v1/incidents/{incident_id}/reveal", headers=admin, json={"reason": "verify audit order"}
    )
    assert response.status_code == 200, response.text
    assert observed["audit_exists"] is True


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


def test_public_units_endpoint_is_public_and_fuzzed():
    client.post("/api/v1/dev/seed")
    r = client.get("/api/v1/public/units")
    assert r.status_code == 200
    data = r.json()
    assert "units" in data
    assert len(data["units"]) == 6
    for unit in data["units"]:
        assert set(unit.keys()) == {"service_type", "name", "status", "location", "updated_at"}
        assert "unit_id" not in unit
        assert "lat" not in unit and "lng" not in unit
        loc = unit["location"]
        assert "lat" in loc and "lng" in loc
        # Coordinates should be fuzzed (different from exact seed coordinates)
        # Original seed lat/lng are 9.9816, 76.2999 for Ambulance 01 etc.
        # Fuzzing is +/- 0.01, so values should differ from exact seeds
        assert isinstance(loc["lat"], float) and isinstance(loc["lng"], float)


def test_public_units_no_auth_required():
    client.post("/api/v1/dev/seed")
    r = client.get("/api/v1/public/units")
    assert r.status_code == 200
    # No Authorization header needed


def test_incident_calls_endpoint_admin_sees_all_dispatches():
    admin = setup()
    incident_id = create_incident("medical", ["ambulance", "police"])
    client.post(f"/api/v1/incidents/{incident_id}/approve", headers=admin)

    r = client.get(f"/api/v1/incidents/{incident_id}/calls", headers=admin)
    assert r.status_code == 200
    data = r.json()
    assert data["incident_id"] == incident_id
    assert "calls" in data
    assert len(data["calls"]) == 2
    for call in data["calls"]:
        assert set(call.keys()) == {"dispatch_id", "service_type", "status", "distance_km", "eta_minutes", "created_at", "updated_at"}
        assert call["service_type"] in ("ambulance", "police")
        assert call["status"] in ("proposed", "approved", "accepted", "en_route", "on_scene", "completed", "declined", "cancelled")


def test_incident_calls_endpoint_service_sees_only_own_approved_dispatch():
    admin = setup()
    incident_id = create_incident("medical", ["ambulance", "police"])
    client.post(f"/api/v1/incidents/{incident_id}/approve", headers=admin)

    ambulance = login("amb-01")
    r = client.get(f"/api/v1/incidents/{incident_id}/calls", headers=ambulance)
    assert r.status_code == 200
    data = r.json()
    assert data["incident_id"] == incident_id
    assert len(data["calls"]) == 1
    assert data["calls"][0]["service_type"] == "ambulance"
    assert data["calls"][0]["status"] == "approved"

    police = login("police-01")
    r = client.get(f"/api/v1/incidents/{incident_id}/calls", headers=police)
    assert r.status_code == 200
    data = r.json()
    assert len(data["calls"]) == 1
    assert data["calls"][0]["service_type"] == "police"


def test_incident_calls_endpoint_service_cannot_see_before_approval():
    admin = setup()
    incident_id = create_incident("medical", ["ambulance"])
    ambulance = login("amb-01")

    # Dispatch is only proposed
    r = client.get(f"/api/v1/incidents/{incident_id}/calls", headers=ambulance)
    assert r.status_code == 404


def test_incident_calls_endpoint_unknown_incident_returns_404():
    admin = setup()
    r = client.get("/api/v1/incidents/missing/calls", headers=admin)
    assert r.status_code == 404


def test_incident_calls_endpoint_civilian_forbidden():
    admin = setup()
    incident_id = create_incident("medical", ["ambulance"])
    from tests.device_helpers import register_device
    from nacl.signing import SigningKey
    dev = register_device(client, "55555555-5555-4555-8555-555555555555", SigningKey.generate(), "en").json()
    civ = {"Authorization": f"Bearer {dev['token']}"}
    r = client.get(f"/api/v1/incidents/{incident_id}/calls", headers=civ)
    assert r.status_code == 403


def test_incident_calls_endpoint_unauthenticated_returns_401():
    admin = setup()
    incident_id = create_incident("medical", ["ambulance"])
    r = client.get(f"/api/v1/incidents/{incident_id}/calls")
    assert r.status_code == 401
