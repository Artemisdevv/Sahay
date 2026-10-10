# Sahay API Contract (v1)

Single source of truth between backend (Adnan), frontend (Shreyas) and native (Aswin).
**Change rule:** any change to this file needs a PR reviewed by the owner of each side that it touches. Bump `schema` fields on breaking changes.

- Base URL: `/api/v1` (dev: `http://localhost:8000/api/v1`)
- Format: JSON, UTF-8, `snake_case`, timestamps are ISO-8601 UTC (`2026-10-09T10:15:00Z`), IDs are UUIDv4 strings unless noted
- Binary fields (ciphertext, signatures, keys, audio) are **base64 (standard, padded)**
- Auth: `Authorization: Bearer <token>`
- Errors: HTTP status plus `{ "error": { "code": "string", "message": "string" } }`

Common codes: `400 bad_request`, `401 unauthenticated`, `403 forbidden`, `404 not_found`, `409 conflict`, `413 too_large`, `422 invalid_signature`, `429 rate_limited`.

---

## 0. Roles and visibility

| Role | Gets token via | Sees |
|---|---|---|
| `civilian` | device registration | only own reports and their status |
| `service` | login, bound to one `unit_id` | dispatches assigned to the unit, **redacted** incident view |
| `admin` | login | everything, PII only through `reveal` (audit-logged) |

**Redacted view** = `incident_type`, `severity`, fuzz-free exact location (services need it), `summary_redacted`, `people_count`, `hazards`. No name, phone, address, medical details, audio, or raw transcript.
**Public/low-privilege map view** = location fuzzed to about 100 m, no PII (not needed for demo, reserved).

---

## 1. Crypto and envelope

Libsodium everywhere (`libsodium-wrappers` in the web app, `PyNaCl` in the backend).

- Server holds an X25519 keypair. Public key is served by `GET /config/server-key`.
- Each device holds an Ed25519 signing keypair, registered once while online.
- Report plaintext is JSON (section 1.1), encrypted with `crypto_box_seal` to the server key, then signed.

### 1.1 Plaintext payload (`ReportPayload`, encrypted inside the envelope)

```json
{
  "schema": 1,
  "kind": "report",
  "category": "accident",
  "language": "ml",
  "captured_at": "2026-10-09T10:15:00Z",
  "location": { "lat": 9.9312, "lng": 76.2673, "accuracy_m": 12 },
  "audio": { "mime": "audio/webm;codecs=opus", "data": "<base64>", "duration_s": 18 },
  "text": null,
  "reporter": { "name": "optional", "phone": "optional" },
  "emergency_contact": { "name": "optional", "phone": "optional" }
}
```

- `kind`: `report` or `sos`
- `category` (quick-tap fallback, always set): `accident | fire | medical | crime | flood | other`
- `audio` or `text` must be present. Audio cap is **200 KB** after base64 decode (about 30 s Opus at 16 kbps). Server returns `413` otherwise.
- `reporter` and `emergency_contact` are PII. They only ever exist inside the ciphertext.

### 1.2 Envelope (`ReportEnvelope`, what travels over HTTP, Nearby relay and is stored offline)

```json
{
  "envelope_version": 1,
  "report_id": "uuid",
  "device_id": "uuid",
  "created_at": "2026-10-09T10:15:00Z",
  "ttl": 5,
  "key_id": "k1",
  "ciphertext": "<base64 sealed box of ReportPayload>",
  "signature": "<base64 Ed25519 over report_id|device_id|created_at|ciphertext bytes>"
}
```

Signature input is the UTF-8 string `report_id + "|" + device_id + "|" + created_at + "|"` followed by the raw ciphertext bytes. `ttl` and `hops` are **not** signed (relays mutate them).
Relays append `hops` (integer, starts 0, +1 per relay) outside the signed part. Server ignores `ttl` and `hops` for validity. Relays drop at `hops >= ttl`.

---

## 2. REST endpoints

### 2.1 Config and auth

**`GET /config/server-key`** (public)
```json
{
  "key_id": "k1",
  "x25519_public_key": "<base64>",
  "ed25519_public_key": "<base64>"
}
```

`ed25519_public_key` verifies the server signatures on report receipts. It is
the verify key corresponding to the server signing key used by `POST /reports`.

**`POST /auth/device-challenge`** (public, rate-limited): step 1 of registration and of every token refresh.
```json
// request
{ "device_id": "uuid" }
// 200
{ "challenge": "v1.<exp>.<nonce>.<mac>", "expires_in": 60 }
```
The challenge is bound to that `device_id`, lasts 60 s and works once.

**`POST /auth/register-device`** (public, rate-limited): proof of possession is required, because a device public key is not secret.
```json
// request
{
  "device_id": "uuid", "ed25519_public_key": "<base64>", "language": "ml",
  "challenge": "<from /auth/device-challenge>",
  "challenge_signature": "<base64 Ed25519 over UTF-8 'sahay-register-v1|<device_id>|<challenge>' with the device key>"
}
// 201 (new device, or an existing device registering again with the same key = token refresh)
{ "token": "jwt", "role": "civilian", "device_id": "uuid" }
```
Errors: `401` bad or expired challenge, reused challenge, or a signature that does not verify; `409` the `device_id` is already registered with a different key. Tokens last 12 h: refresh by repeating both calls. `contract/crypto-test-vector.json` has a `register` example.

**`POST /auth/login`** (service/admin)
```json
// request
{ "username": "amb-01", "password": "..." }
// 200
{ "token": "jwt", "role": "service", "unit_id": "uuid|null", "display_name": "Ambulance 01" }
```

Seeded demo logins are listed in `backend/README.md` once B-01 lands.

### 2.2 Reports (civilian)

**`POST /reports`**: body is a `ReportEnvelope`. Used for both direct upload and by relay phones uploading on behalf of others. Auth: any valid device token (the signature, not the token, proves authorship).

- `202`: `{ "report_id": "uuid", "status": "received", "receipt": { "server_time": "...", "signature": "<base64 Ed25519 over report_id|server_time with server signing key>" } }`
- Idempotent: same `report_id` again returns `200` with the same receipt. Never creates a duplicate.
- `422 invalid_signature`, `413 too_large`, `409 conflict` (same `report_id`, different content), `429`.

**`GET /reports/mine`** (civilian)
```json
{ "reports": [ { "report_id": "uuid", "status": "dispatched", "eta_minutes": 6, "updated_at": "..." } ] }
```

**`GET /reports/{report_id}/status`** (civilian, own only)
```json
{ "report_id": "uuid", "status": "dispatched", "eta_minutes": 6, "message": "Help dispatched, ETA 6 min", "updated_at": "...", "signature": "<base64 Ed25519 over report_id|status|message|updated_at with the server signing key>" }
```
`status` values (`ReportStatus`): `received | processing | triaged | pending_approval | dispatched | en_route | on_scene | resolved | rejected`

**`PUT /contacts`** (civilian). Stored server-side encrypted, used for follow-up SMS. Consent flag is mandatory.
```json
{ "contacts": [ { "name": "Amma", "phone": "+919876543210" } ], "consent_acknowledged": true }
```

**`POST /sms-gateway/inbound`**: webhook from the SMS gateway (see section 5). Auth: shared secret header `X-Gateway-Secret`.

### 2.3 Incidents (admin, service)

`Incident`:
```json
{
  "incident_id": "uuid",
  "status": "pending_approval",
  "incident_type": "accident",
  "severity": 4,
  "urgency_score": 0.82,
  "location": { "lat": 9.9312, "lng": 76.2673 },
  "summary_redacted": "Two-vehicle collision at a junction, two injured, one unresponsive.",
  "people_count": 2,
  "hazards": ["traffic"],
  "needed_services": ["ambulance", "police"],
  "report_count": 1,
  "report_ids": ["uuid"],
  "reason": "one-line triage reason",
  "created_at": "...",
  "updated_at": "..."
}
```
Incident `status`: `new | processing | triaged | pending_approval | dispatched | en_route | on_scene | resolved | rejected`. Severity 1 (low) to 5 (critical).

| Method + path | Role | Description |
|---|---|---|
| `GET /incidents?status=&type=&limit=&cursor=` | admin, service | Admin gets all. Service gets only incidents with an approved-or-later dispatch to its unit (not proposed, declined or cancelled) and only the WebSocket `incident.updated` field subset. Redacted shape, `limit` 1–100, opaque `next_cursor`. |
| `GET /incidents/{id}` | admin, service | Single `Incident` plus `dispatches[]`. Service sees only its own approved-or-later dispatches. |
| `GET /incidents/{id}/trace` | admin | Agent trace (section 4). |
| `POST /incidents/{id}/reveal` | admin | Body `{ "reason": "string (required)" }`. Returns `IncidentPII`, writes audit entry `pii.reveal`. |
| `POST /incidents/{id}/approve` | admin | Approves proposed dispatches. |
| `POST /incidents/{id}/reject` | admin | Body `{ "reason": "..." }`. |
| `POST /incidents/{id}/reassign` | admin | Body `{ "needed_service": "ambulance", "unit_id": "uuid" }`. |
| `POST /incidents/{id}/resolve` | admin | Marks resolved. |

`IncidentPII` (reveal response):
```json
{
  "incident_id": "uuid",
  "transcript": "full transcript text",
  "reporters": [ { "report_id": "uuid", "name": "...", "phone": "...", "language": "ml", "emergency_contact": { "name": "...", "phone": "..." } } ],
  "pii_spans": [ { "type": "phone", "text": "98xxxx", "start": 10, "end": 20 } ],
  "audio_url": "/api/v1/media/<id>"
}
```

### 2.4 Units and dispatches

`Unit`:
```json
{
  "unit_id": "uuid",
  "service_type": "ambulance",
  "name": "Ambulance 01",
  "status": "available",
  "location": { "lat": 9.93, "lng": 76.26 },
  "updated_at": "..."
}
```
`service_type`: `ambulance | police | fire | municipal`. Unit `status`: `available | assigned | en_route | on_scene | offline`.

`Dispatch`:
```json
{
  "dispatch_id": "uuid",
  "incident_id": "uuid",
  "unit_id": "uuid",
  "service_type": "ambulance",
  "status": "proposed",
  "distance_km": 3.2,
  "eta_minutes": 6,
  "proposed_by": "dispatch_agent",
  "created_at": "...",
  "updated_at": "..."
}
```
Dispatch `status`: `proposed | approved | accepted | declined | en_route | on_scene | completed | cancelled`.

| Method + path | Role | Description |
|---|---|---|
| `GET /units` | admin | All units. |
| `PATCH /units/{id}/location` | service (own unit), admin | `{ "lat": 0, "lng": 0 }`. Broadcasts `unit.moved`. |
| `GET /dispatches/mine` | service | Dispatches for the caller's unit. |
| `POST /dispatches/{id}/accept` | service | |
| `POST /dispatches/{id}/decline` | service | `{ "reason": "..." }`. Triggers re-propose to next nearest unit. |
| `POST /dispatches/{id}/status` | service | `{ "status": "en_route" \| "on_scene" \| "completed" }` |

### 2.5 Audit

`AuditEntry`:
```json
{
  "seq": 42,
  "ts": "...",
  "actor": { "type": "admin|service|agent|system|device", "id": "string" },
  "action": "dispatch.approve",
  "target": { "type": "incident", "id": "uuid" },
  "details": { },
  "prev_hash": "hex",
  "hash": "hex"
}
```
`hash = SHA-256( seq | ts | canonical_json(actor) | action | canonical_json(target) | canonical_json(details) | prev_hash )`, fields joined with `|`; objects use sorted-key compact JSON, and `ts` is UTC ISO-8601. The first entry has `prev_hash = "0"*64`.

Actions (not exhaustive): `report.received`, `agent.intake`, `agent.pii`, `agent.triage`, `dispatch.propose`, `dispatch.approve`, `dispatch.accept`, `dispatch.decline`, `dispatch.status`, `incident.resolve`, `pii.reveal`, `auth.login`.

- `GET /audit?limit=&after_seq=` (admin) returns `{ "entries": [AuditEntry] }` in ascending `seq` order; `after_seq` is exclusive and `limit` is 1–100.
- `GET /audit/verify` (admin) checks the full chain and stored tail, returning `{ "valid": true, "checked": 120, "first_bad_seq": null }` or the first invalid sequence.

### 2.6 Dev and demo helpers (enabled only when `SAHAY_DEV=1`)

These let the frontend work **before** crypto and agents exist.

| Endpoint | Description |
|---|---|
| `POST /dev/seed` | Re-seeds units (police, fire, ambulance) around Kochi (9.9312, 76.2673) and demo users. |
| `POST /dev/mock-report` | Body: plaintext `ReportPayload` (no envelope, no encryption). Runs the full pipeline. |
| `POST /dev/reset` | Clears incidents, dispatches, audit. |
| `POST /dev/tick` | Moves dispatched units one step toward their incidents and emits `unit.moved`. |

---

## 3. Realtime (WebSocket)

`GET /ws/v1` (WebSocket). **The token is not sent in the URL** (URLs are logged by proxies, ngrok and the server). After connecting, the client sends one message within 5 s (`SAHAY_WS_AUTH_TIMEOUT_S`):
```json
{ "type": "auth", "token": "<jwt>" }
```
The server answers `{ "type": "auth.ok" }` and only then registers the client and delivers events. Anything else (no message, bad token, query-string token, a different first message) closes the socket with code `1008`. Server pushes; the only other client message is `{"type":"ping"}` (answered with `{"type":"pong"}`).

Message shape:
```json
{ "type": "incident.updated", "ts": "...", "data": { } }
```

| `type` | `data` | Who receives |
|---|---|---|
| `incident.created` | `Incident` | admin |
| `incident.updated` | `Incident` | admin, service (own dispatches) |
| `dispatch.proposed` | `Dispatch` | admin |
| `dispatch.updated` | `Dispatch` | admin, service (own unit; proposed dispatches are admin-only) |
| `unit.moved` | `{ unit_id, location, status }` | admin |
| `agent.trace` | `TraceStep` | admin |
| `audit.appended` | `AuditEntry` | admin |
| `report.status` | `{ report_id, status, eta_minutes, message }` | civilian (own device) |

---

## 4. Agent trace

`GET /incidents/{id}/trace` and WS `agent.trace`:

```json
{
  "incident_id": "uuid",
  "step": "triage",
  "agent": "triage_agent",
  "status": "done",
  "started_at": "...",
  "finished_at": "...",
  "summary": "Needs ambulance + police, severity 4",
  "output": { }
}
```
`step` order: `transcribe`, `intake`, `pii`, `triage`, `dedup`, `dispatch`, `approval`, `followup`. `status`: `running | done | skipped | failed`.

**Dispatch rule (do not move into the LLM):** the dispatch agent only *calls* `find_nearest_available(service_type, lat, lng)` (Haversine plus ETA = distance / 30 km/h urban speed) and *proposes*. Auto-approve when `severity <= 3` and confidence is high. Otherwise `pending_approval`.

---

## 5. Nearby relay (Android native plugin <-> web layer)

Capacitor plugin name: **`SahayNearby`**. Service ID `in.sahay.nearby`, strategy `P2P_CLUSTER`. Auto-accept all connections after the app handshake (below).

Methods (TypeScript):
```ts
interface SahayNearbyPlugin {
  start(opts: { deviceId: string; mode: 'advertise' | 'discover' | 'both' }): Promise<void>;
  stop(): Promise<void>;
  // Hand the web layer's queue to the native layer for forwarding
  enqueue(opts: { envelope: ReportEnvelope }): Promise<void>;
  // Tell native a stored report is now delivered (stop re-advertising it)
  markDelivered(opts: { reportId: string }): Promise<void>;
  // After uploading someone else's report: send the server receipt / later status back along the path it came in on.
  // Native holds them until that peer is reachable again.
  relayReceipt(opts: { reportId: string; receipt: Receipt }): Promise<void>;
  relayStatus(opts: { reportId: string; status: ReportStatus; message: string; signature: string; updatedAt: string }): Promise<void>;
  // Everything carried and not yet confirmed delivered (own and others'), so the web layer can upload when it gets online.
  pendingForUpload(): Promise<{ envelopes: ReportEnvelope[] }>;
  // Reports carried for other people (UI shows only this count).
  carryingCount(): Promise<{ count: number }>;
  addListener(event: 'peerConnected', cb: (e: { peerId: string }) => void): Promise<void>;
  addListener(event: 'peerLost', cb: (e: { peerId: string }) => void): Promise<void>;
  // Relay phone got an envelope from someone else. Web layer uploads it if online.
  addListener(event: 'envelopeReceived', cb: (e: { envelope: ReportEnvelope; fromPeer: string }) => void): Promise<void>;
  // Our own report got a server receipt back through a relay
  addListener(event: 'receiptReceived', cb: (e: { reportId: string; receipt: Receipt }) => void): Promise<void>;
  addListener(event: 'statusReceived', cb: (e: { reportId: string; status: ReportStatus; message: string }) => void): Promise<void>;
}
```
`Receipt` is the object from `POST /reports`.

Wire messages between phones (UTF-8 JSON in a Nearby `BYTES` payload; larger than about 32 KB goes as `FILE`/stream, the audio cap keeps normal reports under that):

```json
{ "t": "hello", "app": "sahay", "v": 1, "device_id": "uuid", "carrying": ["report_id"] }
{ "t": "envelope", "envelope": { } }
{ "t": "ack", "report_id": "uuid" }
{ "t": "receipt", "report_id": "uuid", "receipt": { } }
{ "t": "status", "report_id": "uuid", "status": "dispatched", "message": "...", "signature": "<base64 Ed25519>", "updated_at": "..." }
```

Rules:
1. Relay handles `hello` first. Non-Sahay peers (`app != "sahay"`) are disconnected.
2. Relay verifies the **signature** shape (non-empty, length 64) cheaply. Full verification needs the device public key and happens at the server, so relays accept and forward.
3. Dedupe by `report_id`. Drop at `hops >= ttl`. Increment `hops` before forwarding.
4. Phone with internet uploads via `POST /reports`, then sends `receipt` back to the source peer(s).
5. Peers must send `hello` first; garbage, a non-`sahay` app, or an unsupported `v` disconnects. A structurally invalid envelope (missing field, non-numeric `ttl`/`hops`, `ttl` > 10, bad base64, signature not 64 bytes) disconnects the sender.
6. Never send a report back to the peer it came from or to a peer whose `hello.carrying` already lists it. A duplicate is acked, not re-emitted or re-forwarded (so loops end).
7. `hops` is unsigned and starts at 0 on the origin. The origin sends it as created; each relay forwards with `hops + 1` and only while `hops < ttl`. A phone that receives a report at `hops >= ttl` may still upload it, but does not forward it.
8. Receipts and statuses travel back along the path the envelope came in on, and are held until that peer reconnects. Relayed reports expire after 24 h, own undelivered reports after 7 days; at most 200 carried reports (delivered evicted first, then oldest relayed, own reports never evicted).
9. Back-channel messages are untrusted until verified. A `receipt` must verify against the server Ed25519 key (`/config/server-key`); a `status` must carry `updated_at` and a `signature`, Ed25519 by the server over `report_id|status|message|updated_at` (returned by `GET /reports/{id}/status`), that verifies the same way. A message that fails verification is not applied and its sender is disconnected. A status whose `updated_at` is not newer than the stored one is ignored (replay).
10. A failed transport send must not count as sent: receipts, statuses and envelopes are retried on the next connection. `report_id` is at most 128 chars; the native store derives file names from a hash of it.
11. Relay UI shows only a count ("Carrying N encrypted reports"), never contents.

---

## 6. SMS fallback

**Outbound silent SMS** (Android plugin **`SahaySms`**):
```ts
interface SahaySmsPlugin {
  send(opts: { to: string; body: string }): Promise<{ sent: boolean }>;   // needs SEND_SMS
  openDialer(opts: { number: string }): Promise<void>;                    // ACTION_DIAL only, never ACTION_CALL
}
```

**SOS to emergency contact** body (human readable, <= 160 chars):
```
SOS from <name>. Needs help. Location: https://maps.google.com/?q=<lat>,<lng> (Sahay)
```

**SOS / report to gateway** (compact, machine readable, <= 160 chars, GSM-7 only):
```
SAHAY1|<report_id first 8 hex>|<device_id first 8 hex>|<lat 5dp>,<lng 5dp>|<cat code>|<unix ts>
```
Category codes: `AC` accident, `FI` fire, `ME` medical, `CR` crime, `FL` flood, `OT` other, `SO` sos.
Gateway number is configured via `SAHAY_GATEWAY_NUMBER` (demo: a test phone or Twilio number).

**`POST /sms-gateway/inbound`**
```json
{ "from": "+9198...", "body": "SAHAY1|a1b2c3d4|e5f6a7b8|9.93120,76.26730|AC|1760000000", "received_at": "..." }
```
The server builds a minimal incident from the SMS (location plus category, flagged `source: "sms"`, no PII beyond the sending number which is stored encrypted).

Implemented in `backend/app/sms_gateway.py`:
- Disabled (404) unless `SAHAY_GATEWAY_SECRET` is set; a wrong or missing `X-Gateway-Secret` is 401; a body that is not a valid `SAHAY1` line, or a timestamp more than a day ahead, is 422.
- Answers `202 {"report_id": "sms-<report id 8>-<device id 8>", "status": "received", "duplicate": false}`. The same SMS again answers `200` with `"duplicate": true` and creates nothing.
- The incident is created by the normal agent pipeline from a synthetic text ("Fire reported by SMS ... No further details"), so severity, triage and dispatch rules are the same. Its `reason` starts with `Via SMS, location and category only.`. SOS (`SO`) makes a `kind: "sos"` report, which always needs admin approval.
- `GET /config/server-key` also returns `gateway_number` (from `SAHAY_GATEWAY_NUMBER`) when set, so the app learns the number while it is online and can text it later with no signal.
- App side: a report that is still queued after 45 s (SOS 20 s, 3 min when a nearby phone is carrying it) with no internet is announced by one SMS. The sealed report stays queued and still goes out over the internet or a relay, so the full message follows. The SMS line is kept in memory only, never in the queue.

**Emergency number:** India `112`. `openDialer` is used with the number prefilled. **Never use `ACTION_CALL`. Never place a real call in a demo.**

---

## 7. Seed data (for everyone)

City: Kochi, India (centre 9.9312, 76.2673). Seeded units are fixed so tests and the frontend mocks agree:

| Name | Type | Lat | Lng |
|---|---|---|---|
| Ambulance 01 | ambulance | 9.9816 | 76.2999 |
| Ambulance 02 | ambulance | 9.9158 | 76.2540 |
| Police 01 | police | 9.9674 | 76.2822 |
| Police 02 | police | 9.9312 | 76.2673 |
| Fire 01 | fire | 9.9591 | 76.2711 |
| Fire 02 | fire | 10.0159 | 76.3419 |

Demo logins (dev only): `admin / admin123`, `amb-01 / demo123`, `police-01 / demo123`, `fire-01 / demo123`.

---

## 8. Mock server for frontend and native

Until backend endpoints land, frontend uses fixtures in `contract/fixtures/*.json` (one file per schema above) and a MSW or json-server mock. Backend owns producing fixtures from real responses and committing them (issue B-01).

---

## 9. Live response (units arriving on the map)

Goal for the demo: an admin approves an incident, the nearest units are visibly **called**, one accepts, and **units move across the response map** until they arrive. The same picture, with less detail, is on the public map and in the civilian app.

### 9.1 The flow and what everyone sees

| Step | Trigger | Admin sees | Service unit sees | Public / civilian sees |
|---|---|---|---|---|
| 1 Confirmed | admin approves (`POST /incidents/{id}/approve`) | incident turns "dispatched"; candidate list | new assignment pops up | marker appears (existing public feed) |
| 2 Calling | engine ranks nearest available units per needed service | "Calling Ambulance 01 (0.8 km, ETA 2 min)" then next unit if declined or no answer | assignment card with Accept / Decline | "Help is being arranged" |
| 3 Accepted | unit accepts (or demo auto-accept) | unit marked accepted | assignment accepted | "Ambulance accepted" |
| 4 En route | unit starts moving | unit marker glides toward incident, route line, ETA countdown | same, own unit highlighted | unit marker (coarse) moving, "about N min away" |
| 5 On scene | unit reaches the incident (within 50 m) | marker pulses at incident | status On scene | "Help on scene" |
| 6 Completed | service taps Complete | incident resolved, unit available again | | marker turns resolved |

Dispatch itself stays deterministic code (nearest available unit, B-04). The LLM never picks units.

### 9.2 WebSocket changes

`unit.moved` gets richer (all new fields optional, old clients keep working):
```json
{ "unit_id": "uuid", "name": "Ambulance 01", "service_type": "ambulance",
  "location": { "lat": 9.97, "lng": 76.29 }, "status": "en_route",
  "incident_id": "uuid|null", "heading_deg": 42, "speed_kmh": 40, "eta_seconds": 95 }
```
Sent about once per second per moving unit. Receivers: admin (all units), service (own unit and the other units on the same incident).

New `dispatch.called`, sent every time the candidate list changes (admin, and the service units that appear in it):
```json
{ "incident_id": "uuid", "service_type": "ambulance",
  "candidates": [
    { "rank": 1, "unit_id": "uuid", "name": "Ambulance 01", "distance_km": 0.8, "eta_minutes": 2, "state": "declined" },
    { "rank": 2, "unit_id": "uuid", "name": "Ambulance 02", "distance_km": 3.1, "eta_minutes": 6, "state": "calling" }
  ] }
```
`state`: `calling | accepted | declined | no_answer | standby`. `no_answer` is set when a unit does not respond within `SAHAY_CALL_TIMEOUT_S` (default 30 s, demo 10 s) and the engine calls the next unit.

`dispatch.updated` (existing) gains optional `rank`.

### 9.3 REST

| Method + path | Role | Description |
|---|---|---|
| `PATCH /units/{id}/location` | service (own unit), admin | Already in 2.4, **not implemented yet**. Real GPS from a service phone. Broadcasts `unit.moved`. |
| `GET /public/units` | public (no login) | Units currently assigned to a confirmed incident, coarse. See 9.4. |
| `GET /incidents/{id}/calls` | admin, service (own dispatches) | `{ "incident_id", "calls": [dispatch rows], "lists": [dispatch.called payloads] }`. `lists` is what `dispatch.called` pushes, for first paint after a reload. |
| `GET /reports/{id}/calls` | owning civilian device | Response timeline for that device's report: `{ "report_id", "lists": [{ "service_type", "candidates": [{ "rank", "distance_km", "eta_minutes", "state" }] }] }`. Does not expose unit names or IDs. |

### 9.4 Public units feed

`GET /public/units` returns only units that are accepted, en route or on scene for a confirmed incident:
```json
{ "units": [ { "id": "opaque12", "service_type": "ambulance", "status": "help on the way",
               "location": { "lat": 9.971, "lng": 76.291 }, "incident": "opaque12", "eta_minutes": 2 } ],
  "generated_at": "..." }
```
Position rounded to 3 decimals (about 100 m, units are public vehicles, not people), no unit name, no crew, no unit id. Same rate limit and `Cache-Control: public, max-age=2` as `/public/incidents`. The public map polls it every 3 s while at least one unit is moving.

### 9.5 Demo mover (backend, no real vehicles needed)

A background task moves every `en_route` unit in a straight line from its position to the incident so that it arrives after `SAHAY_DEMO_ARRIVAL_SECONDS` (default 60), publishes `unit.moved` every second, and sets `on_scene` on arrival. Optional `SAHAY_DEMO_AUTO_ACCEPT_SECONDS` (default off, demo 5) accepts a called assignment automatically so a demo does not depend on someone tapping Accept. Both are off when a real service phone reports its own location. Road routing (OSRM) is a stretch goal; straight lines are fine for the demo.
