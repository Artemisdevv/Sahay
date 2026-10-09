# Sahay Work Breakdown

Owners (tag in brackets on each item): **Adnan** native/Android, crypto, dispatch, agents, STT, integration; **Aswin** backend foundation (scaffold, auth, realtime, incidents, audit, deploy) plus Services/Admin-extras frontend; **Shreyas** frontend plus visual design (design system, high-fidelity screens): civilian app, Distress Map, admin incident panel; **Adarsh** UX flow, UI/UX testing, pitch deck and presentation.
Each item below becomes a GitHub issue (title = `ID: title`, labels = area + milestone). Contract: [api-contract.md](api-contract.md).

Milestones:
- **M0 Unblock (first hours):** everyone can run something. Mock API, scaffold, wireframes, Nearby spike.
- **M1 Vertical slice:** one voice report goes civilian -> (relay) -> backend -> admin map -> services accept.
- **M2 Complete demo:** SOS/SMS, audit log, PII reveal, status back to civilian.
- **M3 Polish:** rehearsal, fallbacks, deck, stretch items.

Dependency rule: frontend and native work against the **contract and `/dev/*` mock endpoints**, not against unfinished backend features.

---

## Backend (`backend/`, label `backend`): split Adnan (hard parts) / Aswin (foundation)

**B-01 [Aswin] (M0) FastAPI scaffold, seed data, dev/mock endpoints, fixtures.** *Do first, it unblocks everyone.*
- FastAPI app, `/api/v1`, CORS, `SAHAY_DEV` flag, Firestore or Postgres wired.
- `POST /dev/seed`, `/dev/mock-report`, `/dev/reset`, `/dev/tick` per contract 2.6, seeded units and logins per contract 7.
- Commit `contract/fixtures/*.json` for every schema; publish OpenAPI at `/docs`.
- Done when: Shreyas can log in as admin and list seeded units from localhost.

**B-02 [Aswin] (M0) Auth and device registration.** JWT, roles, `register-device`, `login`, `server-key`, per-device rate limit.

**B-03 [Adnan] (M1) Report ingest.** `POST /reports`: size check, Ed25519 verify, sealed-box decrypt, idempotency on `report_id`, signed receipt, `reports/mine`, `reports/{id}/status`. Unit tests with a test vector shared with Shreyas (B-03 publishes `contract/crypto-test-vector.json`).

**B-04 [Adnan] (M1) Deterministic dispatch engine.** `find_nearest_available(service_type, lat, lng)` Haversine plus ETA, unit state machine, decline -> next nearest, approve/reject/reassign endpoints. 100% unit-tested, no LLM in this path.

**B-05 [Adnan] (M1) STT integration and Malayalam test.** Choose provider after testing 10 sample clips (ml, hi, en, with background noise). Write results to `docs/stt-eval.md`. Transcribe server-side on ingest. *Needs sample clips from Adarsh (D-05).*

**B-06 [Adnan] (M1) Agent pipeline: intake, PII, triage.** Structured outputs (Pydantic), regex plus LLM PII tagging, redacted summary, web-search tool for triage context. Each step emits `agent.trace`. Mock LLM mode for tests and offline demo.

**B-07 [Aswin] (M1) Realtime WebSocket.** `/ws/v1` per contract 3, role-filtered broadcasts.

**B-08 [Aswin] (M2) Incidents API and PII reveal.** List/get/trace, redacted vs full views, `reveal` with mandatory reason, field-level encryption of PII at rest.

**B-09 [Aswin] (M2) Hash-chained audit log.** Append on every action in contract 2.5, `GET /audit`, `GET /audit/verify`, tamper test.

**B-10 [Adnan] (M2) SMS gateway inbound and follow-up agent.** Parse `SAHAY1|...`, create incident from SMS, follow-up notifications (WS status, SMS out), flag stale incidents.

**B-11 [Adnan] (M2) Dedup/cluster agent.** Merge nearby same-type reports within a window into one incident with `report_count`.

**B-12 [Aswin] (M3) Deploy.** Dockerfile, Cloud Run, plus local-laptop + hotspot run mode for the venue fallback. `docs/runbook.md`.

---

## Frontend (`web/`, label `frontend`): Shreyas, with Aswin on F-06/F-08/F-09

**F-01 [Shreyas] (M0) Vite + React + TS scaffold.** Routing for `/civilian`, `/services`, `/admin`; auth context; typed API client generated from OpenAPI (or hand-typed from contract); MSW mock using fixtures. Dark theme tokens from Adarsh's design system when ready.

**F-02 [Shreyas] (M1) Civilian: hold-to-talk report.** MediaRecorder Opus with `noiseSuppression/echoCancellation/autoGainControl`, GPS capture offline, quick-tap category buttons (fallback), preview, send.

**F-03 [Shreyas] (M1) Client crypto and offline queue.** libsodium: device Ed25519 keys, sealed box to server key, envelope build per contract 1.2. IndexedDB encrypted queue, retry with backoff, service worker. Must pass `contract/crypto-test-vector.json` from B-03.

**F-04 [Shreyas] (M1) Admin Distress Map.** MapLibre/Leaflet dark style, incident markers with pulse by severity, unit icons moving on `unit.moved`, click for detail. Dispatch-game feel.

**F-05 [Shreyas] (M1) Admin incident panel.** List, agent trace timeline, proposed dispatches with ETAs, approve/reject/reassign.

**F-06 [Aswin] (M1) Services dashboard.** Login by unit, redacted incident view, accept/decline, status buttons, shares unit location.

**F-07 [Shreyas] (M2) Civilian status and SOS UI.** Report status page (live via WS or polling), SOS hold button, emergency contacts with consent screen, calls Aswin's plugins via a thin `native.ts` adapter (stub on web).

**F-08 [Aswin] (M2) Admin PII reveal and audit view.** Reveal modal with required reason, audit list with chain-verified badge.

**F-09 [Aswin] (M2) PWA install and offline shell.** Manifest, icons, service worker cache for the shell.

**F-10 [Shreyas] (M3) i18n.** English, Malayalam, Hindi strings from Adarsh (D-06).

---

## Native and integration (`android/`, label `native`): all Adnan

**N-01 [Adnan] (M0) Capacitor wrap.** `npx cap add android` on Shreyas's scaffold, signed debug build runs on both test phones, installs via USB/APK. Document in `android/README.md`.

**N-02 [Adnan] (M0) Nearby Connections spike.** Kotlin plugin `SahayNearby`: advertise on phone A, discover and auto-accept on phone B, send a 50 KB payload with the app handshake. **Riskiest item, report result in first session.** Include permission flow for Android 12+ (`BLUETOOTH_*`, `NEARBY_WIFI_DEVICES`) and older (location).

**N-03 [Adnan] (M1) Relay protocol.** Implement contract section 5: hello/envelope/ack/receipt/status, TTL and hops, dedupe, store-and-forward queue in native storage, upload hand-off events to web layer.

**N-04 [Adnan] (M1) Foreground service.** Keep advertise/discover alive with screen off (Android 14 service type, notification). Battery notes in docs.

**N-05 [Adnan] (M2) `SahaySms` plugin.** Silent SMS via `SmsManager`, runtime permission, `openDialer` (ACTION_DIAL only). Test with a real SIM.

**N-06 [Adnan] (M2) WebView permissions.** Mic and GPS permission grants for Capacitor WebView, handle denial gracefully.

**N-07 [Adnan] (M2) End-to-end integration test.** Scripted two-phone scenario from the demo: offline phone -> relay -> server -> admin map -> status back. Log results in `docs/e2e-results.md`.

**N-08 [Adnan] (M3) Device matrix and fallbacks.** Test on all available phones, record the 20-second relay success clip (for stage fallback), document known-bad devices.

---

## Design and UX (`design/`, `docs/`, label `design`): visual design is Shreyas (D-01, D-03); UX flow, UI/UX testing, deck and presentation are Adarsh

**D-01 [Shreyas] (M0) Design system.** Dark "Dispatch" look: colors (severity scale), type, spacing, map marker and unit icon set, motion rules. Figma plus tokens JSON for Shreyas.

**D-02 [Adarsh] (M0) UX flows and wireframes for all three dashboards plus civilian flows.** Civilian screens must be usable under stress: one-hand, huge hold-to-talk button, minimal text, status clarity.

**D-03 [Shreyas] (M1) High-fidelity screens.** Distress Map, incident panel with agent trace, services card, PII reveal modal, audit log.

**D-04 [Adarsh] (M1) Demo script and run sheet.** Turn section 7 of `solution.md` (shared outside the repo) into a minute-by-minute run sheet with roles per person and physical setup checklist.

**D-05 [Adarsh] (M1) Voice sample set.** Record about 10 clips, Malayalam/Hindi/English, with and without background noise, for B-05. Include ground-truth transcripts.

**D-06 [Adarsh] (M2) Copy and translations.** All UI strings in English, Malayalam, Hindi; review emergency wording.

**D-07 [Adarsh] (M2) Pitch deck.** Problem, solution, delivery ladder, security model, agent pipeline, why it wins. Max 8 slides.

**D-08 [Adarsh] (M3) Rehearsals and fallback drill.** Three full run-throughs, one with relay failing, one with STT failing, one with venue Wi-Fi down. UI/UX testing with real users on the two phones, plus accessibility pass (contrast, tap targets).

---

## Cross-cutting

**X-01 [Adnan] (M0) Repo conventions.** Branch per issue, PR needs one review, `main` always runs. Owner: Adnan.
**X-02 [Adnan] (M0) Shared crypto test vector.** Backend generates (B-03), frontend and native consume. Prevents the usual signature-mismatch day.
**X-03 [Adnan] (M3) Stretch (cut first):** RNNoise WASM, multi-hop beyond 2 phones, on-device transcription, offline tile cache.

## First-session checklist

1. Aswin: B-01 first (unblocks everyone), then B-02. Follow the contract exactly.
2. Shreyas: F-01 against fixtures.
3. Adnan: X-01, then N-01 and N-02 on two real phones; B-03 crypto test vector right after.
4. Adarsh: D-02 (UX flows), and record voice samples (D-05). Shreyas picks up D-01 (design system) alongside F-01.
