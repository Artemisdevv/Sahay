"""The caller's original voice message is kept (encrypted) and the admin can replay it after a logged reveal."""
import base64
import os

import pytest
from sqlalchemy import select

from app.database import SessionLocal
from app.models import AuditEntry, IncidentAudio, Report
from tests.test_pipeline_api import admin_headers, autorun  # noqa: F401  (autorun is a fixture)
from tests.test_reports_api import PAYLOAD, Dev, client, post

AUDIO = os.urandom(3000)  # stands in for an Opus clip
AUDIO_B64 = base64.b64encode(AUDIO).decode()


def voice_report(dev, **extra):
    payload = {**PAYLOAD, "text": None, "audio": {"mime": "audio/webm;codecs=opus", "data": AUDIO_B64, "duration_s": 5}, **extra}
    env = dev.envelope(payload)
    assert post(env, dev).status_code == 202
    with SessionLocal() as db:
        return env["report_id"], db.get(Report, env["report_id"]).incident_id


def reveal(headers, incident_id, reason="checking the transcript"):
    r = client.post(f"/api/v1/incidents/{incident_id}/reveal", headers=headers, json={"reason": reason})
    assert r.status_code == 200, r.text
    return r.json()


def test_audio_is_stored_encrypted_not_as_plain_bytes(autorun):  # noqa: F811
    admin_headers()
    report_id, incident_id = voice_report(Dev())
    with SessionLocal() as db:
        row = db.scalars(select(IncidentAudio).where(IncidentAudio.report_id == report_id)).one()
        assert row.incident_id == incident_id and row.mime.startswith("audio/webm")
        assert AUDIO not in row.audio_ciphertext and AUDIO_B64.encode() not in row.audio_ciphertext


def test_admin_replays_the_original_audio_only_after_a_reveal_and_it_is_audited(autorun):  # noqa: F811
    h = admin_headers()
    report_id, incident_id = voice_report(Dev())
    url = f"/api/v1/incidents/{incident_id}/audio/{report_id}"
    assert client.get(url, headers=h).status_code == 403  # no reveal yet
    body = reveal(h, incident_id)
    assert body["audio_url"] == url and body["audio"] == [{"report_id": report_id, "mime": "audio/webm", "url": url}]
    played = client.get(url, headers=h)
    assert played.status_code == 200 and played.content == AUDIO
    assert played.headers["cache-control"] == "no-store" and played.headers["content-type"].startswith("audio/webm")
    with SessionLocal() as db:
        plays = [r for r in db.scalars(select(AuditEntry)).all() if r.action == "pii.audio.play"]
        assert plays and plays[-1].details["report_id"] == report_id and plays[-1].actor["id"] == "admin"


def test_service_and_anonymous_cannot_get_the_audio(autorun):  # noqa: F811
    h = admin_headers()
    report_id, incident_id = voice_report(Dev())
    reveal(h, incident_id)
    url = f"/api/v1/incidents/{incident_id}/audio/{report_id}"
    assert client.get(url).status_code == 401
    svc = client.post("/api/v1/auth/login", json={"username": "amb-01", "password": "demo123"}).json()["token"]
    assert client.get(url, headers={"Authorization": f"Bearer {svc}"}).status_code == 403


def test_another_admin_session_needs_its_own_reveal(autorun):  # noqa: F811
    h = admin_headers()
    report_id, incident_id = voice_report(Dev())
    other = incident_id[::-1]  # a different incident id the admin has not revealed
    assert client.get(f"/api/v1/incidents/{other}/audio/{report_id}", headers=h).status_code == 403
    reveal(h, incident_id)
    assert client.get(f"/api/v1/incidents/{incident_id}/audio/{report_id}", headers=h).status_code == 200


def test_text_only_reports_have_no_audio(autorun):  # noqa: F811
    h = admin_headers()
    d = Dev()
    env = d.envelope()
    post(env, d)
    with SessionLocal() as db:
        incident_id = db.get(Report, env["report_id"]).incident_id
    body = reveal(h, incident_id)
    assert body["audio"] == []
    assert client.get(f"/api/v1/incidents/{incident_id}/audio/{env['report_id']}", headers=h).status_code == 404


def test_missing_audio_for_a_known_report_is_404_after_reveal(autorun):  # noqa: F811
    h = admin_headers()
    report_id, incident_id = voice_report(Dev())
    reveal(h, incident_id)
    assert client.get(f"/api/v1/incidents/{incident_id}/audio/not-a-report", headers=h).status_code == 404


def test_hostile_mime_type_is_never_stored_or_served(autorun):  # noqa: F811
    h = admin_headers()
    payload = {**PAYLOAD, "text": None, "audio": {"mime": "text/html", "data": AUDIO_B64, "duration_s": 5}}
    d = Dev()
    env = d.envelope(payload)
    assert post(env, d).status_code == 202
    with SessionLocal() as db:
        incident_id = db.get(Report, env["report_id"]).incident_id
        assert db.scalars(select(IncidentAudio).where(IncidentAudio.report_id == env["report_id"])).one().mime == "audio/webm"
    reveal(h, incident_id)
    played = client.get(f"/api/v1/incidents/{incident_id}/audio/{env['report_id']}", headers=h)
    assert played.status_code == 200 and played.headers["content-type"].startswith("audio/webm")
    assert played.headers["x-content-type-options"] == "nosniff"
    assert played.headers["content-disposition"] == "attachment"
    assert "sandbox" in played.headers["content-security-policy"]
