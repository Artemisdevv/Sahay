# Sahay backend

## Local development

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:SAHAY_DEV = "1"
uvicorn app.main:app --reload
```

OpenAPI docs are at <http://localhost:8000/docs>. The API base is `/api/v1`.
Development login accounts (only active when `SAHAY_DEV=1`):

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | admin |
| `amb-01` | `demo123` | service |
| `police-01` | `demo123` | service |
| `fire-01` | `demo123` | service |

Use `POST /api/v1/dev/seed` to reset the demo units and users. Demo state is
stored in `sahay.db` by default. Set `SAHAY_DATABASE_URL` to a PostgreSQL URL
for a shared development environment. Do not use the development credentials
or development JWT fallback outside local development.

Quick smoke flow: call `POST /api/v1/dev/seed`, then `POST /api/v1/auth/login`
with `{"username":"admin","password":"admin123"}`. Send the returned bearer
token to `GET /api/v1/units`. `POST /api/v1/dev/mock-report` accepts the plaintext
`ReportPayload` plus optional `severity`, `people_count`, `summary_redacted`,
`needed_services`, and `report_id` fields; it returns an illustrative incident,
proposed nearest seeded units, and mock trace steps.

`/dev/*` endpoints and demo credentials are disabled unless `SAHAY_DEV=1`.

## Auth, server key, and live updates

`GET /api/v1/config/server-key` returns the X25519 public key. In development,
the matching X25519 private key and Ed25519 signing seed are generated once and
saved in ignored files `backend/.sahay-server-key` and
`backend/.sahay-server-ed25519-key`. Keep both files with the local database so
previously queued reports and receipt signatures remain verifiable. In a
deployed environment, set `SAHAY_SERVER_X25519_SECRET_KEY` and
`SAHAY_SERVER_ED25519_SECRET_KEY` to base64-encoded 32-byte keys and
`SAHAY_JWT_SECRET` to a unique secret. The server refuses to start without the
JWT secret when `SAHAY_DEV` is disabled. Generate an X25519 server key with
`python -c "import base64; from nacl.public import PrivateKey; print(base64.b64encode(bytes(PrivateKey.generate())).decode())"`.
Generate an Ed25519 receipt-signing seed with
`python -c "import base64; from nacl.signing import SigningKey; print(base64.b64encode(bytes(SigningKey.generate())).decode())"`.

Device registration stores the Ed25519 public key and issues a civilian JWT.
Demo service/admin passwords are stored as PBKDF2 hashes. Auth endpoints and
authenticated API calls have configurable per-IP, per-user, or per-device
limits. The current limiter is process-local; use a shared limiter before
running multiple Cloud Run instances.

Register civilian devices with `POST /api/v1/auth/register-device`, supplying
the UUID and standard-base64 Ed25519 public key. Re-registering the same device
and key is idempotent; reusing a device ID with another key returns `409`.
Receipt creation should use `app.keyring.server_signing_key()` so signatures
match the public key returned by `/api/v1/config/server-key`.

Connect dashboards to `ws://localhost:8000/ws/v1?token=<jwt>` (or `wss://` in a
deployed environment). Send `{"type":"ping"}` to keep the connection active;
the server responds with `{"type":"pong"}`. Publish backend events through
`app.events.manager.publish`, supplying `service_unit_ids` for service-specific
incident updates and `civilian_device_id` for a civilian's own status event.
The connection manager is process-local, so run one backend instance for the
demo or add a shared pub/sub layer before scaling horizontally.
