import pytest

from app.database import SessionLocal
from app.models import AgentTrace, Incident, Report
from app.agents.store import load_pii
from tests.test_reports_api import PAYLOAD, Dev, client, post


@pytest.fixture()
def autorun(monkeypatch):
    from app.ingest import routes

    monkeypatch.setattr(routes.settings, "sahay_pipeline_autorun", True)


def admin_headers():
    client.post("/api/v1/dev/seed")
    r = client.post("/api/v1/auth/login", json={"username": "admin", "password": "admin123"})
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_posted_report_becomes_incident_with_traces(autorun):
    admin_headers()
    d = Dev()
    env = d.envelope({**PAYLOAD, "text": "I am Anu Menon, two people injured, bleeding. Call 9876543210",
                      "reporter": {"name": "Anu Menon", "phone": "9876543210"}})
    r = post(env, d)
    assert r.status_code == 202 and r.json()["status"] == "received"
    with SessionLocal() as db:
        rep = db.get(Report, env["report_id"])
        assert rep.incident_id and rep.status == "pending_approval"
        inc = db.get(Incident, rep.incident_id)
        assert inc.status == "pending_approval" and "9876543210" not in inc.summary_redacted
        steps = [t.step for t in db.query(AgentTrace).filter_by(incident_id=inc.incident_id).order_by(AgentTrace.started_at)]
        assert steps == ["transcribe", "intake", "pii", "triage", "dedup", "dispatch", "approval"]
        assert load_pii(db, inc.incident_id)["reporters"][0]["name"] == "Anu Menon"
    status = client.get(f"/api/v1/reports/{env['report_id']}/status", headers=d.auth).json()
    assert status["status"] == "pending_approval"
    # an admin can now approve what the pipeline proposed
    h = admin_headers_for_existing()
    out = client.post(f"/api/v1/incidents/{inc.incident_id}/approve", headers=h)
    assert out.status_code == 200 and out.json()["incident"]["status"] == "dispatched"
    assert client.get(f"/api/v1/reports/{env['report_id']}/status", headers=d.auth).json()["status"] == "dispatched"


def admin_headers_for_existing():
    r = client.post("/api/v1/auth/login", json={"username": "admin", "password": "admin123"})
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_admin_websocket_sees_incident_and_agent_traces(autorun):
    h = admin_headers()
    token = h["Authorization"].split()[1]
    d = Dev()
    with client.websocket_connect(f"/ws/v1?token={token}") as ws:
        post(d.envelope({**PAYLOAD, "text": "car crash with injured people"}), d)
        types = []
        for _ in range(12):
            types.append(ws.receive_json()["type"])
            if types.count("agent.trace") == 7 and "dispatch.proposed" in types:
                break
    assert types[0] == "incident.created"
    assert types.count("agent.trace") == 7 and "dispatch.proposed" in types


def test_civilian_gets_status_push_after_auto_dispatch(autorun):
    admin_headers()
    d = Dev()
    env = d.envelope({**PAYLOAD, "category": "crime", "text": "someone stole my bike"})
    with client.websocket_connect(f"/ws/v1?token={d.token}") as ws:
        post(env, d)
        msg = ws.receive_json()
    assert msg["type"] == "report.status" and msg["data"]["report_id"] == env["report_id"]
    assert msg["data"]["status"] == "dispatched" and "ETA" in msg["data"]["message"]


def test_autorun_off_leaves_report_received():
    d = Dev()
    env = d.envelope()
    post(env, d)
    with SessionLocal() as db:
        assert db.get(Report, env["report_id"]).status == "received"


def test_dev_process_endpoint_runs_pipeline_and_is_idempotent():
    admin_headers()
    d = Dev()
    env = d.envelope({**PAYLOAD, "category": "crime", "text": "bike stolen"})
    post(env, d)
    first = client.post(f"/api/v1/dev/process/{env['report_id']}")
    assert first.status_code == 200 and first.json()["incident_id"]
    again = client.post(f"/api/v1/dev/process/{env['report_id']}")
    assert again.json()["skipped"] == "already processed"
    assert client.post("/api/v1/dev/process/nope").status_code == 500


def test_dev_process_hidden_when_not_dev(monkeypatch):
    from app.ingest import routes

    monkeypatch.setattr(routes.settings, "sahay_dev", False)
    assert client.post("/api/v1/dev/process/anything").status_code == 404


def test_pipeline_crash_does_not_lose_the_report(autorun, monkeypatch):
    from app.agents import runner

    def boom(*a, **k):
        raise RuntimeError("agent exploded")

    monkeypatch.setattr(runner, "run_pipeline", boom)
    d = Dev()
    env = d.envelope()
    r = post(env, d)
    assert r.status_code == 202  # the civilian still gets a receipt
    with SessionLocal() as db:
        rep = db.get(Report, env["report_id"])
        assert rep.status == "received" and rep.incident_id is None
