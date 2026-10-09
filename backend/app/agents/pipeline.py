"""Agent pipeline (B-06): report -> transcribe -> intake -> pii -> triage -> (dedup) -> dispatch -> approval.

Agents propose, code disposes: every LLM answer is validated into a Pydantic model, any step that errors falls
back to rules, and the unit choice is made by the deterministic engine (app.dispatch.engine), never a model.

Privacy rules enforced here:
- Traces and audit rows carry counts and categories only, never transcript text, names or numbers.
- PII fails closed: if tagging cannot run, the summary shown to services is a generic sentence.
- Transcript, reporter identity and PII spans are stored sealed (app.agents.store).
"""
from __future__ import annotations

import base64
import binascii
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.agents import pii as pii_agent
from app.agents.llm import LLM, MockLLM, build_llm
from app.agents.schemas import IntakeResult, PiiTag, TriageResult
from app.agents.search import WebSearch, build_search
from app.agents.store import store_pii
from app.agents.stt import Transcriber, build_transcriber
from app.dispatch import engine
from app.ingest import crypto
from app.keyring import server_box_key
from app.models import AgentTrace, Incident, Report
from app.settings import settings

AUTO_APPROVE_MAX_SEVERITY = 3
AUTO_APPROVE_MIN_CONFIDENCE = 0.7


@dataclass
class Agents:
    llm: LLM
    transcriber: Transcriber
    search: WebSearch


def default_agents() -> Agents:
    return Agents(build_llm(settings.sahay_llm_mode), build_transcriber(settings.sahay_stt_mode), build_search("mock"))


@dataclass
class Result:
    report: Report
    incident: Incident | None = None
    traces: list[AgentTrace] = field(default_factory=list)
    outcome: engine.Outcome | None = None
    skipped: str | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _agent_actor(name: str) -> dict:
    return {"type": "agent", "id": name}


class _Steps:
    """Collects trace rows until the incident exists, then persists them."""

    def __init__(self) -> None:
        self.rows: list[dict] = []

    def add(self, step: str, agent: str, status: str, summary: str, started: datetime, output: dict | None = None) -> None:
        self.rows.append(dict(step=step, agent=agent, status=status, summary=summary[:250],
                              started_at=started, finished_at=_now(), output=output or {}))


def needs_approval(intake: IntakeResult, kind: str) -> tuple[bool, str]:
    if kind == "sos":
        return True, "SOS reports always need admin approval"
    if intake.severity > AUTO_APPROVE_MAX_SEVERITY:
        return True, f"severity {intake.severity} needs admin approval"
    if intake.confidence < AUTO_APPROVE_MIN_CONFIDENCE:
        return True, "low confidence (category only), needs admin approval"
    return False, f"auto-approved (severity {intake.severity}, confidence {intake.confidence})"


def run_pipeline(db: Session, report_id: str, agents: Agents | None = None) -> Result:
    agents = agents or default_agents()
    report = db.get(Report, report_id)
    if report is None:
        raise ValueError(f"unknown report {report_id}")
    if report.incident_id:
        return Result(report=report, skipped="already processed")

    try:
        payload = crypto.decrypt_payload(report.ciphertext, server_box_key())
    except crypto.IngestError:
        report.status = "rejected"
        report.updated_at = _now()
        db.commit()
        return Result(report=report, skipped="undecryptable")

    report.status = "processing"
    db.commit()
    steps = _Steps()

    # 1. transcribe -------------------------------------------------------------
    t0 = _now()
    transcript: str | None = None
    if payload.get("text"):
        transcript = payload["text"]
        steps.add("transcribe", "stt", "skipped", "Text supplied by reporter, no transcription needed", t0)
    elif payload.get("audio"):
        try:
            audio = base64.b64decode(payload["audio"]["data"], validate=True)
            transcript = agents.transcriber.transcribe(audio, payload["audio"].get("mime", ""), payload.get("language", "en"))
            if transcript:
                steps.add("transcribe", "stt", "done", f"Transcribed {len(audio) // 1024} KB of audio", t0)
            else:
                steps.add("transcribe", "stt", "skipped", "No transcript available, using quick-tap category", t0)
        except (binascii.Error, ValueError, RuntimeError, OSError) as exc:
            transcript = None
            steps.add("transcribe", "stt", "failed", f"STT failed ({type(exc).__name__}), using quick-tap category", t0)
    else:
        steps.add("transcribe", "stt", "skipped", "No audio or text", t0)

    # 2. intake -----------------------------------------------------------------
    t0 = _now()
    fallback = False
    try:
        intake = agents.llm.intake(transcript, payload["category"], payload.get("language", "en"), payload["kind"])
    except Exception:  # noqa: BLE001 - any model/validation error falls back to rules
        intake = MockLLM().intake(transcript, payload["category"], payload.get("language", "en"), payload["kind"])
        fallback = True
    steps.add("intake", "intake_agent", "done",
              f"{intake.incident_type}, severity {intake.severity}" + (" (rules fallback)" if fallback else ""), t0,
              {"incident_type": intake.incident_type, "severity": intake.severity, "people_count": intake.people_count,
               "hazards": intake.hazards, "confidence": intake.confidence, "fallback": fallback})

    # 3. pii (fail closed) ------------------------------------------------------
    t0 = _now()
    reporter = payload.get("reporter") or {}
    contact = payload.get("emergency_contact") or {}
    known = [("name", reporter.get("name")), ("phone", reporter.get("phone")),
             ("name", contact.get("name")), ("phone", contact.get("phone"))]
    known = [(t, v) for t, v in known if v]
    tags: list[PiiTag] = []
    pii_ok = True
    try:
        try:
            tags = pii_agent.detect(transcript or "", agents.llm, known)
        except Exception:  # noqa: BLE001
            tags = pii_agent.detect(transcript or "", MockLLM(), known)
        summary_redacted = pii_agent.redact(intake.summary, [], extra_literals=tags)
    except Exception:  # noqa: BLE001
        pii_ok = False
        summary_redacted = f"{intake.incident_type.title()} incident reported."
    counts = dict(Counter(t.type for t in tags))
    steps.add("pii", "pii_agent", "done" if pii_ok else "failed",
              f"Tagged {len(tags)} PII span(s)" if pii_ok else "PII tagging failed, generic summary used", t0,
              {"counts": counts})

    # 4. triage -----------------------------------------------------------------
    t0 = _now()
    context = None
    if intake.hazards:
        try:
            context = agents.search.lookup(" ".join(intake.hazards))
        except Exception:  # noqa: BLE001
            context = None
    try:
        triage: TriageResult = agents.llm.triage(intake, context)
    except Exception:  # noqa: BLE001
        triage = MockLLM().triage(intake, context)
    steps.add("triage", "triage_agent", "done", f"Needs {', '.join(triage.needed_services)}, severity {intake.severity}", t0,
              {"needed_services": triage.needed_services, "urgency_score": triage.urgency_score,
               "reason": triage.reason, "search_used": context is not None})

    # incident ------------------------------------------------------------------
    approval_needed, approval_why = needs_approval(intake, payload["kind"])
    loc = payload["location"]
    incident = Incident(
        status="pending_approval" if approval_needed else "triaged",
        incident_type=intake.incident_type, severity=intake.severity, urgency_score=triage.urgency_score,
        lat=loc["lat"], lng=loc["lng"], summary_redacted=summary_redacted[:500],
        people_count=intake.people_count, hazards=intake.hazards, needed_services=triage.needed_services,
        report_count=1, report_ids=[report.report_id], reason=triage.reason[:250],
    )
    db.add(incident)
    db.flush()
    store_pii(db, incident.incident_id, {
        "transcript": transcript,
        "language": payload.get("language", "en"),
        "reporters": [{"report_id": report.report_id, "name": reporter.get("name"), "phone": reporter.get("phone"),
                       "language": payload.get("language", "en")}],
        "emergency_contact": contact or None,
        "pii_spans": [t.model_dump() for t in tags],
    })
    report.incident_id = incident.incident_id
    for action, agent_name, detail in (
        ("agent.intake", "intake_agent", {"incident_type": intake.incident_type, "severity": intake.severity, "fallback": fallback}),
        ("agent.pii", "pii_agent", {"counts": counts, "ok": pii_ok}),
        ("agent.triage", "triage_agent", {"needed_services": triage.needed_services, "urgency_score": triage.urgency_score}),
    ):
        engine.audit(db, _agent_actor(agent_name), action, {"type": "incident", "id": incident.incident_id}, detail)

    # 5. dedup (B-11) -----------------------------------------------------------
    t0 = _now()
    steps.add("dedup", "dedup_agent", "skipped", "Dedup/cluster not enabled yet", t0)

    # 6. dispatch: deterministic engine only ------------------------------------
    t0 = _now()
    outcome = engine.propose(db, incident, triage.needed_services, auto_approve=not approval_needed,
                             actor=_agent_actor("dispatch_agent"))
    placed = [d for d in outcome.dispatches if d.status != "cancelled"]
    steps.add("dispatch", "dispatch_agent", "done",
              f"{len(placed)} unit(s) {'dispatched' if not approval_needed else 'proposed'}"
              + (f", none available for {', '.join(outcome.unfilled)}" if outcome.unfilled else ""), t0,
              {"dispatches": [{"service_type": d.service_type, "distance_km": d.distance_km, "eta_minutes": d.eta_minutes,
                               "status": d.status} for d in placed], "unfilled": outcome.unfilled})
    if not approval_needed and (outcome.unfilled or incident.status != "dispatched"):
        # Nothing (or not everything) could be auto-dispatched: a human decides.
        approval_needed = True
        approval_why = f"no unit available for {', '.join(outcome.unfilled) or 'any needed service'}"
        if incident.status != "dispatched":
            incident.status = "pending_approval"
            incident.updated_at = _now()
            report.status = "pending_approval"
            report.updated_at = _now()
            if report not in outcome.reports:
                outcome.reports.append(report)

    # 7. approval gate ----------------------------------------------------------
    t0 = _now()
    steps.add("approval", "approval_gate", "done" if approval_needed else "skipped", approval_why, t0,
              {"required": approval_needed})

    traces = []
    for row in steps.rows:
        trace = AgentTrace(incident_id=incident.incident_id, **row)
        db.add(trace)
        traces.append(trace)
    db.commit()
    return Result(report=report, incident=incident, traces=traces, outcome=outcome)
