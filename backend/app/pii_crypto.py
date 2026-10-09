"""Authenticated, field-by-field encryption for stored incident PII."""
from __future__ import annotations

import base64
import binascii
import json
import os
import secrets
from functools import lru_cache
from pathlib import Path

from nacl.exceptions import CryptoError
from nacl.secret import SecretBox

from app.settings import settings

KEY_BYTES = SecretBox.KEY_SIZE


@lru_cache(maxsize=1)
def _box() -> SecretBox:
    configured = settings.sahay_pii_encryption_key
    if configured:
        try:
            key = base64.b64decode(configured, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise RuntimeError("SAHAY_PII_ENCRYPTION_KEY must be base64-encoded") from exc
        if len(key) != KEY_BYTES:
            raise RuntimeError("SAHAY_PII_ENCRYPTION_KEY must decode to 32 bytes")
        return SecretBox(key)

    if not settings.sahay_dev:
        raise RuntimeError("SAHAY_PII_ENCRYPTION_KEY must be configured when SAHAY_DEV is disabled")

    key_path = Path(settings.sahay_pii_key_file)
    if key_path.exists():
        try:
            key = base64.b64decode(key_path.read_text(encoding="ascii"), validate=True)
        except (OSError, UnicodeError, binascii.Error, ValueError) as exc:
            raise RuntimeError(f"Could not read PII encryption key file: {key_path}") from exc
        if len(key) != KEY_BYTES:
            raise RuntimeError(f"PII key file must contain a base64-encoded 32-byte key: {key_path}")
        return SecretBox(key)

    key = secrets.token_bytes(KEY_BYTES)
    key_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with key_path.open("x", encoding="ascii") as stream:
            stream.write(base64.b64encode(key).decode("ascii"))
    except FileExistsError:
        return _box_from_file(key_path)
    try:
        os.chmod(key_path, 0o600)
    except OSError:
        pass
    return SecretBox(key)


def _box_from_file(key_path: Path) -> SecretBox:
    try:
        key = base64.b64decode(key_path.read_text(encoding="ascii"), validate=True)
    except (OSError, UnicodeError, binascii.Error, ValueError) as exc:
        raise RuntimeError(f"Could not read PII encryption key file: {key_path}") from exc
    if len(key) != KEY_BYTES:
        raise RuntimeError(f"PII key file must contain a base64-encoded 32-byte key: {key_path}")
    return SecretBox(key)


def ensure_pii_encryption_key() -> None:
    """Validate production key configuration during app startup."""
    _box()


def encrypt_field(value: object | None, context: str) -> bytes | None:
    if value is None:
        return None
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    message = context.encode("utf-8") + b"\0" + encoded
    return bytes(_box().encrypt(message))


def decrypt_field(ciphertext: bytes | None, context: str) -> object | None:
    if ciphertext is None:
        return None
    try:
        message = _box().decrypt(ciphertext)
    except CryptoError as exc:
        raise RuntimeError("Stored PII failed authentication") from exc
    prefix = context.encode("utf-8") + b"\0"
    if not message.startswith(prefix):
        raise RuntimeError("Stored PII field context does not match")
    try:
        return json.loads(message[len(prefix):].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Stored PII field is malformed") from exc
