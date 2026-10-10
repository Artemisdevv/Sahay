"""Live speech-to-text adapters (B-05): Gemini audio, Groq Whisper (OpenAI-compatible) and Cloudflare Workers AI.

Contract with the pipeline: `transcribe(audio, mime, language) -> str | None`. Any provider failure (network, HTTP
error, empty result) makes the adapter try the next provider; if all fail it raises `STTError` and the pipeline logs
"failed" and continues from the quick-tap category, so a report is never lost.

Provider names (SAHAY_STT_PROVIDERS, comma separated, tried left to right):
  gemini:gemini-2.5-flash       needs LLM_API_KEY_GEMINI. Best on Malayalam (docs/stt-eval.md). Free-tier keys may let Google
                                use the audio to improve products: use a paid key for real reports.
  groq:whisper-large-v3         needs LLM_API_KEY with LLM_PROVIDER=groq
  cf:whisper-large-v3-turbo     Cloudflare Workers AI: needs CLOUDFLARE_ACCOUNT_ID and a token in CLOUDFLARE_API_TOKEN or STT_API_KEY

Privacy: audio is sent to the provider as-is (voice is personal data). The pipeline's PII step runs on the transcript
afterwards. Provider error bodies are never logged or put into exceptions (they may echo content).
"""
from __future__ import annotations

import base64
import os
import mimetypes

import httpx

GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GEMINI_PROMPT = (
    "Transcribe this emergency call exactly as spoken, in the original language and script "
    "(Malayalam script for Malayalam, Devanagari for Hindi, Tamil script for Tamil). The speaker may use Malayalam, "
    "Hindi, Tamil, English or a mix: detect the language from the audio. Do not translate, summarise or add anything. "
    "Output only the transcript, or an empty reply if there is no speech."
)
CF_URL = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/openai/{model}"
# Report language codes we accept -> Whisper ISO-639-1 hints. Unknown/empty = let the model detect.
LANGS = {"en", "ml", "hi", "ta", "te", "kn", "bn", "mr", "gu", "pa", "ur"}


class STTError(RuntimeError):
    """Every configured provider failed or returned nothing usable."""


def _lang(language: str) -> str | None:
    """The reporter's app language as a model hint, or None to let the model detect it from the audio.

    Off by default (SAHAY_STT_LANGUAGE_HINT=1 turns it on): the app language is not the spoken language. A Malayalam
    speaker with the app in English made the model loop on English filler instead of reading the Malayalam.
    """
    if os.environ.get("SAHAY_STT_LANGUAGE_HINT", "0") != "1":
        return None
    code = (language or "").lower().split("-")[0]
    return code if code in LANGS else None


def _filename(mime: str) -> str:
    ext = (mimetypes.guess_extension((mime or "").split(";")[0].strip()) or "").lstrip(".")
    ext = {"oga": "ogg", "opus": "ogg"}.get(ext, ext)
    return f"audio.{ext or 'webm'}"


class GroqWhisper:
    def __init__(self, model: str, api_key: str, timeout_s: float = 20.0, client: httpx.Client | None = None, prompt: str = ""):
        self.name = f"groq:{model}"
        self._model, self._key, self._timeout, self._prompt = model, api_key, timeout_s, prompt
        self._client = client

    def transcribe(self, audio: bytes, mime: str, language: str) -> str | None:
        data = {"model": self._model, "response_format": "json", "temperature": "0"}
        if (lang := _lang(language)) is not None:
            data["language"] = lang
        if self._prompt:
            data["prompt"] = self._prompt
        client = self._client or httpx.Client(timeout=self._timeout)
        try:
            r = client.post(GROQ_URL, headers={"Authorization": f"Bearer {self._key}"}, data=data,
                            files={"file": (_filename(mime), audio, (mime or "audio/webm").split(";")[0])})
            r.raise_for_status()
            text = r.json().get("text")
        except (httpx.HTTPError, ValueError) as exc:
            raise STTError(f"{self.name}: {type(exc).__name__}") from None
        return text.strip() if isinstance(text, str) and text.strip() else None


class GeminiAudio:
    """Gemini audio understanding used as a transcriber (inline audio, up to 20 MB; reports are capped at 200 KB)."""

    def __init__(self, model: str, api_key: str, timeout_s: float = 30.0, client: httpx.Client | None = None):
        self.name = f"gemini:{model}"
        self._url, self._key, self._timeout, self._client = GEMINI_URL.format(model=model), api_key, timeout_s, client

    def transcribe(self, audio: bytes, mime: str, language: str) -> str | None:
        mime_base = (mime or "audio/ogg").split(";")[0].strip() or "audio/ogg"
        hint = (
            f" The reporter's app is set to language code '{lang}', but the speaker may use English, Malayalam, Hindi "
            "or Tamil: decide the language from the audio itself, not from this hint."
        ) if (lang := _lang(language)) else ""
        body = {
            "contents": [{"parts": [
                {"text": GEMINI_PROMPT + hint},
                {"inline_data": {"mime_type": mime_base, "data": base64.b64encode(audio).decode("ascii")}},
            ]}],
            "generationConfig": {"temperature": 0},
        }
        client = self._client or httpx.Client(timeout=self._timeout)
        try:
            r = client.post(self._url, headers={"x-goog-api-key": self._key}, json=body)
            r.raise_for_status()
            parts = r.json()["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts)
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
            raise STTError(f"{self.name}: {type(exc).__name__}") from None
        return text.strip() or None


class CloudflareWhisper:
    def __init__(self, model: str, account: str, token: str, timeout_s: float = 20.0, client: httpx.Client | None = None, prompt: str = ""):
        self.name = f"cf:{model}"
        self._url, self._token, self._timeout = CF_URL.format(account=account, model=model), token, timeout_s
        self._client, self._prompt = client, prompt

    def transcribe(self, audio: bytes, mime: str, language: str) -> str | None:
        body: dict = {"audio": base64.b64encode(audio).decode("ascii")}
        if (lang := _lang(language)) is not None:
            body["language"] = lang
        if self._prompt:
            body["initial_prompt"] = self._prompt
        client = self._client or httpx.Client(timeout=self._timeout)
        try:
            r = client.post(self._url, headers={"Authorization": f"Bearer {self._token}"}, json=body)
            r.raise_for_status()
            text = (r.json().get("result") or {}).get("text")
        except (httpx.HTTPError, ValueError, AttributeError) as exc:
            raise STTError(f"{self.name}: {type(exc).__name__}") from None
        return text.strip() if isinstance(text, str) and text.strip() else None


class FailoverTranscriber:
    """Tries each provider in order. Returns the first non-empty transcript; None only if every provider answered empty."""

    def __init__(self, providers: list):
        if not providers:
            raise RuntimeError("no STT provider is configured")
        self.providers = providers
        self.last_provider: str | None = None

    def transcribe(self, audio: bytes, mime: str, language: str) -> str | None:
        failures: list[str] = []
        answered_empty = False
        for p in self.providers:
            try:
                text = p.transcribe(audio, mime, language)
            except STTError as exc:
                failures.append(str(exc))
                continue
            if text:
                self.last_provider = p.name
                return text
            answered_empty = True
        if answered_empty:
            return None
        raise STTError("; ".join(failures))


def build_live(providers: str, groq_key: str, cf_account: str, cf_token: str, timeout_s: float, prompt: str = "", gemini_key: str = "") -> FailoverTranscriber:
    chain = []
    for item in (x.strip() for x in providers.split(",") if x.strip()):
        kind, _, model = item.partition(":")
        if kind == "gemini" and model and gemini_key:
            chain.append(GeminiAudio(model, gemini_key, max(timeout_s, 30.0)))
        elif kind == "groq" and model and groq_key:
            chain.append(GroqWhisper(model, groq_key, timeout_s, prompt=prompt))
        elif kind == "cf" and model and cf_account and cf_token:
            chain.append(CloudflareWhisper(model, cf_account, cf_token, timeout_s, prompt=prompt))
    if not chain:
        raise RuntimeError(
            "SAHAY_STT_MODE=live needs at least one usable provider in SAHAY_STT_PROVIDERS "
            "(gemini:<model> with LLM_API_KEY_GEMINI, groq:<model> with LLM_API_KEY and LLM_PROVIDER=groq, or cf:<model> with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN or STT_API_KEY)"
        )
    return FailoverTranscriber(chain)
