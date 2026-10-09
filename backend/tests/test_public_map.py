from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import SessionLocal
from app.main import app
from app.models import Incident
from tests.test_incidents_api import create_incident, setup

client = TestClient(app)


def set_status(incident_id, status):
    with SessionLocal() as db:
        db.get(Incident, incident_id).status = status
        db.commit()


def test_public_feed_needs_no_login_and_hides_unconfirmed_incidents():
    setup()
    incident_id = create_incident()
    set_status(incident_id, "pending_approval")
    body = client.get("/api/v1/public/incidents").json()
    assert body["incidents"] == []  # not confirmed yet: nothing public
    for status in ("rejected", "processing"):
        set_status(incident_id, status)
        assert client.get("/api/v1/public/incidents").json()["incidents"] == []


def test_public_feed_shows_only_coarse_facts_once_confirmed():
    setup()
    incident_id = create_incident(text="Fire at Anitha Nair flat 4B, call +919800000000")
    set_status(incident_id, "dispatched")
    response = client.get("/api/v1/public/incidents")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=5"
    item = response.json()["incidents"][0]
    assert set(item) == {"id", "incident_type", "severity", "status", "location", "area_precision_km", "reported_at"}
    assert item["status"] == "help assigned" and item["severity"] in {"low", "medium", "high", "critical"}
    assert item["location"] == {"lat": 9.98, "lng": 76.3}  # 9.98, 76.299 rounded to about 1 km
    assert item["id"] != incident_id and len(item["id"]) == 12
    raw = response.text
    for secret in (incident_id, "Anitha", "9800000000", "4B", "summary", "report_ids", "hazards"):
        assert secret not in raw
    assert item["reported_at"].endswith(":00Z")  # rounded to the minute


def test_public_feed_is_rate_limited_per_ip(monkeypatch):
    from app import public_routes

    calls = []
    monkeypatch.setattr(public_routes.rate_limiter, "check", lambda key, limit: calls.append((key, limit)))
    client.get("/api/v1/public/incidents")
    assert calls and calls[0][0].startswith("public:") and calls[0][1] == 60


def _approved_incident_with_unit(status_for_unit):
    from app.models import Dispatch, Unit

    admin = setup()
    incident_id = create_incident(text="Fire at Anitha Nair flat 4B, call +919800000000")
    approve = client.post(f"/api/v1/incidents/{incident_id}/approve", headers=admin, json={})
    assert approve.status_code == 200, approve.text
    with SessionLocal() as db:
        d = db.scalars(select(Dispatch).where(Dispatch.incident_id == incident_id, Dispatch.status == "approved")).first()
        d.status = status_for_unit
        unit_id = d.unit_id
        db.commit()
        name = db.get(Unit, unit_id).name
    return incident_id, unit_id, name


def test_public_units_lists_only_units_on_confirmed_incidents_without_identity():
    setup()
    assert client.get("/api/v1/public/units").json()["units"] == []  # idle units are never published
    incident_id, unit_id, name = _approved_incident_with_unit("en_route")
    response = client.get("/api/v1/public/units")
    assert response.status_code == 200 and response.headers["cache-control"] == "public, max-age=2"
    item = response.json()["units"][0]
    assert set(item) == {"id", "service_type", "status", "location", "incident", "eta_minutes"}
    assert item["status"] == "help on the way" and item["eta_minutes"] >= 1
    for secret in (unit_id, name, incident_id, "Anitha", "9800000000"):
        assert secret not in response.text
    # the link a map needs: same opaque id as the public incident feed
    incident = client.get("/api/v1/public/incidents").json()["incidents"][0]
    assert item["incident"] == incident["id"]
    lat, lng = item["location"]["lat"], item["location"]["lng"]
    assert lat == round(lat, 3) and lng == round(lng, 3)


def test_public_units_hides_units_of_unconfirmed_incidents_and_marks_arrival():
    incident_id, unit_id, _ = _approved_incident_with_unit("on_scene")
    unit = client.get("/api/v1/public/units").json()["units"][0]
    assert unit["status"] == "help on scene" and unit["eta_minutes"] is None
    set_status(incident_id, "pending_approval")
    assert client.get("/api/v1/public/units").json()["units"] == []


def test_incident_calls_returns_the_contract_candidate_lists_too():
    incident_id, _, _ = _approved_incident_with_unit("approved")
    admin = setup_login()
    body = client.get(f"/api/v1/incidents/{incident_id}/calls", headers=admin).json()
    assert body["calls"] and body["lists"]
    assert body["lists"][0]["candidates"][0]["state"] in {"calling", "accepted", "standby", "declined", "no_answer"}


def setup_login():
    from tests.test_incidents_api import login

    return login("admin", "admin123")
