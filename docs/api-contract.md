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
{ "key_id": "k1", "x25519_public_key": "<base64>" }
```

**`POST /auth/register-device`** (public, rate-limited)
```json
// request
{ "device_id": "uuid", "ed25519_public_key": "<base64>", "language": "ml" }
// 201
{ "token": "jwt", "role": "civilian", "device_id": "uuid" }
```

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
{ "report_id": "uuid", "status": "dispatched", "eta_minutes": 6, "message": "Help dispatched, ETA 6 min", "updated_at": "..." }
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
| `GET /incidents?status=&type=&limit=&cursor=` | admin, service | Admin gets all. Service gets only incidents with a dispatch to its unit. Redacted shape. |
| `GET /incidents/{id}` | admin, service | Single `Incident` plus `dispatches[]`. |
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
  "reporters": [ { "report_id": "uuid", "name": "...", "phone": "...", "language": "ml" } ],
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
`hash = SHA-256( seq | ts | actor | action | target | canonical_json(details) | prev_hash )`, fields joined with `|`, details serialized as sorted-key compact JSON. The first entry has `prev_hash = "0"*64`.

Actions (not exhaustive): `report.received`, `agent.intake`, `agent.pii`, `agent.triage`, `dispatch.propose`, `dispatch.approve`, `dispatch.accept`, `dispatch.decline`, `dispatch.status`, `incident.resolve`, `pii.reveal`, `auth.login`.

- `GET /audit?limit=&after_seq=` (admin) returns `{ "entries": [AuditEntry] }`
- `GET /audit/verify` (admin) returns `{ "valid": true, "checked": 120, "first_bad_seq": null }`

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

`GET /ws/v1?token=<jwt>` (WebSocket). Server pushes; client messages are not used except `{"type":"ping"}`.

Message shape:
```json
{ "type": "incident.updated", "ts": "...", "data": { } }
```

| `type` | `data` | Who receives |
|---|---|---|
| `incident.created` | `Incident` | admin |
| `incident.updated` | `Incident` | admin, service (own dispatches) |
| `dispatch.proposed` | `Dispatch` | admin |
| `dispatch.updated` | `Dispatch` | admin, service (own unit) |
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
{ "t": "status", "report_id": "uuid", "status": "dispatched", "message": "..." }
```

Rules:
1. Relay handles `hello` first. Non-Sahay peers (`app != "sahay"`) are disconnected.
2. Relay verifies the **signature** shape (non-empty, length 64) cheaply. Full verification needs the device public key and happens at the server, so relays accept and forward.
3. Dedupe by `report_id`. Drop at `hops >= ttl`. Increment `hops` before forwarding.
4. Phone with internet uploads via `POST /reports`, then sends `receipt` back to the source peer(s).
5. Relay UI shows only a count ("Carrying N encrypted reports"), never contents.

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
