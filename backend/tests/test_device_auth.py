import base64
import uuid

from fastapi.testclient import TestClient
from nacl.signing import SigningKey

from app.device_auth import ChallengeError, DeviceChallenges, signing_input
from app.main import app
from tests.device_helpers import challenge_for, register_device, sign_challenge

client = TestClient(app)


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def body(device_id, key, challenge, signature):
    return {
        "device_id": device_id, "ed25519_public_key": b64(bytes(key.verify_key)), "language": "ml",
        "challenge": challenge, "challenge_signature": signature,
    }


def test_register_with_proof_of_possession_returns_a_civilian_token():
    device_id, key = str(uuid.uuid4()), SigningKey.generate()
    r = register_device(client, device_id, key)
    assert r.status_code == 201, r.text
    assert r.json()["role"] == "civilian" and r.json()["device_id"] == device_id and r.json()["token"]


def test_registering_again_with_a_fresh_challenge_refreshes_the_token():
    device_id, key = str(uuid.uuid4()), SigningKey.generate()
    assert register_device(client, device_id, key).status_code == 201
    assert register_device(client, device_id, key).status_code == 201   # token refresh, same key


def test_public_key_alone_is_no_longer_enough():
    """The old request (device_id + public key only) must be rejected."""
    device_id, key = str(uuid.uuid4()), SigningKey.generate()
    r = client.post("/api/v1/auth/register-device",
                    json={"device_id": device_id, "ed25519_public_key": b64(bytes(key.verify_key)), "language": "ml"})
    assert r.status_code == 422


def test_someone_who_knows_the_public_key_cannot_get_the_devices_token():
    device_id, key = str(uuid.uuid4()), SigningKey.generate()
    assert register_device(client, device_id, key).status_code == 201
    attacker = SigningKey.generate()
    ch = challenge_for(client, device_id)
    # Attacker presents the victim's public key but can only sign with their own key.
    r = client.post("/api/v1/auth/register-device", json=body(device_id, key, ch, sign_challenge(attacker, device_id, ch)))
    assert r.status_code == 401 and "possession" in r.json()["error"]["message"]


def test_existing_device_cannot_be_taken_over_with_a_different_key():
    device_id, key = str(uuid.uuid4()), SigningKey.generate()
    assert register_device(client, device_id, key).status_code == 201
    thief = SigningKey.generate()
    assert register_device(client, device_id, thief).status_code == 409   # valid proof, but not the registered key


def test_challenge_is_single_use():
    device_id, key = str(uuid.uuid4()), SigningKey.generate()
    ch = challenge_for(client, device_id)
    payload = body(device_id, key, ch, sign_challenge(key, device_id, ch))
    assert client.post("/api/v1/auth/register-device", json=payload).status_code == 201
    assert client.post("/api/v1/auth/register-device", json=payload).status_code == 401   # replay


def test_challenge_is_bound_to_one_device_id():
    a, b, key = str(uuid.uuid4()), str(uuid.uuid4()), SigningKey.generate()
    ch = challenge_for(client, a)                                       # issued for device a
    r = client.post("/api/v1/auth/register-device", json=body(b, key, ch, sign_challenge(key, b, ch)))
    assert r.status_code == 401 and "Challenge" in r.json()["error"]["message"]


def test_tampered_or_made_up_challenges_are_rejected():
    device_id, key = str(uuid.uuid4()), SigningKey.generate()
    ch = challenge_for(client, device_id)
    for bad in (ch[:-2] + "xx", "v1.9999999999.AAAA.BBBB", "garbage-challenge", ch.replace("v1.", "v2.", 1)):
        r = client.post("/api/v1/auth/register-device", json=body(device_id, key, bad, sign_challenge(key, device_id, bad)))
        assert r.status_code == 401, bad


def test_challenge_expires():
    clock = [1_000_000.0]
    chal = DeviceChallenges("secret", now=lambda: clock[0])
    key, device_id = SigningKey.generate(), str(uuid.uuid4())
    token = chal.issue(device_id)["challenge"]
    clock[0] += 61
    try:
        chal.verify(device_id, b64(bytes(key.verify_key)), token, b64(key.sign(signing_input(device_id, token)).signature))
        raise AssertionError("expired challenge accepted")
    except ChallengeError as exc:
        assert exc.code == "invalid_challenge"


def test_a_bad_proof_does_not_burn_the_real_devices_challenge():
    chal = DeviceChallenges("secret")
    key, device_id = SigningKey.generate(), str(uuid.uuid4())
    token = chal.issue(device_id)["challenge"]
    junk = b64(bytes(64))
    try:
        chal.verify(device_id, b64(bytes(key.verify_key)), token, junk)
    except ChallengeError as exc:
        assert exc.code == "invalid_proof"
    chal.verify(device_id, b64(bytes(key.verify_key)), token, b64(key.sign(signing_input(device_id, token)).signature))


def test_challenge_endpoint_validates_the_device_id():
    assert client.post("/api/v1/auth/device-challenge", json={"device_id": "not-a-uuid"}).status_code == 422
    assert client.post("/api/v1/auth/device-challenge", json={}).status_code == 422
