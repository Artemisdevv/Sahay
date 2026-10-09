"""Live speech-to-text adapters (B-05): Groq Whisper (OpenAI-compatible) and Cloudflare Workers AI.

Contract with the pipeline: `transcribe(audio, mime, language) -> str | None`. Any provider failure (network, HTTP
error, empty result) makes the adapter try the next provider; if all fail it raises `STTError` and the pipeline logs
"failed" and continues from the quick-tap category, so a report is never lost.

Provider names (SAHAY_STT_PROVIDERS, comma separated, tried left to right):
  groq:whisper-large-v3-turbo   groq:whisper-large-v3        needs STT_API_KEY (or LLM_API_KEY when LLM_PROVIDER=groq)
  cf:whisper-large-v3-turbo     needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN  (UNVERIFIED against the live API)

Privacy: audio is sent to the provider as-is (voice is personal data). The pipeline's PII step runs on the transcript
afterwards. Provider error bodies are never logged or put into exceptions (they may echo content).
"""
from __future__ import annotations

import base64
import mimetypes

import httpx

GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
CF_URL = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/openai/{model}"
# Report language codes we accept -> Whisper ISO-639-1 hints. Unknown/empty = let the model detect.
LANGS = {"en", "ml", "hi", "ta", "te", "kn", "bn", "mr", "gu", "pa", "ur"}


class STTError(RuntimeError):
    """Every configured provider failed or returned nothing usable."""


def _lang(language: str) -> str | None:
    code = (language or "").lower().split("-")[0]
    return code if code in LANGS else None


def _filename(mime: str) -> str:
    ext = (mimetypes.guess_extension((mime or "").split(";")[0].strip()) or "").lstrip(".")
    ext = {"oga": "ogg", "opus": "ogg"}.get(ext, ext)
    return f"audio.{ext or 'webm'}"


class GroqWhisper:
    def __init__(self, model: str, api_key: str, timeout_s: float = 20.0, client: httpx.Client | None = None):
        self.name = f"groq:{model}"
        self._model, self._key, self._timeout = model, api_key, timeout_s
        self._client = client

    def transcribe(self, audio: bytes, mime: str, language: str) -> str | None:
        data = {"model": self._model, "response_format": "json", "temperature": "0"}
        if (lang := _lang(language)) is not None:
            data["language"] = lang
        client = self._client or httpx.Client(timeout=self._timeout)
        try:
            r = client.post(GROQ_URL, headers={"Authorization": f"Bearer {self._key}"}, data=data,
                            files={"file": (_filename(mime), audio, (mime or "audio/webm").split(";")[0])})
            r.raise_for_status()
            text = r.json().get("text")
        except (httpx.HTTPError, ValueError) as exc:
            raise STTError(f"{self.name}: {type(exc).__name__}") from None
        return text.strip() if isinstance(text, str) and text.strip() else None


class CloudflareWhisper:
    def __init__(self, model: str, account: str, token: str, timeout_s: float = 20.0, client: httpx.Client | None = None):
        self.name = f"cf:{model}"
        self._url, self._token, self._timeout = CF_URL.format(account=account, model=model), token, timeout_s
        self._client = client

    def transcribe(self, audio: bytes, mime: str, language: str) -> str | None:
        body: dict = {"audio": base64.b64encode(audio).decode("ascii")}
        if (lang := _lang(language)) is not None:
            body["language"] = lang
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


def build_live(providers: str, groq_key: str, cf_account: str, cf_token: str, timeout_s: float) -> FailoverTranscriber:
    chain = []
    for item in (x.strip() for x in providers.split(",") if x.strip()):
        kind, _, model = item.partition(":")
        if kind == "groq" and model and groq_key:
            chain.append(GroqWhisper(model, groq_key, timeout_s))
        elif kind == "cf" and model and cf_account and cf_token:
            chain.append(CloudflareWhisper(model, cf_account, cf_token, timeout_s))
    if not chain:
        raise RuntimeError(
            "SAHAY_STT_MODE=live needs at least one usable provider in SAHAY_STT_PROVIDERS "
            "(groq:<model> with STT_API_KEY/LLM_API_KEY, or cf:<model> with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN)"
        )
    return FailoverTranscriber(chain)
