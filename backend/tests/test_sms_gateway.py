"""SMS fallback (B-10): SAHAY1 line from the gateway becomes a minimal incident, once."""
import time

import pytest
from sqlalchemy import select

from app.agents.store import load_pii
from app.database import SessionLocal
from app.models import AuditEntry, Incident, Report
from app.sms_gateway import parse
from tests.test_pipeline_api import admin_headers, autorun  # noqa: F401  (autorun is a fixture)
from tests.test_reports_api import client

URL = "/api/v1/sms-gateway/inbound"
SECRET = "gw-secret-test"


@pytest.fixture()
def gateway(monkeypatch):
    from app import sms_gateway

    monkeypatch.setattr(sms_gateway.settings, "sahay_gateway_secret", SECRET)


def line(rid="a1b2c3d4", did="e5f6a7b8", cat="FI", ts=None, loc="9.93120,76.26730"):
    return f"SAHAY1|{rid}|{did}|{loc}|{cat}|{ts or int(time.time())}"


def post(body, secret=SECRET, sender="+919876543210"):
    headers = {"X-Gateway-Secret": secret} if secret is not None else {}
    return client.post(URL, headers=headers, json={"from": sender, "body": body})


def test_parse_valid_and_invalid_lines():
    assert parse(line())["code"] == "FI"
    assert parse(line(loc="-9.93120,176.26730"))["lng"] == 176.2673
    for bad in ["", "hello", line(cat="XX"), line(rid="zz"), line(loc="99.0,76.0"), line(loc="9.9,200.0"), line(ts="12")]:
        assert parse(bad) is None, bad


def test_disabled_without_a_secret_looks_like_no_route(monkeypatch):
    from app import sms_gateway

    monkeypatch.setattr(sms_gateway.settings, "sahay_gateway_secret", "")
    assert post(line()).status_code == 404


def test_wrong_or_missing_secret_is_401(gateway):
    assert post(line(), secret="nope").status_code == 401
    assert post(line(), secret=None).status_code == 401


def test_invalid_message_is_422_and_future_timestamp_too(gateway):
    assert post("SAHAY1|junk").status_code == 422
    assert post(line(ts=int(time.time()) + 5 * 24 * 3600)).status_code == 422


def test_sms_becomes_an_incident_with_the_number_sealed(gateway, autorun):  # noqa: F811
    admin_headers()
    r = post(line(rid="01020304", did="0a0b0c0d", cat="ME"))
    assert r.status_code == 202 and r.json() == {"report_id": "sms-01020304-0a0b0c0d", "status": "received", "duplicate": False}
    with SessionLocal() as db:
        report = db.get(Report, "sms-01020304-0a0b0c0d")
        assert report.kind == "report" and report.category == "medical" and report.incident_id
        incident = db.get(Incident, report.incident_id)
        assert incident.incident_type == "medical" and abs(incident.lat - 9.9312) < 1e-6 and abs(incident.lng - 76.2673) < 1e-6
        assert "Via SMS" in incident.reason
        assert "9876543210" not in incident.summary_redacted  # the sender's number never shows without a reveal
        assert b"9876543210" not in report.ciphertext
        assert load_pii(db, incident.incident_id)  # stored encrypted
        actions = [a.action for a in db.scalars(select(AuditEntry)).all()]
        assert "report.received" in actions


def test_same_sms_twice_is_one_report(gateway, autorun):  # noqa: F811
    admin_headers()
    first = post(line(rid="11111111", did="22222222"))
    again = post(line(rid="11111111", did="22222222"))
    assert first.status_code == 202 and again.status_code == 200 and again.json()["duplicate"] is True
    with SessionLocal() as db:
        assert len([r for r in db.scalars(select(Report)).all() if r.report_id == "sms-11111111-22222222"]) == 1


def test_sos_code_makes_an_sos_report(gateway, autorun):  # noqa: F811
    admin_headers()
    assert post(line(rid="33333333", did="44444444", cat="SO")).status_code == 202
    with SessionLocal() as db:
        report = db.get(Report, "sms-33333333-44444444")
        assert report.kind == "sos" and report.incident_id
        # SOS with no usable type needs the admin, like any SOS
        assert db.get(Incident, report.incident_id).status == "pending_approval"


def test_server_key_hands_the_app_the_gateway_number(monkeypatch):
    from app import keyring

    monkeypatch.setattr(keyring, "server_public_key_response", keyring.server_public_key_response)
    from app.settings import settings

    monkeypatch.setattr(settings, "sahay_gateway_number", "+15550001111")
    assert client.get("/api/v1/config/server-key").json()["gateway_number"] == "+15550001111"
    monkeypatch.setattr(settings, "sahay_gateway_number", "")
    assert "gateway_number" not in client.get("/api/v1/config/server-key").json()


def test_adb_gateway_row_pattern_keeps_the_comma_in_the_position():
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location("sms_gateway_adb", Path(__file__).resolve().parents[1] / "scripts" / "sms_gateway_adb.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    row = "Row: 0 address=+918848230516, body=SAHAY1|99cfb413|1b4c410e|11.32290,75.93433|OT|1791606952"
    m = mod.ROW.search(row)
    assert m["addr"] == "+918848230516" and m["body"] == "SAHAY1|99cfb413|1b4c410e|11.32290,75.93433|OT|1791606952"
    assert mod.ROW.search("Row: 1 address=AX-VAAHAN-S, body=PM-RAHAT: Cashless, treatment") is None


def test_sms_text_states_the_known_position(gateway, autorun):  # noqa: F811
    admin_headers()
    assert post(line(rid="55555555", did="66666666", loc="11.32290,75.93433")).status_code == 202
    from app.ingest import crypto
    from app.keyring import server_box_key

    with SessionLocal() as db:
        payload = crypto.decrypt_payload(db.get(Report, "sms-55555555-66666666").ciphertext, server_box_key())
    assert "coordinates 11.32290, 75.93433" in payload["text"] and "at the location" not in payload["text"]
