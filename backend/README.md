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
or the example JWT secret outside local development.

Quick smoke flow: call `POST /api/v1/dev/seed`, then `POST /api/v1/auth/login`
with `{"username":"admin","password":"admin123"}`. Send the returned bearer
token to `GET /api/v1/units`. `POST /api/v1/dev/mock-report` accepts the plaintext
`ReportPayload` plus optional `severity`, `people_count`, `summary_redacted`,
`needed_services`, and `report_id` fields; it returns an illustrative incident,
proposed nearest seeded units, and mock trace steps.

`/dev/*` endpoints and demo credentials are disabled unless `SAHAY_DEV=1`.
