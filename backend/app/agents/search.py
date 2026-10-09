"""Web-search tool for the triage agent (hazard context, weather alerts). Seam plus an offline mock."""
from __future__ import annotations

import re
from typing import Protocol

import httpx

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


def _plain(value: object) -> str:
    """Collapse whitespace and drop markdown heading/bullet marks the API sometimes returns."""
    return " ".join(re.sub(r"[#*_`>]+", " ", str(value or "")).split())


class FirecrawlSearch:
    """Hazard context from Firecrawl's search API (v2). The query is built only from the hazard words the intake
    agent produced ("gas", "chemical"...): no transcript, name, phone or location ever leaves the server here.
    The result is untrusted web text: the triage prompt treats it as data, and it is length-capped."""

    URL = "https://api.firecrawl.dev/v2/search"
    # Only physical hazards are worth a lookup. Vague words ("traffic", "weapon") return irrelevant foreign pages.
    SEARCHABLE = frozenset({"gas", "chemical", "electric", "smoke", "water", "fire", "flood", "explosive", "toxic"})

    def __init__(self, api_key: str, timeout_s: float = 10.0, client: httpx.Client | None = None) -> None:
        if not api_key:
            raise RuntimeError("SAHAY_WEB_SEARCH_KEY is required when SAHAY_SEARCH_MODE=live")
        self._headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        self._client = client or httpx.Client(timeout=timeout_s)

    def lookup(self, query: str) -> str | None:
        query = " ".join(w for w in query.lower().split() if w in self.SEARCHABLE)
        if not query:
            return None
        body = {"query": f"{query} emergency response safety guidance", "limit": 3}
        res = self._client.post(self.URL, headers=self._headers, json=body)  # errors propagate: pipeline ignores them
        res.raise_for_status()
        data = res.json().get("data") or {}
        results = data.get("web", []) if isinstance(data, dict) else data
        lines = []
        for item in results[:2]:
            title = _plain(item.get("title"))[:80]
            desc = _plain(item.get("description") or item.get("snippet"))[:160]
            if title or desc:
                lines.append(f"{title}: {desc}".strip(": "))
        return "; ".join(lines)[:300] or None


def build_search(mode: str) -> WebSearch:
    if mode == "mock":
        return MockSearch()
    if mode == "live":
        from app.settings import settings

        return FirecrawlSearch(settings.sahay_web_search_key)
    raise RuntimeError(f"SAHAY_SEARCH_MODE={mode!r} is not 'mock' or 'live'")
