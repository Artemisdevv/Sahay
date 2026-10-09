import base64
import binascii
import os
from pathlib import Path

from nacl.public import PrivateKey
from nacl.signing import SigningKey

from app.settings import settings

ED25519_SEED_BYTES = 32


def _load_or_create_private_key() -> PrivateKey:
    configured = settings.sahay_server_x25519_secret_key
    if configured:
        try:
            raw = base64.b64decode(configured, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise RuntimeError("SAHAY_SERVER_X25519_SECRET_KEY must be base64-encoded") from exc
        if len(raw) != PrivateKey.SIZE:
            raise RuntimeError("SAHAY_SERVER_X25519_SECRET_KEY must decode to 32 bytes")
        return PrivateKey(raw)

    if not settings.sahay_dev:
        raise RuntimeError("SAHAY_SERVER_X25519_SECRET_KEY must be configured when SAHAY_DEV is disabled")

    key_path = Path(settings.sahay_server_key_file)
    if key_path.exists():
        try:
            raw = base64.b64decode(key_path.read_text(encoding="ascii"), validate=True)
        except (OSError, UnicodeError, binascii.Error, ValueError) as exc:
            raise RuntimeError(f"Could not read server key file: {key_path}") from exc
        if len(raw) != PrivateKey.SIZE:
            raise RuntimeError(f"Server key file must contain a base64-encoded 32-byte key: {key_path}")
        return PrivateKey(raw)

    private_key = PrivateKey.generate()
    key_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_text(base64.b64encode(bytes(private_key)).decode("ascii"), encoding="ascii")
    try:
        os.chmod(key_path, 0o600)
    except OSError:
        pass
    return private_key


def server_signing_key() -> SigningKey:
    configured = settings.sahay_server_ed25519_secret_key
    if configured:
        try:
            raw = base64.b64decode(configured, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise RuntimeError("SAHAY_SERVER_ED25519_SECRET_KEY must be base64-encoded") from exc
        if len(raw) != ED25519_SEED_BYTES:
            raise RuntimeError("SAHAY_SERVER_ED25519_SECRET_KEY must decode to 32 bytes")
        return SigningKey(raw)

    if not settings.sahay_dev:
        raise RuntimeError("SAHAY_SERVER_ED25519_SECRET_KEY must be configured when SAHAY_DEV is disabled")

    key_path = Path(settings.sahay_server_signing_key_file)
    if key_path.exists():
        try:
            raw = base64.b64decode(key_path.read_text(encoding="ascii"), validate=True)
        except (OSError, UnicodeError, binascii.Error, ValueError) as exc:
            raise RuntimeError(f"Could not read server signing key file: {key_path}") from exc
        if len(raw) != ED25519_SEED_BYTES:
            raise RuntimeError(f"Server signing key file must contain a base64-encoded 32-byte seed: {key_path}")
        return SigningKey(raw)

    signing_key = SigningKey.generate()
    key_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_text(base64.b64encode(bytes(signing_key)).decode("ascii"), encoding="ascii")
    try:
        os.chmod(key_path, 0o600)
    except OSError:
        pass
    return signing_key


def server_public_key_response() -> dict[str, str]:
    private_key = _load_or_create_private_key()
    signing_key = server_signing_key()
    return {
        "key_id": "k1",
        "x25519_public_key": base64.b64encode(bytes(private_key.public_key)).decode("ascii"),
        "ed25519_public_key": base64.b64encode(bytes(signing_key.verify_key)).decode("ascii"),
    }
