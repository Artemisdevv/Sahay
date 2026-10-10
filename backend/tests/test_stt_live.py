"""Live STT adapters against fake providers (httpx.MockTransport). No network, no key."""
import base64

import httpx
import pytest

from app.agents import stt_live
from app.agents.stt import MockTranscriber, build_transcriber
from app.agents.stt_live import CloudflareWhisper, FailoverTranscriber, GeminiAudio, GroqWhisper, STTError, build_live


def client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_groq_sends_file_model_language_and_returns_text(monkeypatch):
    monkeypatch.setenv("SAHAY_STT_LANGUAGE_HINT", "1")
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


def test_unknown_language_lets_the_model_detect(monkeypatch):
    monkeypatch.setenv("SAHAY_STT_LANGUAGE_HINT", "1")
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


def test_gemini_sends_inline_audio_and_joins_text_parts(monkeypatch):
    monkeypatch.setenv("SAHAY_STT_LANGUAGE_HINT", "1")
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["key"] = request.headers["x-goog-api-key"]
        seen["url"] = str(request.url)
        seen["json"] = request.read()
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "  ഹലോ "}, {"text": "ആംബുലൻസ്  "}]}}]})

    stt = GeminiAudio("gemini-2.5-flash", "g-test", client=client(handler))
    assert stt.transcribe(b"abc", "audio/ogg; codecs=opus", "ml") == "ഹലോ ആംബുലൻസ്"
    assert seen["key"] == "g-test" and "models/gemini-2.5-flash:generateContent" in seen["url"]
    assert base64.b64encode(b"abc") in seen["json"] and b'"audio/ogg"' in seen["json"]
    assert b"language code 'ml'" in seen["json"]


def test_gemini_failures_do_not_leak_and_blocked_answers_are_errors():
    with pytest.raises(STTError) as err:
        GeminiAudio("m", "k", client=client(lambda r: httpx.Response(400, text="secret echo"))).transcribe(b"x", "audio/webm", "en")
    assert "secret" not in str(err.value)
    with pytest.raises(STTError):  # safety block: no candidates
        GeminiAudio("m", "k", client=client(lambda r: httpx.Response(200, json={"promptFeedback": {}}))).transcribe(b"x", "audio/ogg", "en")
    assert GeminiAudio("m", "k", client=client(lambda r: httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": " "}]}}]}))).transcribe(b"x", "audio/ogg", "en") is None


def test_gemini_first_then_whisper_fallback_when_gemini_rejects_the_format():
    gem = GeminiAudio("m", "k", client=client(lambda r: httpx.Response(400)))
    groq = GroqWhisper("whisper-large-v3", "k", client=client(lambda r: httpx.Response(200, json={"text": "fallback text"})))
    chain = FailoverTranscriber([gem, groq])
    assert chain.transcribe(b"x", "audio/webm", "ml") == "fallback text"
    assert chain.last_provider == "groq:whisper-large-v3"
    built = build_live("gemini:gemini-2.5-flash,groq:whisper-large-v3", "gk", "", "", 5, gemini_key="gem")
    assert [p.name for p in built.providers] == ["gemini:gemini-2.5-flash", "groq:whisper-large-v3"]


def test_language_is_detected_by_the_model_by_default(monkeypatch):
    """The app language is not the spoken language, so no hint is sent unless SAHAY_STT_LANGUAGE_HINT=1."""
    monkeypatch.delenv("SAHAY_STT_LANGUAGE_HINT", raising=False)
    seen = {}

    def groq(request: httpx.Request) -> httpx.Response:
        seen["groq"] = request.read()
        return httpx.Response(200, json={"text": "x"})

    def gem(request: httpx.Request) -> httpx.Response:
        seen["gem"] = request.read()
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "x"}]}}]})

    GroqWhisper("m", "k", client=client(groq)).transcribe(b"a", "audio/webm", "en")
    GeminiAudio("m", "k", client=client(gem)).transcribe(b"a", "audio/webm", "en")
    assert b'name="language"' not in seen["groq"]
    assert b"language code" not in seen["gem"] and b"detect the language" in seen["gem"]
