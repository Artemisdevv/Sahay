"""Run sample reports through the LIVE model (and live web search) the same way the pipeline does.

    cd backend
    .venv/Scripts/python.exe scripts/llm_eval.py            # uses backend/.env (LLM_API_KEY, SAHAY_WEB_SEARCH_KEY)
    .venv/Scripts/python.exe scripts/llm_eval.py --no-search --only ml-fire hi-gas

For each sample: PII detect (masked text to the model) -> redact -> intake -> web search -> triage.
Prints what the model decided, whether the expectations in llm_eval_samples.json hold, and whether any
identifier we expect to be hidden would have reached the intake prompt. Needs network and a key; costs a few
cents of tokens. Nothing is stored. Edit the samples freely; have a Malayalam/Hindi speaker check the wording.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")

from app.agents import pii as pii_agent  # noqa: E402
from app.agents.llm import build_llm  # noqa: E402
from app.agents.search import build_search  # noqa: E402
from app.settings import settings  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-search", action="store_true", help="skip the Firecrawl lookup")
    ap.add_argument("--only", nargs="*", help="sample ids to run")
    ap.add_argument("--delay", type=float, default=0.0, help="seconds to pause between samples (provider rate limits)")
    args = ap.parse_args()

    samples = json.loads((Path(__file__).with_name("llm_eval_samples.json")).read_text(encoding="utf-8"))
    if args.only:
        samples = [s for s in samples if s["id"] in args.only]
    llm = build_llm("live")
    search = None if args.no_search or not settings.sahay_web_search_key else build_search("live")
    chain = getattr(llm, "_providers", [llm])
    models = " -> ".join(f"{p._url.split('/')[2]}:{p._model}" for p in chain)
    print(f"llm={models} search={'on' if search else 'off'}\n")

    failures = 0
    for s in samples:
        if args.delay and s is not samples[0]:
            time.sleep(args.delay)
        t0 = time.time()
        row = {"id": s["id"]}
        try:
            tags = pii_agent.detect(s["text"], llm, [])
            masked = pii_agent.redact(s["text"], tags)
            intake = llm.intake(masked, s["category"], s["language"], "report")
            context = None
            if search and intake.hazards:
                try:
                    context = search.lookup(" ".join(intake.hazards))
                except Exception as exc:  # noqa: BLE001
                    context = f"(search failed: {type(exc).__name__})"
            triage = llm.triage(intake, context)
        except Exception as exc:  # noqa: BLE001
            print(f"[FAIL] {s['id']}: {type(exc).__name__}: {exc}\n")
            failures += 1
            continue

        exp, problems = s.get("expect", {}), []
        if "ignored" in exp:
            ignored = (not intake.is_civic_report) and intake.civic_confidence >= 0.85
            if ignored != exp["ignored"]:
                problems.append(f"ignored={ignored}, expected {exp['ignored']} "
                                f"(civic={intake.is_civic_report}, civic_conf={intake.civic_confidence})")
        if "type" in exp and not exp.get("ignored") and intake.incident_type != exp["type"]:
            problems.append(f"type {intake.incident_type} != {exp['type']}")
        if intake.severity < exp.get("min_severity", 1):
            problems.append(f"severity {intake.severity} < {exp['min_severity']}")
        for svc in exp.get("services", []):
            if svc not in triage.needed_services:
                problems.append(f"missing service {svc}")
        if exp.get("hazards_any") and not set(exp["hazards_any"]) & set(intake.hazards):
            problems.append(f"no hazard in {exp['hazards_any']}")
        for secret in exp.get("pii_hidden", []):
            if secret in masked:
                problems.append(f"PII reached intake prompt: {secret!r}")
            if secret in intake.summary:
                problems.append(f"PII in summary: {secret!r}")

        failures += bool(problems)
        print(f"[{'FAIL' if problems else ' ok '}] {s['id']}  ({time.time() - t0:.1f}s)")
        print(f"   masked text : {masked}")
        print(f"   pii tags    : {[(t.type, t.text) for t in tags]}")
        print(f"   intake      : {intake.incident_type} sev={intake.severity} people={intake.people_count} "
              f"hazards={intake.hazards} conf={intake.confidence} civic={intake.is_civic_report}/{intake.civic_confidence}"
              + (f" ({intake.ignore_reason})" if intake.ignore_reason else ""))
        print(f"   summary     : {intake.summary}")
        print(f"   triage      : {triage.needed_services} urgency={triage.urgency_score} | {triage.reason}")
        if context:
            print(f"   web context : {context[:160]}")
        for p in problems:
            print(f"   !! {p}")
        print()
    print(f"{len(samples) - failures}/{len(samples)} samples met expectations")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
