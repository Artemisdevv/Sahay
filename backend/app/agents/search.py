"""Web-search tool for the triage agent (hazard context, weather alerts). Seam plus an offline mock."""
from __future__ import annotations

from typing import Protocol

CANNED = {
    "chemical": "Possible chemical exposure: keep responders upwind, hazmat protocol",
    "gas": "Gas hazard: no ignition sources, evacuate nearby",
    "electric": "Electrical hazard: wait for power isolation before approach",
    "water": "Water hazard: check local flood alerts before routing units",
    "smoke": "Smoke hazard: breathing apparatus advised",
}


class WebSearch(Protocol):
    def lookup(self, query: str) -> str | None: ...


class MockSearch:
    def lookup(self, query: str) -> str | None:
        for key, tip in CANNED.items():
            if key in query.lower():
                return tip
        return None


def build_search(mode: str) -> WebSearch:
    if mode == "mock":
        return MockSearch()
    raise RuntimeError("Live web search adapter is a follow-up; use mock")
