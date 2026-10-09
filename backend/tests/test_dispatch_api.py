from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

NEAR_AMB_01 = {"lat": 9.9800, "lng": 76.2990}  # Ambulance 01 is the nearest ambulance here


def login(username, password="demo123"):
    r = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def setup():
    client.post("/api/v1/dev/seed")
    return login("admin", "admin123")


def mock_incident(category="medical", severity=4, location=NEAR_AMB_01):
    r = client.post("/api/v1/dev/mock-report", json={
        "category": category, "severity": severity, "location": location, "text": "help", "captured_at": "2026-10-09T10:15:00Z",
    })
    assert r.status_code == 201, r.text
    return r.json()["incident"]["incident_id"]


def test_approve_then_service_lifecycle_over_http():
    admin = setup()
    iid = mock_incident()
    r = client.post(f"/api/v1/incidents/{iid}/approve", headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["incident"]["status"] == "dispatched"
    assert [d["status"] for d in body["dispatches"]] == ["approved"]

    amb = login("amb-01")
    mine = client.get("/api/v1/dispatches/mine", headers=amb).json()["dispatches"]
    assert len(mine) == 1 and mine[0]["status"] == "approved"
    did = mine[0]["dispatch_id"]

    assert client.post(f"/api/v1/dispatches/{did}/accept", headers=amb).json()["status"] == "accepted"
    for st in ("en_route", "on_scene", "completed"):
        r = client.post(f"/api/v1/dispatches/{did}/status", json={"status": st}, headers=amb)
        assert r.status_code == 200 and r.json()["status"] == st
    assert client.get("/api/v1/dispatches/mine", headers=amb).json()["dispatches"] == []
    units = client.get("/api/v1/units", headers=admin).json()["units"]
    assert next(u for u in units if u["name"] == "Ambulance 01")["status"] == "available"


def test_status_cannot_skip_steps():
    admin = setup()
    iid = mock_incident()
    client.post(f"/api/v1/incidents/{iid}/approve", headers=admin)
    amb = login("amb-01")
    did = client.get("/api/v1/dispatches/mine", headers=amb).json()["dispatches"][0]["dispatch_id"]
    r = client.post(f"/api/v1/dispatches/{did}/status", json={"status": "on_scene"}, headers=amb)
    assert r.status_code == 409 and r.json()["error"]["code"] == "conflict"
    assert client.post(f"/api/v1/dispatches/{did}/status", json={"status": "bogus"}, headers=amb).status_code == 422


def test_decline_returns_replacement_from_next_nearest():
    admin = setup()
    iid = mock_incident()
    client.post(f"/api/v1/incidents/{iid}/approve", headers=admin)
    amb = login("amb-01")
    did = client.get("/api/v1/dispatches/mine", headers=amb).json()["dispatches"][0]["dispatch_id"]
    r = client.post(f"/api/v1/dispatches/{did}/decline", json={"reason": "flat tyre"}, headers=amb)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["declined"]["status"] == "declined"
    assert body["replacement"]["status"] == "approved" and body["replacement"]["unit_id"] != body["declined"]["unit_id"]
    assert client.get("/api/v1/dispatches/mine", headers=amb).json()["dispatches"] == []


def test_reject_needs_reason_and_cancels():
    admin = setup()
    iid = mock_incident()
    assert client.post(f"/api/v1/incidents/{iid}/reject", json={}, headers=admin).status_code == 422
    r = client.post(f"/api/v1/incidents/{iid}/reject", json={"reason": "prank call"}, headers=admin)
    assert r.status_code == 200 and r.json()["incident"]["status"] == "rejected"
    assert client.post(f"/api/v1/incidents/{iid}/approve", headers=admin).status_code == 409


def test_reassign_to_other_unit():
    admin = setup()
    iid = mock_incident()
    units = client.get("/api/v1/units", headers=admin).json()["units"]
    amb2 = next(u for u in units if u["name"] == "Ambulance 02")
    client.post(f"/api/v1/incidents/{iid}/approve", headers=admin)
    r = client.post(f"/api/v1/incidents/{iid}/reassign", json={"needed_service": "ambulance", "unit_id": amb2["unit_id"]}, headers=admin)
    assert r.status_code == 200, r.text
    statuses = sorted((d["status"], d["unit_id"] == amb2["unit_id"]) for d in r.json()["dispatches"])
    assert ("approved", True) in statuses and any(s == "cancelled" for s, _ in statuses)


def test_unknown_and_double_approve():
    admin = setup()
    assert client.post("/api/v1/incidents/missing/approve", headers=admin).status_code == 404
    iid = mock_incident()
    assert client.post(f"/api/v1/incidents/{iid}/approve", headers=admin).status_code == 200
    assert client.post(f"/api/v1/incidents/{iid}/approve", headers=admin).status_code == 409


def test_roles_are_enforced():
    admin = setup()
    iid = mock_incident()
    amb = login("amb-01")
    assert client.post(f"/api/v1/incidents/{iid}/approve").status_code == 401
    assert client.post(f"/api/v1/incidents/{iid}/approve", headers=amb).status_code == 403
    assert client.get("/api/v1/dispatches/mine", headers=admin).status_code == 403
    dev = client.post("/api/v1/auth/register-device", json={
        "device_id": "33333333-3333-4333-8333-333333333333",
        "ed25519_public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "language": "en"}).json()
    civ = {"Authorization": f"Bearer {dev['token']}"}
    assert client.post(f"/api/v1/incidents/{iid}/approve", headers=civ).status_code == 403
    assert client.get("/api/v1/dispatches/mine", headers=civ).status_code == 403


def test_other_unit_cannot_act_on_dispatch():
    admin = setup()
    iid = mock_incident()
    client.post(f"/api/v1/incidents/{iid}/approve", headers=admin)
    did = client.get("/api/v1/dispatches/mine", headers=login("amb-01")).json()["dispatches"][0]["dispatch_id"]
    police = login("police-01")
    assert client.post(f"/api/v1/dispatches/{did}/accept", headers=police).status_code == 404


def test_admin_websocket_gets_dispatch_and_incident_events():
    admin = setup()
    iid = mock_incident()
    token = admin["Authorization"].split()[1]
    with client.websocket_connect(f"/ws/v1?token={token}") as ws:
        client.post(f"/api/v1/incidents/{iid}/approve", headers=admin)
        seen = {ws.receive_json()["type"], ws.receive_json()["type"]}
    assert seen == {"dispatch.updated", "incident.updated"}


def test_civilian_gets_report_status_push_when_dispatched():
    from app.database import SessionLocal
    from app.models import Incident, Report

    admin = setup()
    iid = mock_incident()
    dev_id = "44444444-4444-4444-8444-444444444444"
    reg = client.post("/api/v1/auth/register-device", json={
        "device_id": dev_id, "ed25519_public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "language": "ml"}).json()
    with SessionLocal() as db:
        db.add(Report(report_id="rep-push-1", device_id=dev_id, created_at_signed="t", ciphertext=b"x", signature="s",
                      kind="report", category="medical", server_time="t", receipt_signature="s"))
        db.get(Incident, iid).report_ids = ["rep-push-1"]
        db.commit()
    with client.websocket_connect(f"/ws/v1?token={reg['token']}") as ws:
        client.post(f"/api/v1/incidents/{iid}/approve", headers=admin)
        msg = ws.receive_json()
    assert msg["type"] == "report.status"
    assert msg["data"]["report_id"] == "rep-push-1" and msg["data"]["status"] == "dispatched"
    assert msg["data"]["eta_minutes"] is not None and "ETA" in msg["data"]["message"]
    status = client.get("/api/v1/reports/rep-push-1/status", headers={"Authorization": f"Bearer {reg['token']}"}).json()
    assert status["status"] == "dispatched" and status["eta_minutes"] == msg["data"]["eta_minutes"]
