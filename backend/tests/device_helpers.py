"""Register a civilian device the way the app does: fetch a challenge, sign it, post the proof."""
from __future__ import annotations

import base64

from nacl.signing import SigningKey

from app.device_auth import signing_input


def challenge_for(client, device_id: str) -> str:
    r = client.post("/api/v1/auth/device-challenge", json={"device_id": device_id})
    assert r.status_code == 200, r.text
    return r.json()["challenge"]


def sign_challenge(key: SigningKey, device_id: str, challenge: str) -> str:
    return base64.b64encode(key.sign(signing_input(device_id, challenge)).signature).decode()


def register_device(client, device_id: str, key: SigningKey, language: str = "ml"):
    challenge = challenge_for(client, device_id)
    return client.post("/api/v1/auth/register-device", json={
        "device_id": device_id,
        "ed25519_public_key": base64.b64encode(bytes(key.verify_key)).decode(),
        "language": language,
        "challenge": challenge,
        "challenge_signature": sign_challenge(key, device_id, challenge),
    })
