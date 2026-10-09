"""Report envelope crypto (contract section 1). Pure functions, no FastAPI or DB.

Envelope = sealed box (X25519) of ReportPayload JSON, signed Ed25519 by the device key.
Signature input: UTF-8 "report_id|device_id|created_at|" followed by raw ciphertext bytes.
`ttl` and `hops` are unsigned (relays mutate them) and ignored here.
"""
from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from typing import Any

from nacl.exceptions import BadSignatureError, CryptoError
from nacl.public import PrivateKey, SealedBox
from nacl.signing import SigningKey, VerifyKey

MAX_AUDIO_BYTES = 200 * 1024
# base64 audio inside JSON inside a sealed box: leave headroom over 200 KB * 4/3
MAX_CIPHERTEXT_BYTES = 400 * 1024
CATEGORIES = {"accident", "fire", "medical", "crime", "flood", "other"}
KINDS = {"report", "sos"}
ENVELOPE_FIELDS = ("envelope_version", "report_id", "device_id", "created_at", "key_id", "ciphertext", "signature")


class IngestError(Exception):
    """Maps to the contract error envelope: HTTP status + code."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def b64d(value: Any, field: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise IngestError(400, "bad_request", f"{field} must be a non-empty base64 string")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise IngestError(400, "bad_request", f"{field} is not valid base64") from None


def b64e(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def signing_input(report_id: str, device_id: str, created_at: str, ciphertext: bytes) -> bytes:
    return f"{report_id}|{device_id}|{created_at}|".encode("utf-8") + ciphertext


def sign_envelope(env: dict, device_key: SigningKey) -> str:
    """Used by tests and the test-vector generator (the real signer is the client)."""
    ct = base64.b64decode(env["ciphertext"])
    msg = signing_input(env["report_id"], env["device_id"], env["created_at"], ct)
    return b64e(device_key.sign(msg).signature)


def check_envelope_shape(env: Any) -> tuple[bytes, bytes]:
    """Validate required fields and sizes. Returns (ciphertext, signature) raw bytes."""
    if not isinstance(env, dict):
        raise IngestError(400, "bad_request", "envelope must be an object")
    for f in ENVELOPE_FIELDS:
        if f not in env:
            raise IngestError(400, "bad_request", f"missing field: {f}")
    if env["envelope_version"] != 1:
        raise IngestError(400, "bad_request", "unsupported envelope_version")
    for f in ("report_id", "device_id", "created_at"):
        if not isinstance(env[f], str) or not env[f] or "|" in env[f]:
            raise IngestError(400, "bad_request", f"invalid {f}")
    ct = b64d(env["ciphertext"], "ciphertext")
    if len(ct) > MAX_CIPHERTEXT_BYTES:
        raise IngestError(413, "too_large", "ciphertext too large")
    sig = b64d(env["signature"], "signature")
    if len(sig) != 64:
        raise IngestError(422, "invalid_signature", "signature must be 64 bytes")
    return ct, sig


def verify_signature(env: dict, device_public_key_b64: str) -> bytes:
    """Verify Ed25519 signature against the registered device key. Returns ciphertext bytes."""
    ct, sig = check_envelope_shape(env)
    try:
        vk = VerifyKey(b64d(device_public_key_b64, "device public key"))
    except (CryptoError, ValueError):
        raise IngestError(400, "bad_request", "device public key invalid") from None
    msg = signing_input(env["report_id"], env["device_id"], env["created_at"], ct)
    try:
        vk.verify(msg, sig)
    except BadSignatureError:
        raise IngestError(422, "invalid_signature", "signature does not match") from None
    return ct


def decrypt_payload(ciphertext: bytes, server_box_key: PrivateKey) -> dict:
    try:
        plain = SealedBox(server_box_key).decrypt(ciphertext)
    except CryptoError:
        raise IngestError(400, "bad_request", "ciphertext cannot be decrypted") from None
    try:
        payload = json.loads(plain.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise IngestError(400, "bad_request", "payload is not valid JSON") from None
    return validate_payload(payload)


def validate_payload(p: Any) -> dict:
    if not isinstance(p, dict):
        raise IngestError(400, "bad_request", "payload must be an object")
    if p.get("schema") != 1:
        raise IngestError(400, "bad_request", "unsupported payload schema")
    if p.get("kind") not in KINDS:
        raise IngestError(400, "bad_request", "kind must be report or sos")
    if p.get("category") not in CATEGORIES:
        raise IngestError(400, "bad_request", "invalid category")
    loc = p.get("location")
    if not isinstance(loc, dict) or not _num(loc.get("lat")) or not _num(loc.get("lng")):
        raise IngestError(400, "bad_request", "location lat/lng required")
    if not -90 <= loc["lat"] <= 90 or not -180 <= loc["lng"] <= 180:
        raise IngestError(400, "bad_request", "location out of range")
    audio, text = p.get("audio"), p.get("text")
    if not audio and not text:
        raise IngestError(400, "bad_request", "audio or text required")
    if audio:
        if not isinstance(audio, dict):
            raise IngestError(400, "bad_request", "audio must be an object")
        raw = b64d(audio.get("data"), "audio.data")
        if len(raw) > MAX_AUDIO_BYTES:
            raise IngestError(413, "too_large", "audio exceeds 200 KB")
    return p


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


@dataclass(frozen=True)
class Opened:
    payload: dict
    ciphertext: bytes


def open_envelope(env: dict, device_public_key_b64: str, server_box_key: PrivateKey) -> Opened:
    """Order matters: verify signature first so nobody forces decryption work with forged envelopes."""
    ct = verify_signature(env, device_public_key_b64)
    return Opened(payload=decrypt_payload(ct, server_box_key), ciphertext=ct)


def make_receipt(report_id: str, server_time: str, server_signing_key: SigningKey) -> dict:
    """Receipt signature: Ed25519 over UTF-8 'report_id|server_time' with the server signing key."""
    msg = f"{report_id}|{server_time}".encode("utf-8")
    return {"server_time": server_time, "signature": b64e(server_signing_key.sign(msg).signature)}


def status_signing_input(report_id: str, status: str, message: str, updated_at: str) -> bytes:
    """Status signature input: UTF-8 'report_id|status|message|updated_at'. updated_at stops replay of an old status."""
    return f"{report_id}|{status}|{message}|{updated_at}".encode("utf-8")


def sign_status(report_id: str, status: str, message: str, updated_at: str, server_signing_key: SigningKey) -> str:
    """Server-signed status, so a relay phone can carry it to an offline reporter without being able to forge it."""
    return b64e(server_signing_key.sign(status_signing_input(report_id, status, message, updated_at)).signature)


def verify_receipt(report_id: str, receipt: dict, server_verify_key_b64: str) -> bool:
    msg = f"{report_id}|{receipt['server_time']}".encode("utf-8")
    try:
        VerifyKey(b64d(server_verify_key_b64, "server verify key")).verify(msg, b64d(receipt["signature"], "signature"))
        return True
    except (BadSignatureError, IngestError):
        return False


def public_box_key_b64(sk: PrivateKey) -> str:
    return b64e(bytes(sk.public_key))

