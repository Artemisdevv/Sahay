"""LLM seam. Agents call these three typed methods; whether a model or rules answer is an implementation detail.

MockLLM is deterministic and offline: it is the test double, the offline-demo mode, and the fallback when a
live model errors. A live adapter (structured outputs) implements the same protocol (follow-up issue).
"""
from __future__ import annotations

import re
from typing import Protocol

from app.agents.schemas import IntakeResult, PiiTag, TriageResult

CATEGORY_WORDS: dict[str, tuple[str, ...]] = {
    "fire": ("fire", "smoke", "burning", "blaze", "आग", "धुआं", "തീ", "തീപിടിത്തം", "പുക"),
    "accident": ("accident", "crash", "collision", "collided", "दुर्घटना", "एक्सीडेंट", "അപകടം", "ഇടിച്ച"),
    "medical": ("unconscious", "heart", "breathing", "seizure", "collapsed", "बेहोश", "ബോധം", "ഹൃദയ", "ശ്വാസം"),
    "crime": ("robbery", "theft", "attack", "stabbed", "gun", "assault", "चोरी", "हमला", "കവർച്ച", "ആക്രമണം", "മോഷണം"),
    "flood": ("flood", "water level", "drowning", "बाढ़", "വെള്ളപ്പൊക്കം", "വെള്ളം കയറി"),
}
BASE_SEVERITY = {"fire": 4, "accident": 3, "medical": 3, "crime": 3, "flood": 3, "other": 2}
SEVERE_WORDS = (
    "unconscious", "not breathing", "bleeding", "trapped", "explosion", "gun", "stabbed", "spreading",
    "drowning", "child", "children", "many", "several", "बेहोश", "ബോധം", "രക്തം", "കുടുങ്ങി",
)
INJURY_WORDS = ("injured", "hurt", "bleeding", "unconscious", "not breathing", "ambulance", "घायल", "പരിക്ക്", "ആംബുലൻസ്")
POLICE_WORDS = ("police", "robbery", "theft", "attack", "stabbed", "gun", "assault", "पुलिस", "പോലീസ്")
FIRE_WORDS = ("fire", "smoke", "burning", "आग", "തീ", "പുക")
HAZARD_WORDS = {
    "chemical": ("chemical", "gas leak", "toxic", "रसायन", "രാസ"),
    "gas": ("lpg", "cylinder", "गैस", "ഗ്യാസ്"),
    "electric": ("electric", "live wire", "current", "बिजली", "വൈദ്യുത", "കറന്റ്"),
    "traffic": ("traffic", "junction", "highway"),
    "smoke": ("smoke", "धुआं", "പുക"),
    "water": ("flood", "water", "बाढ़", "വെള്ളം"),
}
NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}
PEOPLE_RE = re.compile(
    r"(\d+|one|two|three|four|five|six)\s+(?:people|persons|person|injured|victims|men|women|kids|children)", re.I
)
NAME_RE = re.compile(r"\b(?:my name is|i am|i'm|this is)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)", re.I)


class LLM(Protocol):
    def intake(self, transcript: str | None, category: str, language: str, kind: str) -> IntakeResult: ...

    def tag_pii(self, text: str) -> list[PiiTag]: ...

    def triage(self, intake: IntakeResult, context: str | None) -> TriageResult: ...


def has_any(text: str, words: tuple[str, ...]) -> bool:
    low = text.lower()
    return any(w.lower() in low for w in words)


class MockLLM:
    """Rules, not a model. Same contract as a live LLM so the pipeline cannot tell the difference."""

    def intake(self, transcript: str | None, category: str, language: str, kind: str) -> IntakeResult:
        text = transcript or ""
        itype = category
        if itype == "other":
            for cat, words in CATEGORY_WORDS.items():
                if has_any(text, words):
                    itype = cat
                    break
        severity = BASE_SEVERITY[itype] + sum(1 for w in SEVERE_WORDS if w.lower() in text.lower())
        people = 1
        m = PEOPLE_RE.search(text)
        if m:
            raw = m.group(1).lower()
            people = int(raw) if raw.isdigit() else NUMBER_WORDS.get(raw, 1)
        if people >= 3:
            severity += 1
        if kind == "sos":
            severity = max(severity, 4)
        severity = max(1, min(5, severity))
        hazards = [h for h, words in HAZARD_WORDS.items() if has_any(text, words)]
        label = itype.title()
        summary = f"{label} incident reported." if not text else f"{label} incident: {text.strip()[:300]}"
        return IntakeResult(
            incident_type=itype, severity=severity, people_count=people, hazards=hazards,
            location_hint=None, summary=summary[:500], confidence=0.8 if text else 0.5,
        )

    def tag_pii(self, text: str) -> list[PiiTag]:
        """Names after 'my name is' / 'I am'. A real model also tags addresses and Indic-script names."""
        return [PiiTag(type="name", text=m.group(1), start=m.start(1), end=m.end(1)) for m in NAME_RE.finditer(text)]

    def triage(self, intake: IntakeResult, context: str | None) -> TriageResult:
        text = intake.summary
        t = intake.incident_type
        services: list[str] = []
        if t == "fire" or has_any(text, FIRE_WORDS):
            services.append("fire")
        if t in ("medical", "accident", "fire", "flood") or has_any(text, INJURY_WORDS):
            services.append("ambulance")
        if t in ("crime", "accident") or has_any(text, POLICE_WORDS):
            services.append("police")
        if t == "flood" or "water" in intake.hazards or "chemical" in intake.hazards:
            services.append("municipal")
        if not services:
            services.append("municipal")
        services = list(dict.fromkeys(services))
        urgency = min(1.0, round(intake.severity / 5 + 0.05 * len(intake.hazards), 2))
        reason = f"{t} severity {intake.severity}; needs {', '.join(services)}"
        if context:
            reason += f"; {context}"
        return TriageResult(needed_services=services, urgency_score=urgency, reason=reason[:250])


PROVIDER_URLS = {"groq": "https://api.groq.com/openai/v1"}


def build_llm(mode: str) -> LLM:
    if mode == "mock":
        return MockLLM()
    if mode == "live":
        from app.agents.llm_live import LiveLLM  # lazy: keeps httpx/network code out of mock-only runs
        from app.settings import settings

        base_url = settings.llm_base_url or PROVIDER_URLS.get(settings.llm_provider.lower(), "")
        if not base_url:
            raise RuntimeError("Set LLM_PROVIDER=groq (or LLM_BASE_URL for another OpenAI-compatible provider)")
        return LiveLLM(settings.llm_api_key, settings.llm_model, base_url, settings.llm_timeout_s)
    raise RuntimeError(f"SAHAY_LLM_MODE={mode!r} is not 'mock' or 'live'")
