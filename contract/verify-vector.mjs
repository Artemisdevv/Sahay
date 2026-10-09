// Verifies contract/crypto-test-vector.json with libsodium-wrappers.
// Usage: npm i libsodium-wrappers && node contract/verify-vector.mjs contract/crypto-test-vector.json
import fs from 'fs';
import sodium from 'libsodium-wrappers';
await sodium.ready;
const v = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const b = (s) => sodium.from_base64(s, sodium.base64_variants.ORIGINAL);
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) process.exitCode = 1; };

const boxPk = b(v.server.box_public_key), boxSk = b(v.server.box_secret_key);
const ct = b(v.envelope.ciphertext);
const plain = sodium.crypto_box_seal_open(ct, boxPk, boxSk);
ok('sealed box decrypts to plaintext_json', sodium.to_string(plain) === v.plaintext_json);

const e = v.envelope;
const enc = new TextEncoder();
const prefix = enc.encode(`${e.report_id}|${e.device_id}|${e.created_at}|`);
const msg = new Uint8Array(prefix.length + ct.length); msg.set(prefix); msg.set(ct, prefix.length);
ok('signing input matches', sodium.to_base64(msg, sodium.base64_variants.ORIGINAL) === v.signing_input_b64);

const kp = sodium.crypto_sign_seed_keypair(b(v.device.signing_seed));
ok('device public key from seed', sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL) === v.device.public_key);
const sig = sodium.crypto_sign_detached(msg, kp.privateKey);
ok('JS signature == vector signature', sodium.to_base64(sig, sodium.base64_variants.ORIGINAL) === e.signature);
ok('verify vector signature', sodium.crypto_sign_verify_detached(b(e.signature), msg, b(v.device.public_key)));

const r = v.receipt;
ok('receipt verifies', sodium.crypto_sign_verify_detached(b(r.signature), enc.encode(r.signing_input_utf8), b(v.server.verify_key)));

for (const [name, c] of Object.entries(v.negative)) {
  const n = c.envelope, nct = b(n.ciphertext), pre = enc.encode(`${n.report_id}|${n.device_id}|${n.created_at}|`);
  const m = new Uint8Array(pre.length + nct.length); m.set(pre); m.set(nct, pre.length);
  const s = b(n.signature);
  const valid = s.length === 64 && sodium.crypto_sign_verify_detached(s, m, b(v.device.public_key));
  ok(`negative rejected: ${name}`, !valid);
}
