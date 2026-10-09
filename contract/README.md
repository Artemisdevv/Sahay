# contract/

Shared artifacts every side consumes. Source of truth for behaviour is `docs/api-contract.md`.

- `fixtures/`: example JSON for every schema (B-01).
- `crypto-test-vector.json`: frozen envelope test vector (X-02). TEST-ONLY keys.
  - Python: `backend/tests/test_ingest_crypto.py` consumes it.
  - JS: `node contract/verify-vector.mjs contract/crypto-test-vector.json` (needs `libsodium-wrappers`). F-03 must pass the same checks.
  - Kotlin/native does not sign or open envelopes; it carries them opaquely.
  - Regenerate only with `python backend/scripts/gen_test_vector.py --force`, and tell everyone: the ciphertext is random, so a regen invalidates frozen copies.
