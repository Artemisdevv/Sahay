"""Runs the agent pipeline off the request path and broadcasts the result over WebSocket."""
from __future__ import annotations

import logging

from fastapi.concurrency import run_in_threadpool

from app.agents.pipeline import IGNORED, Result, run_pipeline
from app.database import SessionLocal
from app.dispatch.routes import broadcast, dispatch_json
from app.events import manager
from app.models import Report

log = logging.getLogger("sahay.pipeline")


async def run_report_pipeline(report_id: str) -> Result | None:
    # Lazy import: app.main installs the routes that schedule this task, so importing it at module load would cycle.
    from app.main import incident_json, trace_json

    def work() -> Result:
        with SessionLocal() as db:
            return run_pipeline(db, report_id)

    try:
        result = await run_in_threadpool(work)
    except Exception:  # noqa: BLE001 - never lose a report because an agent crashed
        log.exception("pipeline crashed for report %s", report_id)
        with SessionLocal() as db:
            report = db.get(Report, report_id)
            if report is not None and report.status == "processing":
                report.status = "received"
                db.commit()
        return None

    if result.skipped == IGNORED:  # tell the reporter, who would otherwise wait on a report nobody will act on
        from app.ingest.routes import STATUS_MESSAGES
        await manager.publish(
            "report.status",
            {"report_id": result.report.report_id, "status": "rejected", "eta_minutes": None,
             "message": STATUS_MESSAGES["rejected"]},
            civilian_device_id=result.report.device_id,
        )
    if result.incident is None or result.outcome is None:
        return result
    await manager.publish("incident.created", incident_json(result.incident))
    for trace in result.traces:
        await manager.publish("agent.trace", trace_json(trace))
    for d in result.outcome.dispatches:
        await manager.publish("dispatch.proposed", dispatch_json(d))
    with SessionLocal() as db:
        await broadcast(db, result.outcome, incident_json)
    return result
