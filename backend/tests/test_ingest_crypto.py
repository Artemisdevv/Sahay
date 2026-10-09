import json
from pathlib import Path

import pytest
from nacl.public import PrivateKey, SealedBox
from nacl.signing import SigningKey

from app.ingest import crypto as c

VECTOR = json.loads((Path(__file__).resolve().parents[2] / "contract" / "crypto-test-vector.json").read_text(encoding="utf-8"))


def box_key() -> PrivateKey:
    return PrivateKey(c.b64d(VECTOR["server"]["box_secret_key"], "k"))


def make_env(payload: dict | None = None, device: SigningKey | None = None, server: PrivateKey | None = None) -> tuple[dict, SigningKey, PrivateKey]:
    device = device or SigningKey.generate()
    server = server or PrivateKey.generate()
    payload = payload or {
        "schema": 1, "kind": "report", "category": "fire",
        "location": {"lat": 9.93, "lng": 76.26}, "text": "smoke from building",
    }
    ct = SealedBox(server.public_key).encrypt(json.dumps(payload).encode())
    env = {
        "envelope_version": 1, "report_id": "r1", "device_id": "d1",
        "created_at": "2026-10-09T10:15:00Z", "ttl": 5, "key_id": "k1", "ciphertext": c.b64e(ct),
    }
    env["signature"] = c.sign_envelope(env, device)
    return env, device, server


def pub(sk: SigningKey) -> str:
    return c.b64e(bytes(sk.verify_key))


def code(fn, *a):
    with pytest.raises(c.IngestError) as e:
        fn(*a)
    return e.value.code


# ---- shared test vector (X-02) -----------------------------------------

def test_vector_signature_verifies_and_decrypts():
    env = VECTOR["envelope"]
    opened = c.open_envelope(env, VECTOR["device"]["public_key"], box_key())
    assert json.dumps(opened.payload, separators=(",", ":"), ensure_ascii=False) == VECTOR["plaintext_json"]


def test_vector_signature_is_deterministic_from_seed():
    dev = SigningKey(c.b64d(VECTOR["device"]["signing_seed"], "s"))
    assert c.sign_envelope(VECTOR["envelope"], dev) == VECTOR["envelope"]["signature"]
    ct = c.b64d(VECTOR["envelope"]["ciphertext"], "ct")
    e = VECTOR["envelope"]
    assert c.b64e(c.signing_input(e["report_id"], e["device_id"], e["created_at"], ct)) == VECTOR["signing_input_b64"]


def test_vector_receipt_verifies():
    r = VECTOR["receipt"]
    assert c.verify_receipt(r["report_id"], r, VECTOR["server"]["verify_key"])
    assert not c.verify_receipt("other-id", r, VECTOR["server"]["verify_key"])


@pytest.mark.parametrize("name", list(VECTOR["negative"]))
def test_vector_negative_cases_rejected(name):
    case = VECTOR["negative"][name]
    assert code(c.open_envelope, case["envelope"], VECTOR["device"]["public_key"], box_key()) == case["expect"]


def test_vector_ttl_and_hops_are_unsigned():
    env = {**VECTOR["envelope"], "ttl": 1, "hops": 4}
    c.open_envelope(env, VECTOR["device"]["public_key"], box_key())


# ---- signature verification --------------------------------------------

def test_valid_roundtrip():
    env, dev, srv = make_env()
    assert c.open_envelope(env, pub(dev), srv).payload["category"] == "fire"


def test_wrong_device_key_rejected():
    env, _, srv = make_env()
    assert code(c.open_envelope, env, pub(SigningKey.generate()), srv) == "invalid_signature"


@pytest.mark.parametrize("field,value", [
    ("report_id", "r2"), ("device_id", "d2"), ("created_at", "2026-10-09T10:15:01Z"),
])
def test_signed_fields_tamper_rejected(field, value):
    env, dev, srv = make_env()
    assert code(c.open_envelope, {**env, field: value}, pub(dev), srv) == "invalid_signature"


def test_ciphertext_tamper_rejected_before_decrypt():
    env, dev, srv = make_env()
    raw = bytearray(c.b64d(env["ciphertext"], "ct"))
    raw[0] ^= 1
    assert code(c.open_envelope, {**env, "ciphertext": c.b64e(bytes(raw))}, pub(dev), srv) == "invalid_signature"


def test_pipe_in_ids_rejected_to_prevent_field_smuggling():
    env, dev, srv = make_env()
    assert code(c.open_envelope, {**env, "report_id": "a|b"}, pub(dev), srv) == "bad_request"


def test_missing_field_and_bad_base64():
    env, dev, srv = make_env()
    assert code(c.open_envelope, {k: v for k, v in env.items() if k != "signature"}, pub(dev), srv) == "bad_request"
    assert code(c.open_envelope, {**env, "ciphertext": "***"}, pub(dev), srv) == "bad_request"
    assert code(c.open_envelope, {**env, "envelope_version": 2}, pub(dev), srv) == "bad_request"


def test_signature_wrong_length_is_invalid_signature():
    env, dev, srv = make_env()
    assert code(c.open_envelope, {**env, "signature": c.b64e(b"x" * 63)}, pub(dev), srv) == "invalid_signature"


def test_oversize_ciphertext_413():
    env, dev, srv = make_env()
    big = {**env, "ciphertext": c.b64e(b"\0" * (c.MAX_CIPHERTEXT_BYTES + 1))}
    big["signature"] = c.sign_envelope(big, dev)
    assert code(c.open_envelope, big, pub(dev), srv) == "too_large"


# ---- decrypt + payload validation --------------------------------------

def test_wrong_server_key_cannot_decrypt():
    env, dev, _ = make_env()
    assert code(c.open_envelope, env, pub(dev), PrivateKey.generate()) == "bad_request"


def test_audio_cap_413():
    audio = {"mime": "audio/webm", "data": c.b64e(b"\0" * (c.MAX_AUDIO_BYTES + 1))}
    payload = {"schema": 1, "kind": "report", "category": "other", "location": {"lat": 1, "lng": 1}, "audio": audio}
    env, dev, srv = make_env(payload)
    assert code(c.open_envelope, env, pub(dev), srv) == "too_large"


def test_audio_exactly_at_cap_ok():
    audio = {"mime": "audio/webm", "data": c.b64e(b"\0" * c.MAX_AUDIO_BYTES)}
    payload = {"schema": 1, "kind": "sos", "category": "other", "location": {"lat": 1, "lng": 1}, "audio": audio}
    env, dev, srv = make_env(payload)
    assert c.open_envelope(env, pub(dev), srv).payload["kind"] == "sos"


@pytest.mark.parametrize("patch", [
    {"schema": 2}, {"kind": "chat"}, {"category": "zombie"}, {"location": None},
    {"location": {"lat": 91, "lng": 0}}, {"location": {"lat": "9", "lng": 0}},
    {"text": None},  # no audio and no text
])
def test_invalid_payloads_rejected(patch):
    base = {"schema": 1, "kind": "report", "category": "fire", "location": {"lat": 9.9, "lng": 76.2}, "text": "x"}
    env, dev, srv = make_env({**base, **patch})
    assert code(c.open_envelope, env, pub(dev), srv) == "bad_request"


# ---- receipt ------------------------------------------------------------

def test_receipt_roundtrip_and_tamper():
    sk = SigningKey.generate()
    r = c.make_receipt("rid", "2026-10-09T10:15:02Z", sk)
    assert c.verify_receipt("rid", r, pub(sk))
    assert not c.verify_receipt("rid", {**r, "server_time": "2026-10-09T10:15:03Z"}, pub(sk))
    assert not c.verify_receipt("rid", r, pub(SigningKey.generate()))
