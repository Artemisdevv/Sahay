"""Live response (X-04): called list, no-answer, demo mover, auto-accept, location reports, event visibility."""
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import select

from app import live
from app.database import SessionLocal
from app.dispatch import engine
from app.events import ConnectionManager
from app.main import app
from app.models import AuditEntry, Dispatch, Incident, Unit
from tests.test_incidents_api import login, setup

client = TestClient(app)


def make_incident(lat=10.05, lng=76.40, category="medical"):
    admin = setup()
    r = client.post("/api/v1/dev/mock-report", json={
        "category": category, "severity": 4, "location": {"lat": lat, "lng": lng},
        "text": "help", "captured_at": "2026-10-09T10:15:00Z"})
    assert r.status_code == 201, r.text
    incident_id = r.json()["incident"]["incident_id"]
    a = client.post(f"/api/v1/incidents/{incident_id}/approve", headers=admin, json={})
    assert a.status_code == 200, a.text
    return incident_id, admin


def dispatch_of(db, incident_id):
    return db.scalars(select(Dispatch).where(Dispatch.incident_id == incident_id, Dispatch.status != "cancelled")
                      .order_by(Dispatch.created_at.desc())).first()


def test_called_list_ranks_units_and_marks_states():
    incident_id, _ = make_incident()
    NOW = datetime.now(timezone.utc)  # after the approval, so dispatch ages are measured from here
    with SessionLocal() as db:
        p = live.called_payload(db, incident_id, "ambulance")
    assert p["incident_id"] == incident_id and p["service_type"] == "ambulance"
    first = p["candidates"][0]
    assert first["state"] == "calling" and first["rank"] == 1 and first["distance_km"] > 0
    assert any(c["state"] == "standby" for c in p["candidates"])  # the next unit that would be called
    assert len(p["candidates"]) <= live.SHOWN_CANDIDATES


def test_no_answer_calls_the_next_unit_and_is_told_apart_from_a_decline():
    incident_id, _ = make_incident()
    NOW = datetime.now(timezone.utc)  # after the approval, so dispatch ages are measured from here
    with SessionLocal() as db:
        d = dispatch_of(db, incident_id)
        first_unit = d.unit_id
        out = engine.no_answer(db, d.dispatch_id, live.SYSTEM)
        assert any(x.status == "approved" and x.unit_id != first_unit for x in out.dispatches)
        p = live.called_payload(db, incident_id, "ambulance")
        states = {c["unit_id"]: c["state"] for c in p["candidates"]}
        assert states[first_unit] == "no_answer"
        assert "calling" in states.values()
        actions = {r.action for r in db.scalars(select(AuditEntry)).all()}
        assert "dispatch.no_answer" in actions


def test_call_timeout_in_tick_skips_a_silent_unit():
    incident_id, _ = make_incident()
    NOW = datetime.now(timezone.utc)  # after the approval, so dispatch ages are measured from here
    state = live.MoverState()
    with SessionLocal() as db:
        d = dispatch_of(db, incident_id)
        first = d.unit_id
        res = live.tick(db, NOW + timedelta(seconds=5), live.Config(call_timeout_s=30), state)
        assert res.outcomes == []  # not yet
        res = live.tick(db, NOW + timedelta(seconds=40), live.Config(call_timeout_s=30), state)
        assert len(res.outcomes) == 1
        assert dispatch_of(db, incident_id).unit_id != first


def test_auto_accept_then_departs_and_mover_glides_then_arrives_on_scene():
    incident_id, _ = make_incident(lat=10.05, lng=76.40)
    NOW = datetime.now(timezone.utc)  # after the approval, so dispatch ages are measured from here
    state = live.MoverState()
    cfg = live.Config(mover=True, arrival_s=60, auto_accept_s=5)
    with SessionLocal() as db:
        d = dispatch_of(db, incident_id)
        unit = db.get(Unit, d.unit_id)
        start = (unit.lat, unit.lng)
        live.tick(db, NOW + timedelta(seconds=6), cfg, state)  # auto-accept
        assert dispatch_of(db, incident_id).status == "accepted"
        live.tick(db, NOW + timedelta(seconds=9), cfg, state)  # departs after 2 s
        assert dispatch_of(db, incident_id).status == "en_route"
        t0 = NOW + timedelta(seconds=10)
        live.tick(db, t0, cfg, state)  # trip starts
        unit = db.get(Unit, d.unit_id)
        assert abs(unit.lat - start[0]) < 2e-3  # at most a second of travel
        res = live.tick(db, t0 + timedelta(seconds=30), cfg, state)  # halfway
        unit = db.get(Unit, d.unit_id)
        mid_lat = start[0] + (10.05 - start[0]) / 2
        assert abs(unit.lat - mid_lat) < 0.01
        moved = res.moved[0][1]
        assert moved["incident_id"] == incident_id and 0 <= moved["heading_deg"] < 360
        assert 25 <= moved["eta_seconds"] <= 35 and moved["speed_kmh"] > 0
        live.tick(db, t0 + timedelta(seconds=61), cfg, state)  # arrival
        assert dispatch_of(db, incident_id).status == "on_scene"
        unit = db.get(Unit, d.unit_id)
        assert (round(unit.lat, 4), round(unit.lng, 4)) == (10.05, 76.4)
        assert db.get(Incident, incident_id).status == "on_scene"


def test_auto_complete_frees_the_unit():
    incident_id, _ = make_incident()
    NOW = datetime.now(timezone.utc)  # after the approval, so dispatch ages are measured from here
    state = live.MoverState()
    cfg = live.Config(mover=True, arrival_s=10, auto_accept_s=1, auto_complete_s=5)
    with SessionLocal() as db:
        d = dispatch_of(db, incident_id)
        for step in range(0, 40):
            live.tick(db, NOW + timedelta(seconds=step), cfg, state)
        assert db.get(Dispatch, d.dispatch_id).status == "completed"
        assert db.get(Unit, d.unit_id).status == "available"


def test_mover_stands_aside_for_a_unit_with_a_real_phone():
    incident_id, _ = make_incident()
    NOW = datetime.now(timezone.utc)  # after the approval, so dispatch ages are measured from here
    state = live.MoverState()
    cfg = live.Config(mover=True, arrival_s=60, auto_accept_s=1)
    with SessionLocal() as db:
        d = dispatch_of(db, incident_id)
        live.tick(db, NOW + timedelta(seconds=2), cfg, state)
        live.tick(db, NOW + timedelta(seconds=5), cfg, state)
        assert dispatch_of(db, incident_id).status == "en_route"
        state.reported[d.unit_id] = NOW + timedelta(seconds=6)  # the phone just reported a position
        before = (db.get(Unit, d.unit_id).lat, db.get(Unit, d.unit_id).lng)
        res = live.tick(db, NOW + timedelta(seconds=10), cfg, state)
        assert res.moved == []
        assert (db.get(Unit, d.unit_id).lat, db.get(Unit, d.unit_id).lng) == before


def test_everything_is_off_by_default():
    assert live.Config().active is False
    assert live.Config.from_settings().active is False  # no background loop in tests or dev unless configured


def test_location_report_rules():
    admin = setup()
    me = login("amb-01")
    with SessionLocal() as db:
        mine_id = db.scalars(select(Unit).where(Unit.name == "Ambulance 01")).one().unit_id
        other_id = db.scalars(select(Unit).where(Unit.name == "Police 01")).one().unit_id
    ok = client.patch(f"/api/v1/units/{mine_id}/location", headers=me, json={"lat": 9.99, "lng": 76.3})
    assert ok.status_code == 200 and ok.json()["location"] == {"lat": 9.99, "lng": 76.3}
    assert client.patch(f"/api/v1/units/{other_id}/location", headers=me, json={"lat": 9.99, "lng": 76.3}).status_code == 403
    assert client.patch(f"/api/v1/units/{other_id}/location", headers=admin, json={"lat": 9.95, "lng": 76.28}).status_code == 200
    assert client.patch(f"/api/v1/units/{mine_id}/location", headers=me, json={"lat": 95, "lng": 76.3}).status_code == 422
    assert client.patch(f"/api/v1/units/{mine_id}/location", json={"lat": 9.9, "lng": 76.3}).status_code == 401
    with SessionLocal() as db:
        assert db.get(Unit, mine_id).lat == 9.99


def test_event_visibility_rules():
    can = ConnectionManager._can_receive
    moved = {"unit_id": "u1"}
    assert can("unit.moved", moved, "admin", {}, None, None)
    assert can("unit.moved", moved, "service", {"unit_id": "u1"}, {"u1", "u2"}, None)
    assert can("unit.moved", moved, "service", {"unit_id": "u2"}, {"u1", "u2"}, None)  # peer on the same incident
    assert not can("unit.moved", moved, "service", {"unit_id": "u3"}, {"u1", "u2"}, None)
    assert not can("unit.moved", moved, "civilian", {"device_id": "d"}, None, "d")
    assert can("dispatch.called", {}, "admin", {}, None, None)
    assert not can("dispatch.called", {}, "service", {"unit_id": "u9"}, {"u1"}, None)
