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
