import json
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from nacl.public import PublicKey, SealedBox
from nacl.signing import SigningKey

from app.ingest import crypto as c
from app.main import app

VECTOR = json.loads((Path(__file__).resolve().parents[2] / "contract" / "crypto-test-vector.json").read_text(encoding="utf-8"))
SERVER_BOX_PUB = PublicKey(c.b64d(VECTOR["server"]["box_public_key"], "k"))

client = TestClient(app)

PAYLOAD = {
    "schema": 1, "kind": "report", "category": "accident", "language": "ml",
    "captured_at": "2026-10-09T10:15:00Z",
    "location": {"lat": 9.9312, "lng": 76.2673, "accuracy_m": 12},
    "text": "two cars collided near the junction",
}


class Dev:
    """A registered civilian device with its own key and token."""

    def __init__(self):
        self.id = str(uuid.uuid4())
        self.key = SigningKey.generate()
        r = client.post("/api/v1/auth/register-device", json={
            "device_id": self.id, "ed25519_public_key": c.b64e(bytes(self.key.verify_key)), "language": "ml",
        })
        assert r.status_code == 201, r.text
        self.token = r.json()["token"]

    @property
    def auth(self):
        return {"Authorization": f"Bearer {self.token}"}

    def envelope(self, payload=None, report_id=None, **over):
        ct = SealedBox(SERVER_BOX_PUB).encrypt(json.dumps(payload or PAYLOAD).encode())
        env = {
            "envelope_version": 1, "report_id": report_id or str(uuid.uuid4()), "device_id": self.id,
            "created_at": "2026-10-09T10:15:00Z", "ttl": 5, "key_id": "k1", "ciphertext": c.b64e(ct),
        }
        env.update(over)
        env["signature"] = c.sign_envelope(env, self.key)
        return env


def post(env, dev):
    return client.post("/api/v1/reports", json=env, headers=dev.auth)


def admin_token():
    client.post("/api/v1/dev/seed")
    return client.post("/api/v1/auth/login", json={"username": "admin", "password": "admin123"}).json()["token"]


def test_happy_path_and_receipt_verifies_against_published_key():
    d = Dev()
    env = d.envelope()
    r = post(env, d)
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["report_id"] == env["report_id"] and body["status"] == "received"
    pub = client.get("/api/v1/config/server-key").json()["ed25519_public_key"]
    assert c.verify_receipt(env["report_id"], body["receipt"], pub)


def test_replay_returns_200_same_receipt_even_if_ttl_hops_change():
    d = Dev()
    env = d.envelope()
    first = post(env, d)
    again = post({**env, "ttl": 1, "hops": 3}, d)
    assert first.status_code == 202 and again.status_code == 200
    assert again.json()["receipt"] == first.json()["receipt"]
    assert len(client.get("/api/v1/reports/mine", headers=d.auth).json()["reports"]) == 1


def test_same_report_id_different_content_is_409():
    d = Dev()
    rid = str(uuid.uuid4())
    assert post(d.envelope(report_id=rid), d).status_code == 202
    r = post(d.envelope(report_id=rid), d)  # fresh ciphertext, same id
    assert r.status_code == 409 and r.json()["error"]["code"] == "conflict"


def test_bad_signature_is_422_invalid_signature():
    d = Dev()
    env = d.envelope()
    r = post({**env, "created_at": "2026-10-09T10:16:00Z"}, d)
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_signature"


def test_unknown_device_is_422():
    d, stranger = Dev(), Dev()
    env = stranger.envelope(device_id=str(uuid.uuid4()))  # signed by key nobody registered under this id
    r = post(env, d)
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_signature"


def test_relay_uploads_for_other_device_and_owner_sees_it():
    author, relay = Dev(), Dev()
    env = author.envelope()
    assert post(env, relay).status_code == 202
    mine = client.get("/api/v1/reports/mine", headers=author.auth).json()["reports"]
    assert [x["report_id"] for x in mine] == [env["report_id"]]
    assert client.get("/api/v1/reports/mine", headers=relay.auth).json()["reports"] == []


def test_status_only_for_owner():
    author, other = Dev(), Dev()
    env = author.envelope()
    post(env, author)
    ok = client.get(f"/api/v1/reports/{env['report_id']}/status", headers=author.auth)
    assert ok.status_code == 200 and ok.json()["status"] == "received" and ok.json()["eta_minutes"] is None
    assert client.get(f"/api/v1/reports/{env['report_id']}/status", headers=other.auth).status_code == 404


def test_auth_required_and_civilian_only():
    d = Dev()
    env = d.envelope()
    assert client.post("/api/v1/reports", json=env).status_code == 401
    r = client.post("/api/v1/reports", json=env, headers={"Authorization": f"Bearer {admin_token()}"})
    assert r.status_code == 403


def test_audio_over_cap_is_413():
    d = Dev()
    big = {**PAYLOAD, "audio": {"mime": "audio/webm", "data": c.b64e(b"\0" * (c.MAX_AUDIO_BYTES + 1)), "duration_s": 30}}
    r = post(d.envelope(big), d)
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"


def test_oversize_body_is_413():
    d = Dev()
    r = client.post("/api/v1/reports", content=b"x" * (700 * 1024), headers={**d.auth, "Content-Type": "application/json"})
    assert r.status_code == 413


@pytest.mark.parametrize("body", [b"not json", b"[]", b"{}"])
def test_garbage_body_is_400(body):
    d = Dev()
    r = client.post("/api/v1/reports", content=body, headers={**d.auth, "Content-Type": "application/json"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_request"


def test_stored_row_holds_only_ciphertext_not_plaintext():
    from app.database import SessionLocal
    from app.models import Report

    d = Dev()
    env = d.envelope()
    post(env, d)
    with SessionLocal() as db:
        row = db.get(Report, env["report_id"])
        assert b"collided" not in row.ciphertext
        assert row.category == "accident" and row.kind == "report"
