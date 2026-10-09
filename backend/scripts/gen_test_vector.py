"""Generate contract/crypto-test-vector.json (X-02).

Keys are derived from fixed TEST-ONLY seeds. The sealed-box ciphertext uses a random ephemeral key,
so it is generated once and frozen in the JSON; refuses to overwrite without --force.

Frontend/native consumers must:
  1. sealed-box DECRYPT `ciphertext` with `server.box_secret_key`  -> must equal `plaintext_json` bytes
  2. Ed25519 SIGN `signing_input` with `device.signing_seed`        -> must equal `signature` (Ed25519 is deterministic)
  3. Ed25519 VERIFY `signature` over `signing_input` with `device.public_key`
  4. Server receipt: VERIFY `receipt.signature` over `receipt.signing_input_utf8` with `server.verify_key`
  5. All `negative` cases must be rejected.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from nacl.public import PrivateKey, SealedBox
from nacl.signing import SigningKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.ingest.crypto import b64e, make_receipt, sign_envelope, signing_input  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "contract" / "crypto-test-vector.json"


def seed(label: str) -> bytes:
    return hashlib.sha256(f"sahay-test-vector:{label}".encode()).digest()


def main() -> None:
    if OUT.exists() and "--force" not in sys.argv:
        sys.exit(f"{OUT} exists (frozen). Pass --force to regenerate; consumers must update.")

    server_box = PrivateKey(seed("server-box"))
    server_sign = SigningKey(seed("server-sign"))
    device_sign = SigningKey(seed("device"))

    payload = {
        "schema": 1,
        "kind": "report",
        "category": "accident",
        "language": "ml",
        "captured_at": "2026-10-09T10:15:00Z",
        "location": {"lat": 9.9312, "lng": 76.2673, "accuracy_m": 12},
        "audio": {"mime": "audio/webm;codecs=opus", "data": b64e(b"TEST-AUDIO-BYTES"), "duration_s": 1},
        "text": None,
        "reporter": {"name": "Test Reporter", "phone": "+919800000000"},
        "emergency_contact": {"name": "Test Contact", "phone": "+919800000001"},
    }
    plaintext = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    ciphertext = SealedBox(server_box.public_key).encrypt(plaintext.encode("utf-8"))

    env = {
        "envelope_version": 1,
        "report_id": "11111111-1111-4111-8111-111111111111",
        "device_id": "22222222-2222-4222-8222-222222222222",
        "created_at": "2026-10-09T10:15:00Z",
        "ttl": 5,
        "key_id": "k1",
        "ciphertext": b64e(ciphertext),
    }
    env["signature"] = sign_envelope(env, device_sign)

    sig_in = signing_input(env["report_id"], env["device_id"], env["created_at"], ciphertext)
    server_time = "2026-10-09T10:15:02Z"
    receipt = make_receipt(env["report_id"], server_time, server_sign)

    def tampered(**changes) -> dict:
        return {**env, **changes}

    flipped = bytearray(ciphertext)
    flipped[-1] ^= 1
    other_sign = SigningKey(seed("other-device"))

    vector = {
        "_doc": "TEST-ONLY keys. Never use in any real deployment. See backend/scripts/gen_test_vector.py header for how to consume.",
        "version": 1,
        "server": {
            "box_secret_key": b64e(bytes(server_box)),
            "box_public_key": b64e(bytes(server_box.public_key)),
            "sign_seed": b64e(bytes(server_sign)),
            "verify_key": b64e(bytes(server_sign.verify_key)),
        },
        "device": {
            "signing_seed": b64e(bytes(device_sign)),
            "public_key": b64e(bytes(device_sign.verify_key)),
        },
        "plaintext_json": plaintext,
        "envelope": env,
        "signing_input_b64": b64e(sig_in),
        "signing_input_note": "UTF-8 'report_id|device_id|created_at|' + raw ciphertext bytes",
        "receipt": {
            "report_id": env["report_id"],
            "server_time": server_time,
            "signing_input_utf8": f"{env['report_id']}|{server_time}",
            **receipt,
        },
        "negative": {
            "tampered_ciphertext": {
                "envelope": tampered(ciphertext=b64e(bytes(flipped))),
                "expect": "invalid_signature",
            },
            "tampered_created_at": {
                "envelope": tampered(created_at="2026-10-09T10:16:00Z"),
                "expect": "invalid_signature",
            },
            "signed_by_other_device": {
                "envelope": tampered(signature=sign_envelope(env, other_sign)),
                "expect": "invalid_signature",
            },
            "short_signature": {
                "envelope": tampered(signature=b64e(b"\x00" * 10)),
                "expect": "invalid_signature",
            },
        },
        "unsigned_fields_note": "ttl and hops may change without invalidating the signature",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(vector, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
