"""Live STT adapters against fake providers (httpx.MockTransport). No network, no key."""
import base64

import httpx
import pytest

from app.agents import stt_live
from app.agents.stt import MockTranscriber, build_transcriber
from app.agents.stt_live import CloudflareWhisper, FailoverTranscriber, GroqWhisper, STTError, build_live


def client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_groq_sends_file_model_language_and_returns_text():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["authorization"]
        seen["body"] = request.read()
        return httpx.Response(200, json={"text": "  തീ പിടിച്ചു  "})

    stt = GroqWhisper("whisper-large-v3", "k-test", client=client(handler))
    assert stt.transcribe(b"OPUSDATA", "audio/ogg; codecs=opus", "ml-IN") == "തീ പിടിച്ചു"
    body = seen["body"]
    assert seen["auth"] == "Bearer k-test"
    assert b'name="model"' in body and b"whisper-large-v3" in body
    assert b'name="language"' in body and b"\r\n\r\nml\r\n" in body
    assert b'filename="audio.ogg"' in body and b"OPUSDATA" in body


def test_unknown_language_lets_the_model_detect():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read()
        return httpx.Response(200, json={"text": "hello"})

    GroqWhisper("m", "k", client=client(handler)).transcribe(b"x", "audio/webm", "xx")
    assert b'name="language"' not in captured["body"]


def test_http_error_raises_without_leaking_the_body():
    stt = GroqWhisper("m", "k", client=client(lambda r: httpx.Response(500, text="secret transcript echo")))
    with pytest.raises(STTError) as err:
        stt.transcribe(b"x", "audio/webm", "en")
    assert "secret" not in str(err.value)


def test_cloudflare_wraps_audio_as_base64_and_reads_result_text():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["json"] = request.read()
        return httpx.Response(200, json={"result": {"text": "help"}})

    stt = CloudflareWhisper("whisper-large-v3-turbo", "acct", "tok", client=client(handler))
    assert stt.transcribe(b"abc", "audio/webm", "hi") == "help"
    assert "/accounts/acct/ai/run/@cf/openai/whisper-large-v3-turbo" in seen["url"]
    assert base64.b64encode(b"abc") in seen["json"]


def test_failover_uses_next_provider_and_remembers_which_answered():
    bad = GroqWhisper("a", "k", client=client(lambda r: httpx.Response(429)))
    good = GroqWhisper("b", "k", client=client(lambda r: httpx.Response(200, json={"text": "ok"})))
    chain = FailoverTranscriber([bad, good])
    assert chain.transcribe(b"x", "audio/webm", "en") == "ok"
    assert chain.last_provider == "groq:b"


def test_all_failing_raises_and_empty_answers_return_none():
    bad = GroqWhisper("a", "k", client=client(lambda r: httpx.Response(503)))
    with pytest.raises(STTError):
        FailoverTranscriber([bad, bad]).transcribe(b"x", "audio/webm", "en")
    empty = GroqWhisper("a", "k", client=client(lambda r: httpx.Response(200, json={"text": "   "})))
    assert FailoverTranscriber([empty]).transcribe(b"x", "audio/webm", "en") is None


def test_build_live_skips_providers_without_credentials_and_fails_clearly_when_none_usable():
    chain = build_live("cf:whisper-large-v3-turbo, groq:whisper-large-v3", "gkey", "", "", 5)
    assert [p.name for p in chain.providers] == ["groq:whisper-large-v3"]
    with pytest.raises(RuntimeError, match="at least one usable provider"):
        build_live("groq:whisper-large-v3", "", "", "", 5)
    with pytest.raises(RuntimeError, match="at least one usable provider"):
        build_live("whisper-large-v3-turbo,nova-3", "gkey", "a", "t", 5)  # old unprefixed names


def test_build_transcriber_modes(monkeypatch):
    assert isinstance(build_transcriber("mock"), MockTranscriber)
    with pytest.raises(RuntimeError, match="not 'mock' or 'live'"):
        build_transcriber("bogus")
    monkeypatch.setattr("app.settings.settings.sahay_stt_providers", "groq:whisper-large-v3-turbo")
    monkeypatch.setattr("app.settings.settings.stt_api_key", "")
    monkeypatch.setattr("app.settings.settings.llm_provider", "groq")
    monkeypatch.setattr("app.settings.settings.llm_api_key", "from-llm")
    assert build_transcriber("live").providers[0].name == "groq:whisper-large-v3-turbo"
    assert stt_live.FailoverTranscriber  # module import sanity
