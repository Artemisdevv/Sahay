"""Speech-to-text seam. Live adapters (Groq Whisper, Cloudflare) are in stt_live.py.

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
    if mode == "live":
        from app.agents.stt_live import build_live
        from app.settings import settings

        groq_key = settings.llm_api_key if settings.llm_provider.lower() == "groq" else ""
        cf_token = settings.cloudflare_api_token or settings.stt_api_key  # STT_API_KEY = Cloudflare Workers AI token
        return build_live(settings.sahay_stt_providers, groq_key, settings.cloudflare_account_id, cf_token,
                          settings.sahay_stt_timeout_s, settings.sahay_stt_prompt, settings.llm_api_key_gemini)
    raise RuntimeError(f"SAHAY_STT_MODE={mode!r} is not 'mock' or 'live'")
