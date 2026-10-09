# Sahay | സഹായ് | सहाय | சஹாய்

An emergency and civic reporting app that works when the network doesn't. Speak a report, AI agents triage it, protect the reporter's identity and propose dispatch, and the nearest right service is sent. If the reporter's phone is offline, the encrypted report hops through a nearby phone to get out.

Built for TatHack'26 Finals, Track 4 (Civic Tech & Governance)

## How it works

```
Civilian phone (offline)                 Nearby phone (online)             Cloud
 voice + GPS -> encrypt -> queue  --Nearby Connections-->  carries opaque blob  -->  FastAPI
                                                                                     |
                           Admin map <-- WebSocket <-- agents: STT, intake, PII, triage, dedup
                           Services  <-- accept/status <-- deterministic nearest-unit dispatch
```

Delivery ladder per report: **Internet -> Nearby relay -> SMS -> store and retry.**

Key ideas:
- **Native-wrapped PWA.** React PWA + Capacitor + Kotlin plugin. A pure PWA cannot advertise over Bluetooth or send silent SMS. Android only.
- **Relay can't read your report.** Sealed-box encryption to the server key, signed with a device key.
- **Agents propose, code disposes.** LLMs classify, redact and summarize. Nearest-unit math is plain code.
- **Tamper-evident audit log.** Hash-chained; PII reveals are logged.

Full design doc (`solution.md`) is kept outside this repo, in the team's shared docs folder.

## Repo layout (target)

```
backend/    FastAPI, agents, dispatch engine, audit log      (Aswin foundation, Adnan agents/dispatch)
web/        React + Vite PWA: civilian, services, admin       (Shreyas)
android/    Capacitor project + Kotlin plugins (Nearby, SMS)  (Adnan)
design/     Design system (Shreyas), UX flows, deck (Adarsh)
contract/   fixtures + crypto test vectors shared by all
docs/       solution, API contract, issues, runbook
```

## Docs

| Doc | Purpose |
|---|---|
| `solution.md` (not in repo) | Product, security model, agent design, demo script |
| [docs/api-contract.md](docs/api-contract.md) | REST, WebSocket, envelope, Nearby and SMS contracts. **Source of truth.** |
| [docs/issues.md](docs/issues.md) | Work breakdown per person, milestones |

## Team

| Person | Role | Owns |
|---|---|---|
| Adnan | Native + hard backend | Android/Nearby/SMS, crypto ingest, dispatch, agents, STT, integration |
| Shreyas | Frontend + visual design | Web app, dashboards, client crypto, offline queue, design system, high-fidelity screens |
| Aswin | Backend foundation + frontend support | API scaffold, auth, WebSocket, incidents, audit log, deploy, Services/PII-reveal/PWA screens |
| Adarsh | UX + presentation | UX flows and wireframes, UI/UX testing, pitch deck, demo script, rehearsals |

## Working agreement

- Build against [api-contract.md](docs/api-contract.md). Contract changes go through a PR that the affected side reviews.
- Aswin ships `/dev/*` mock endpoints and fixtures first (B-01), so nobody waits.
- One branch per issue (`feat/B-04-dispatch`), PR with one review, `main` always runs.
- No secrets in git. Copy `.env.example` to `.env`.
- Full rules: [CONTRIBUTING.md](CONTRIBUTING.md).
- Never place a real call to 112 in testing or the demo. Dialer is opened prefilled with `ACTION_DIAL` only.

## Quick start (fill in as pieces land)

```bash
# backend
cd backend && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
SAHAY_DEV=1 uvicorn app.main:app --reload     # http://localhost:8000/docs

# web
cd web && npm install && npm run dev           # http://localhost:5173

# android
cd web && npm run build && npx cap sync android && npx cap open android
```

## Demo hardware

Two Android phones with Google Play Services (offline phone A, online phone B), a third phone for the emergency-contact SMS, laptop for Admin, optional second screen for Services. Venue Wi-Fi fallback: backend on laptop + phone hotspot.

## Known risks

Nearby Connections is Android-only; Android limits background work; Malayalam STT quality varies; silent SMS has Play Store restrictions (fine for a prototype); real deployment needs official integration with emergency services. See `solution.md` section 9.
