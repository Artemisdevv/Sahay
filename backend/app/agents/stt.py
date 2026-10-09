"""Speech-to-text seam (B-05 plugs live adapters in here).

transcribe() returns text, or None when it cannot (no audio model, provider down). The pipeline treats None as
"skipped" and continues from the quick-tap category, so a missing STT never blocks a report.
"""
from __future__ import annotations

from typing import Protocol


class Transcriber(Protocol):
    def transcribe(self, audio: bytes, mime: str, language: str) -> str | None: ...


class MockTranscriber:
    """Offline/test mode: no audio model. Text payloads bypass STT entirely."""

    def transcribe(self, audio: bytes, mime: str, language: str) -> str | None:
        return None


def build_transcriber(mode: str) -> Transcriber:
    if mode == "mock":
        return MockTranscriber()
    raise RuntimeError("Live STT adapters (Cloudflare Workers AI chain) arrive with B-05; set SAHAY_STT_MODE=mock")
