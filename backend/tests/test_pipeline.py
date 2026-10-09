import base64
import json

import pytest
from nacl.public import SealedBox
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.agents import pii as pii_mod
from app.agents.llm import MockLLM
from app.agents.pipeline import Agents, needs_approval, run_pipeline
from app.agents.schemas import IntakeResult
from app.agents.search import MockSearch
from app.agents.store import load_pii
from app.agents.stt import MockTranscriber
from app.database import Base
from app.keyring import server_box_key
from app.models import AgentTrace, AuditEntry, Dispatch, Incident, IncidentPII, Report, Unit
from app.pii_crypto import decrypt_field

SEED = [
    ("Ambulance 01", "ambulance", 9.9816, 76.2999),
    ("Ambulance 02", "ambulance", 9.9158, 76.2540),
    ("Police 01", "police", 9.9674, 76.2822),
    ("Police 02", "police", 9.9312, 76.2673),
    ("Fire 01", "fire", 9.9591, 76.2711),
    ("Fire 02", "fire", 10.0159, 76.3419),
]
STEPS = ["transcribe", "intake", "pii", "triage", "dedup", "dispatch", "approval"]


@pytest.fixture()
def db():
    eng = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with sessionmaker(bind=eng, autoflush=False, expire_on_commit=False)() as s:
        for name, st, lat, lng in SEED:
            s.add(Unit(name=name, service_type=st, lat=lat, lng=lng, status="available"))
        s.commit()
        yield s


def agents(**over) -> Agents:
    base = dict(llm=MockLLM(), transcriber=MockTranscriber(), search=MockSearch())
    base.update(over)
    return Agents(**base)


def payload(**over) -> dict:
    p = {"schema": 1, "kind": "report", "category": "accident", "language": "en",
         "captured_at": "2026-10-09T10:15:00Z", "location": {"lat": 9.9312, "lng": 76.2673}, "text": "car crash"}
    p.update(over)
    return p


def make_report(db, rid="r1", **over) -> Report:
    ct = SealedBox(server_box_key().public_key).encrypt(json.dumps(payload(**over)).encode())
    r = Report(report_id=rid, device_id="dev-1", created_at_signed="2026-10-09T10:15:00Z", ciphertext=ct,
               signature="s", kind=over.get("kind", "report"), category=over.get("category", "accident"),
               server_time="t", receipt_signature="s")
    db.add(r)
    db.commit()
    return r


def traces(db, inc):
    return list(db.scalars(select(AgentTrace).where(AgentTrace.incident_id == inc.incident_id).order_by(AgentTrace.started_at)))


# ---- happy paths ------------------------------------------------------------

def test_high_severity_report_waits_for_admin_and_hides_pii(db):
    text = "I am Anu Menon. Two people injured, bleeding, car crash near the junction. Call 9876543210"
    r = make_report(db, text=text, reporter={"name": "Anu Menon", "phone": "9876543210"})
    res = run_pipeline(db, r.report_id, agents())
    inc = res.incident
    assert inc.status == "pending_approval" and inc.severity >= 4 and inc.incident_type == "accident"
    assert "9876543210" not in inc.summary_redacted and "Anu" not in inc.summary_redacted
    assert "[PHONE]" in inc.summary_redacted and "[NAME]" in inc.summary_redacted
    assert r.status == "pending_approval" and r.incident_id == inc.incident_id
    # proposed, not reserved: a human still has to approve
    assert {d.status for d in res.outcome.dispatches} == {"proposed"}
    assert db.query(Unit).filter(Unit.status != "available").count() == 0
    assert [t.step for t in traces(db, inc)] == STEPS


def test_low_severity_confident_report_is_auto_dispatched(db):
    r = make_report(db, category="crime", text="someone stole my bike outside the shop")
    res = run_pipeline(db, r.report_id, agents())
    assert res.incident.status == "dispatched" and r.status == "dispatched"
    d = [d for d in res.outcome.dispatches if d.status == "approved"]
    assert len(d) == 1 and db.get(Unit, d[0].unit_id).name == "Police 02"
    approval = [t for t in traces(db, res.incident) if t.step == "approval"][0]
    assert approval.status == "skipped" and "auto-approved" in approval.summary


def test_audio_only_with_mock_stt_falls_back_to_category_and_needs_approval(db):
    audio = {"mime": "audio/webm", "data": base64.b64encode(b"opus-bytes").decode(), "duration_s": 5}
    r = make_report(db, category="crime", text=None, audio=audio)
    res = run_pipeline(db, r.report_id, agents())
    t = {t.step: t for t in traces(db, res.incident)}
    assert t["transcribe"].status == "skipped" and "quick-tap" in t["transcribe"].summary
    assert res.incident.status == "pending_approval"  # confidence 0.5 < 0.7
    assert load_pii(db, res.incident.incident_id)["transcript"] is None


def test_stt_success_uses_transcript(db):
    class Fixed:
        def transcribe(self, audio, mime, language):
            return "fire in the kitchen, three people trapped"

    audio = {"mime": "audio/webm", "data": base64.b64encode(b"x").decode(), "duration_s": 5}
    r = make_report(db, category="other", text=None, audio=audio, language="ml")
    res = run_pipeline(db, r.report_id, agents(transcriber=Fixed()))
    assert res.incident.incident_type == "fire" and res.incident.people_count == 3
    assert [t for t in traces(db, res.incident) if t.step == "transcribe"][0].status == "done"
    assert load_pii(db, res.incident.incident_id)["transcript"].startswith("fire in the kitchen")


def test_sos_always_needs_approval(db):
    r = make_report(db, kind="sos", category="other", text="help")
    res = run_pipeline(db, r.report_id, agents())
    assert res.incident.status == "pending_approval" and res.incident.severity >= 4


def test_sos_without_details_calls_medical_and_police(db):
    r = make_report(db, kind="sos", category="other", text="SOS: the sender needs urgent help and could not describe it.")
    res = run_pipeline(db, r.report_id, agents())
    assert set(res.incident.needed_services) == {"ambulance", "police"}
    assert res.incident.status == "pending_approval"
    proposed = db.scalars(select(Dispatch).where(Dispatch.incident_id == res.incident.incident_id)).all()
    assert {d.service_type for d in proposed} == {"ambulance", "police"}  # something real to approve, not a stuck incident


def test_sos_with_a_clear_type_keeps_its_own_services(db):
    r = make_report(db, kind="sos", category="fire", text="fire in the kitchen, help")
    res = run_pipeline(db, r.report_id, agents())
    assert "fire" in res.incident.needed_services


def test_hazard_context_comes_from_search_tool(db):
    r = make_report(db, category="fire", text="smoke from a chemical store")
    res = run_pipeline(db, r.report_id, agents())
    triage = [t for t in traces(db, res.incident) if t.step == "triage"][0]
    assert triage.output["search_used"] is True and "chemical exposure" in res.incident.reason.lower()


# ---- privacy ----------------------------------------------------------------

def test_pii_is_sealed_and_never_in_traces_or_audit(db):
    text = "My name is Ravi Kumar, phone 9876543210, accident on the bypass"
    r = make_report(db, text=text, reporter={"name": "Ravi Kumar", "phone": "9876543210"},
                    emergency_contact={"name": "Asha", "phone": "9123456780"})
    res = run_pipeline(db, r.report_id, agents())
    stored = load_pii(db, res.incident.incident_id)
    assert stored["transcript"] == text
    assert stored["reporters"][0]["phone"] == "9876543210" and stored["emergency_contact"]["name"] == "Asha"
    assert {s["type"] for s in stored["pii_spans"]} >= {"phone", "name"}
    rows = db.scalars(select(IncidentPII).where(IncidentPII.incident_id == res.incident.incident_id)).all()
    assert len(rows) == 1
    row = rows[0]
    assert b"9876543210" not in row.reporter_phone_ciphertext
    assert b"Ravi" not in row.reporter_name_ciphertext
    assert decrypt_field(row.reporter_phone_ciphertext,
                         f"{row.incident_id}:{row.report_id}:reporter_phone") == "9876543210"
    leaked = json.dumps([[t.summary, t.output] for t in traces(db, res.incident)]
                        + [[a.details, a.actor, a.target] for a in db.query(AuditEntry)], default=str)
    for secret in ("9876543210", "Ravi", "9123456780", "Asha"):
        assert secret not in leaked


def test_pii_failure_fails_closed_with_generic_summary(db, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("tagger down")

    monkeypatch.setattr(pii_mod, "detect", boom)
    r = make_report(db, text="I am Ravi Kumar 9876543210 car crash")
    res = run_pipeline(db, r.report_id, agents())
    assert res.incident.summary_redacted == "Accident incident reported."
    assert [t for t in traces(db, res.incident) if t.step == "pii"][0].status == "failed"


# ---- resilience -------------------------------------------------------------

def test_llm_errors_fall_back_to_rules(db):
    class Broken(MockLLM):
        def intake(self, *a, **k):
            raise ValueError("bad json")

        def triage(self, *a, **k):
            raise TimeoutError

        def tag_pii(self, text):
            raise ConnectionError

    r = make_report(db, category="fire", text="fire in the market")
    res = run_pipeline(db, r.report_id, agents(llm=Broken()))
    intake = [t for t in traces(db, res.incident) if t.step == "intake"][0]
    assert intake.output["fallback"] is True and "rules fallback" in intake.summary
    assert res.incident.needed_services[0] == "fire"


def test_stt_exception_is_a_failed_step_not_a_crash(db):
    class Down:
        def transcribe(self, *a):
            raise RuntimeError("provider timeout")

    audio = {"mime": "audio/webm", "data": base64.b64encode(b"x").decode(), "duration_s": 5}
    r = make_report(db, text=None, audio=audio)
    res = run_pipeline(db, r.report_id, agents(transcriber=Down()))
    assert [t for t in traces(db, res.incident) if t.step == "transcribe"][0].status == "failed"
    assert res.incident is not None


def test_invalid_audio_payload_is_rejected_not_processed(db):
    # Payload validation (shared with ingest) refuses undecodable audio; the pipeline must not create an incident.
    r = make_report(db, text=None, audio={"mime": "audio/webm", "data": "!!!", "duration_s": 1})
    res = run_pipeline(db, r.report_id, agents())
    assert res.incident is None and res.skipped == "undecryptable" and r.status == "rejected"


def test_no_units_means_human_decides(db):
    db.query(Unit).delete()
    db.commit()
    r = make_report(db, category="crime", text="bike stolen")
    res = run_pipeline(db, r.report_id, agents())
    assert res.incident.status == "pending_approval" and r.status == "pending_approval"
    assert res.outcome.unfilled == ["police"]
    approval = [t for t in traces(db, res.incident) if t.step == "approval"][0]
    assert approval.status == "done" and "no unit available" in approval.summary


def test_pipeline_is_idempotent(db):
    r = make_report(db, text="car crash")
    first = run_pipeline(db, r.report_id, agents())
    again = run_pipeline(db, r.report_id, agents())
    assert again.skipped == "already processed" and db.query(Incident).count() == 1
    assert first.incident.incident_id == r.incident_id


def test_unknown_and_undecryptable_reports(db):
    with pytest.raises(ValueError):
        run_pipeline(db, "missing", agents())
    r = Report(report_id="bad", device_id="d", created_at_signed="t", ciphertext=b"garbage", signature="s",
               kind="report", category="other", server_time="t", receipt_signature="s")
    db.add(r)
    db.commit()
    res = run_pipeline(db, "bad", agents())
    assert res.skipped == "undecryptable" and r.status == "rejected" and db.query(Incident).count() == 0


# ---- policy -----------------------------------------------------------------

@pytest.mark.parametrize("sev,conf,kind,expected", [
    (3, 0.8, "report", False), (4, 0.9, "report", True), (2, 0.5, "report", True),
    (1, 0.7, "report", False), (2, 0.9, "sos", True),
])
def test_approval_policy(sev, conf, kind, expected):
    intake = IntakeResult(incident_type="other", severity=sev, summary="x", confidence=conf)
    assert needs_approval(intake, kind)[0] is expected


def test_dispatch_uses_engine_only(db):
    """The dispatch step must produce engine-shaped dispatches (proposed_by dispatch_agent, Haversine ETA)."""
    r = make_report(db, text="car crash, injured")
    res = run_pipeline(db, r.report_id, agents())
    for d in db.scalars(select(Dispatch)):
        assert d.proposed_by == "dispatch_agent" and d.eta_minutes >= 1 and d.distance_km >= 0
