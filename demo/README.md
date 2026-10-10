# Sahay demo simulator

## Always on, on the server (for the judges)

`docker compose up --build -d` also starts a second container, `responder`, next to the server. It is the demo
dispatcher and the ambulance, police and fire crews. Any distress report, whether from a phone, an SMS, the admin console
or `inject`, now gets a response with no one touching a terminal: the incident is approved, a crew accepts, drives there
(its marker moves on the civilian and admin maps, the civilian screen shows the ETA and "accepted"), works the scene and
finishes. A live **dispatch radio** page with the crews' chatter is on **http://localhost:8090** (put it on the projector).

It is isolated: its own container, only the public API, no shared code. `docker compose stop responder` switches it off and
the app does not notice. In `deploy/.env.demo` set `SAHAY_DEMO_MOVER=0` and `SAHAY_DEMO_AUTO_ACCEPT_SECONDS=0`,
`SAHAY_DEMO_AUTO_COMPLETE_SECONDS=0` (the server's own demo mover would race with it) and a higher
`SAHAY_RATE_LIMIT_PER_MINUTE` such as 600 (the responder polls from one IP). Knobs on the `responder` service in
`docker-compose.yml`: `SAHAY_DEMO_APPROVE` (`0` = leave approval to a human on stage), `SAHAY_DEMO_TRAVEL_SECONDS`,
`SAHAY_DEMO_WORK_SECONDS`, `SAHAY_DEMO_DECLINE_CHANCE`.

To trigger a call on cue from the laptop: `backend\.venv\Scripts\python.exe demo\sahay_demo.py inject heart-attack --lang ml`
(or use the phone app).

## Command line use

A pretend city for demonstrations. When a distress report arrives it plays the dispatcher and the field crews: an
ambulance accepts, drives there (its marker moves on the map), treats the patient, pre-alerts a hospital and finishes,
with radio-style chatter in the terminal. Nothing real is called or dispatched.

**Isolation.** It is a separate program that only talks to a running Sahay server over the public HTTP API, like a phone
or a browser would. It imports nothing from `backend/` or `web/`, adds no route and changes no setting. Delete the
`demo/` folder, or just stop the program, and Sahay is exactly as before.

## Run

Use the backend venv (it already has `httpx` and `pynacl`). From the repo root, with the Docker demo up on port 8080:

```
backend\.venv\Scripts\python.exe demo\sahay_demo.py list
backend\.venv\Scripts\python.exe demo\sahay_demo.py scenario heart-attack          # one citizen + the city, ends when crews are back
backend\.venv\Scripts\python.exe demo\sahay_demo.py respond                        # only the city: react to ANY incident (phones, SMS, admin)
backend\.venv\Scripts\python.exe demo\sahay_demo.py inject house-fire --lang ml    # only the citizen (a sealed report from a throw-away device)
```

Scenarios: `heart-attack`, `house-fire`, `road-accident`, `flood`, `burglary`. `--lang ml` makes the caller speak Malayalam.

Useful flags: `--api https://<tunnel>/api/v1`, `--travel-seconds 30` (drive time), `--work-seconds 20`, `--no-approve`
(leave high-severity approval to a human in the admin console), `--decline-chance 0.3` (some crews are busy and the
call moves on). Staff passwords are read from `deploy/.env.demo` (`SAHAY_SEED_*`) or `--admin-password`, `--service-password`.

## What it does
- **Dispatcher:** after a short pause approves incidents that wait for admin approval (high severity, SOS). A dispatch
  that goes to a unit nobody plays (Ambulance 02, Fire 02) gets "no answer on the radio" and is reassigned to the
  simulated crew of the same type.
- **Crews** (`amb-01`, `police-01`, `fire-01`): think, accept (or decline), go en route, move along a straight line
  while reporting position (`PATCH /units/{id}/location`), arrive, work the scene, complete. The text depends on the
  scenario and the unit type. Ambulance crews in scenarios with a hospital line also trigger the "hospital ER" messages.
- **Hospital:** only text in the terminal; the server has no hospital API.

## Notes
- The server's own demo mover (`SAHAY_DEMO_MOVER`, `SAHAY_DEMO_AUTO_*` in `deploy/.env.demo`) also accepts and moves units.
  Turn those off when you want this simulator to be the only actor, or the two will race (harmless, but 409s in the log).
- Only the three units with a login can be played. Dispatches to other units are rerouted as above (when the simulated crew of that type is free).
- Crews drive back to their station after every job. The service ignores incidents that existed before it started.
- Needs the server in the demo seed (`SAHAY_SEED_*` passwords or `/dev/seed`).
