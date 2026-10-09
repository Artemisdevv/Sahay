"""Proof of possession for device registration and token refresh.

Flow (api-contract.md section 2.1):
  1. POST /auth/device-challenge {device_id}  ->  {challenge, expires_in}
  2. The device signs  "sahay-register-v1|<device_id>|<challenge>"  with its Ed25519 key.
  3. POST /auth/register-device sends the public key, the challenge and that signature.

Why: a device public key is not secret. Without this, anyone who learns a device_id and its public key could be
issued that device's bearer token. Now the token is only issued to whoever holds the private key.

The challenge is stateless (an HMAC over device_id, expiry and a random nonce), short-lived (60 s), bound to one
device_id, and accepted once. The one-time cache is in memory: fine for a single server process; a multi-instance
deployment needs a shared store (Redis) for it.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import secrets
import threading
import time

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

CHALLENGE_TTL_SECONDS = 60
PREFIX = "sahay-register-v1"


class ChallengeError(Exception):
    """Challenge or proof is unusable. `code` is machine readable, `message` is safe to show."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _mac(secret: str, device_id: str, exp: int, nonce: str) -> str:
    key = hashlib.sha256(f"{secret}|device-challenge".encode("utf-8")).digest()
    return _b64u(hmac.new(key, f"{device_id}|{exp}|{nonce}".encode("utf-8"), hashlib.sha256).digest())


def signing_input(device_id: str, challenge: str) -> bytes:
    return f"{PREFIX}|{device_id}|{challenge}".encode("utf-8")


class DeviceChallenges:
    def __init__(self, secret: str, now=time.time) -> None:
        self._secret = secret
        self._now = now
        self._used: dict[str, int] = {}
        self._lock = threading.Lock()

    def issue(self, device_id: str) -> dict:
        exp = int(self._now()) + CHALLENGE_TTL_SECONDS
        nonce = _b64u(secrets.token_bytes(16))
        return {
            "challenge": f"v1.{exp}.{nonce}.{_mac(self._secret, device_id, exp, nonce)}",
            "expires_in": CHALLENGE_TTL_SECONDS,
        }

    def verify(self, device_id: str, public_key_b64: str, challenge: str, signature_b64: str) -> None:
        """Raises ChallengeError unless the challenge is ours, fresh, unused, and signed by public_key."""
        exp, nonce = self._check_challenge(device_id, challenge)
        try:
            signature = base64.b64decode(signature_b64, validate=True)
            VerifyKey(base64.b64decode(public_key_b64, validate=True)).verify(signing_input(device_id, challenge), signature)
        except (BadSignatureError, binascii.Error, ValueError):
            raise ChallengeError("invalid_proof", "Device proof of possession failed") from None
        # Burn the challenge only after a valid proof, so someone else's garbage cannot waste a real device's challenge.
        with self._lock:
            now = int(self._now())
            self._used = {n: e for n, e in self._used.items() if e > now}
            if nonce in self._used:
                raise ChallengeError("invalid_challenge", "Challenge was already used")
            self._used[nonce] = exp

    def _check_challenge(self, device_id: str, challenge: str) -> tuple[int, str]:
        bad = ChallengeError("invalid_challenge", "Challenge is invalid or expired")
        parts = challenge.split(".")
        if len(parts) != 4 or parts[0] != "v1" or not parts[1].isdigit():
            raise bad
        exp, nonce, mac = int(parts[1]), parts[2], parts[3]
        if not hmac.compare_digest(mac, _mac(self._secret, device_id, exp, nonce)):
            raise bad
        if exp < int(self._now()):
            raise bad
        return exp, nonce
