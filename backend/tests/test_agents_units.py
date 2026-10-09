import pytest

from app.agents import pii
from app.agents.llm import MockLLM, build_llm
from app.agents.schemas import IntakeResult, PiiTag
from app.agents.search import MockSearch, build_search
from app.agents.stt import MockTranscriber, build_transcriber

llm = MockLLM()


# ---- PII ----------------------------------------------------------------------

@pytest.mark.parametrize("text,ptype,literal", [
    ("call me on 9876543210 please", "phone", "9876543210"),
    ("call +91 98765 43210 now", "phone", "+91 98765 43210"),
    ("number is 98765-43210", "phone", "98765-43210"),
    ("mail anu@example.com", "email", "anu@example.com"),
    ("aadhaar 1234 5678 9012 here", "aadhaar", "1234 5678 9012"),
    ("car KL 07 AB 1234 hit us", "plate", "KL 07 AB 1234"),
])
def test_regex_detection(text, ptype, literal):
    tags = pii.detect(text, llm)
    assert [(t.type, t.text) for t in tags] == [(ptype, literal)]
    assert text[tags[0].start:tags[0].end] == literal


def test_phone_not_double_tagged_as_aadhaar():
    tags = pii.detect("919876543210", llm)
    assert [t.type for t in tags] == ["phone"]


def test_name_from_llm_and_known_literals():
    text = "I am Anu Menon, my brother Ravi is hurt. Phone 9876543210"
    tags = pii.detect(text, llm, known=[("name", "Ravi")])
    assert {(t.type, t.text) for t in tags} == {("name", "Anu Menon"), ("name", "Ravi"), ("phone", "9876543210")}
    assert tags == sorted(tags, key=lambda t: t.start)


def test_hallucinated_offsets_are_dropped():
    class BadLLM(MockLLM):
        def tag_pii(self, text):
            return [PiiTag(type="name", text="Nobody", start=0, end=6)]

    assert pii.detect("fire at the market", BadLLM()) == []


def test_redact_replaces_spans_and_derived_text():
    text = "I am Anu Menon, call 9876543210"
    tags = pii.detect(text, llm)
    assert pii.redact(text, tags) == "I am [NAME], call [PHONE]"
    # derived text (summary) re-uses the transcript's tags and regexes
    assert pii.redact("Anu Menon asks for help, 9876543210", [], extra_literals=tags) == "[NAME] asks for help, [PHONE]"


def test_empty_text_has_no_tags():
    assert pii.detect("", llm) == []


# ---- MockLLM rules ------------------------------------------------------------

def test_intake_quick_tap_wins_unless_other():
    assert llm.intake("there is a fire", "accident", "en", "report").incident_type == "accident"
    assert llm.intake("there is a fire", "other", "en", "report").incident_type == "fire"
    assert llm.intake("nothing special", "other", "en", "report").incident_type == "other"


def test_intake_severity_people_hazards_confidence():
    r = llm.intake("three people injured, bleeding, live wire near the junction", "accident", "en", "report")
    assert r.people_count == 3 and "electric" in r.hazards and "traffic" in r.hazards
    assert r.severity == 5 and r.confidence == 0.8  # 3 base + bleeding + 3 people bump, capped at 5
    assert llm.intake(None, "crime", "en", "report").confidence == 0.5


def test_intake_sos_floor_and_bounds():
    assert llm.intake(None, "other", "en", "sos").severity == 4
    assert 1 <= llm.intake("x", "other", "en", "report").severity <= 5


def test_intake_handles_malayalam_and_hindi_keywords():
    assert llm.intake("തീ പിടിച്ചു", "other", "ml", "report").incident_type == "fire"
    assert llm.intake("दुर्घटना हो गई", "other", "hi", "report").incident_type == "accident"
    assert llm.intake("വെള്ളപ്പൊക്കം", "other", "ml", "report").incident_type == "flood"


def test_triage_maps_services_and_urgency():
    fire = llm.triage(IntakeResult(incident_type="fire", severity=4, summary="Fire incident", confidence=0.8), None)
    assert fire.needed_services == ["fire", "ambulance"] and fire.urgency_score == 0.8
    crime = llm.triage(IntakeResult(incident_type="crime", severity=3, summary="Crime incident: robbery", confidence=0.8), None)
    assert crime.needed_services == ["police"]
    other = llm.triage(IntakeResult(incident_type="other", severity=2, summary="Other incident reported.", confidence=0.5), None)
    assert other.needed_services == ["municipal"]
    flood = llm.triage(IntakeResult(incident_type="flood", severity=3, hazards=["water"], summary="Flood", confidence=0.8), "Water hazard")
    assert "municipal" in flood.needed_services and "Water hazard" in flood.reason


def test_triage_urgency_capped_at_one():
    r = llm.triage(IntakeResult(incident_type="fire", severity=5, hazards=["a", "b", "c"], summary="x", confidence=1), None)
    assert r.urgency_score == 1.0


# ---- seams --------------------------------------------------------------------

def test_builders_and_mock_seams(monkeypatch):
    from app.settings import settings

    monkeypatch.setattr(settings, "llm_api_key", "")  # live builders need keys; do not depend on backend/.env
    monkeypatch.setattr(settings, "sahay_web_search_key", "")
    assert isinstance(build_llm("mock"), MockLLM)
    assert isinstance(build_transcriber("mock"), MockTranscriber)
    assert isinstance(build_search("mock"), MockSearch)
    assert MockTranscriber().transcribe(b"x", "audio/webm", "ml") is None
    for builder in (build_llm, build_transcriber, build_search):
        with pytest.raises(RuntimeError):
            builder("live")
    s = MockSearch()
    assert "Gas hazard" in s.lookup("gas")
    assert "Electrical" in s.lookup("traffic electric")
    assert s.lookup("nothing relevant") is None
