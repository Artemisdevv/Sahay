"""Sahay demo simulator: a pretend city that reacts when someone is in distress.

PURELY FOR DEMONSTRATION. It is a separate program that talks to a running Sahay server over the same public HTTP
API a phone or a browser uses. It imports nothing from `backend/` or `web/`, changes no server setting and adds no
route. Stop it and Sahay behaves exactly as before.

What it plays (all fake, nobody is called, nothing real is dispatched):
  * a citizen (`inject`): sends a sealed distress report, e.g. a heart attack, from a throw-away device;
  * the dispatcher (`--approve`): approves high-severity incidents after a human-sized pause;
  * the field crews (`respond`): the ambulance / police / fire units that have a login accept, drive there (their
    position moves on the map), arrive, work the scene, and finish, with radio-style chatter and a hospital hand-off.

Run with the backend venv (needs httpx and pynacl):
    backend\\.venv\\Scripts\\python.exe demo\\sahay_demo.py scenario heart-attack
See demo/README.md.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import os
import random
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
os.system("")  # constant empty command (no input): the known trick that turns on ANSI colours in Windows terminals
C = {"dim": "\033[2m", "red": "\033[91m", "grn": "\033[92m", "yel": "\033[93m", "blu": "\033[94m", "mag": "\033[95m",
     "cyn": "\033[96m", "bold": "\033[1m", "off": "\033[0m"}
T0 = time.monotonic()


def say(who: str, text: str, colour: str = "cyn") -> None:
    t = int(time.monotonic() - T0)
    print(f"{C['dim']}T+{t // 60:02d}:{t % 60:02d}{C['off']}  {C[colour]}{who:<18}{C['off']} {text}", flush=True)


# ---------------------------------------------------------------------------------------------------------------
# Scenarios: what the citizen says and what each kind of crew says as the job goes on.
# ---------------------------------------------------------------------------------------------------------------
@dataclass
class Scenario:
    key: str
    title: str
    category: str  # quick-tap category the app would send
    text: dict[str, str]  # language -> what the caller says
    near: tuple[float, float]  # where it happens (Kochi)
    chatter: dict[str, dict[str, list[str]]]  # service_type -> phase -> lines
    hospital: list[str] = field(default_factory=list)


SCENARIOS: dict[str, Scenario] = {
    "heart-attack": Scenario(
        "heart-attack", "Heart attack at home", "medical",
        {"en": "Please help, my father is clutching his chest, he is sweating and having trouble breathing, he is "
               "getting dizzy and may faint. Near Edappally junction, please send an ambulance quickly.",
         "ml": "ദയവായി സഹായിക്കൂ, എന്റെ അച്ഛന് നെഞ്ചുവേദനയാണ്, വിയർക്കുന്നു, ശ്വാസം മുട്ടുന്നു, തലകറങ്ങി വീഴാൻ പോകുന്നു. "
               "ഇടപ്പള്ളി ജംഗ്ഷന് അടുത്താണ്, വേഗം ആംബുലൻസ് അയക്കൂ."},
        (10.0261, 76.3080),
        {"ambulance": {
            "accept": ["Copy. Chest pain, possible cardiac event. Taking the cardiac kit and defibrillator."],
            "enroute": ["Rolling with lights and siren. Keep the patient seated and still, unlock the front door."],
            "onscene": ["On scene. Male, 60s, conscious, pale and sweating, pain radiating to the left arm.",
                        "12-lead ECG attached."],
            "work": ["ECG shows ST elevation. This is a STEMI. Aspirin given, oxygen on, IV line in.",
                     "Pre-alerting City General Hospital: STEMI on the way, activate the cath lab."],
            "done": ["Patient stable and loaded. Transporting to City General Hospital, ETA 9 minutes.",
                     "Handover complete at the ER. Back in service."]},
         "police": {
            "accept": ["Copy. Will clear the route and the crossing for the ambulance."],
            "enroute": ["Moving to the junction to hold traffic."],
            "onscene": ["Traffic held at the junction, ambulance route is open."],
            "work": ["Neighbours are keeping the street clear."],
            "done": ["Route open again. Closing out."]}},
        ["City General ER: STEMI alert received. Cath lab and cardiology team standing by, bed 4 assigned.",
         "City General ER: ambulance has arrived, patient moved straight to the cath lab."]),
    "house-fire": Scenario(
        "house-fire", "House fire with a person inside", "fire",
        {"en": "Fire in our building at Kalamassery, the second floor, there is a lot of smoke and my neighbour is "
               "still inside. Please send the fire force now.",
         "ml": "കളമശ്ശേരിയിൽ ഞങ്ങളുടെ കെട്ടിടത്തിൽ തീപിടിച്ചു, രണ്ടാമത്തെ നിലയിൽ, നിറയെ പുകയുണ്ട്, അയൽക്കാരൻ അകത്തുണ്ട്. "
               "വേഗം ഫയർഫോഴ്സിനെ അയക്കൂ."},
        (10.0536, 76.3270),
        {"fire": {
            "accept": ["Copy. Structure fire, person reported inside. Full turnout."],
            "enroute": ["En route. Pump and ladder rolling. Water supply check on the way."],
            "onscene": ["On scene. Heavy smoke from the second floor. Starting the primary search."],
            "work": ["Victim located and brought out, breathing. Handing over to the ambulance.",
                     "Hose lines on the second floor. Fire is knocked down."],
            "done": ["Fire out, overhaul done, structure safe. Returning to station."]},
         "ambulance": {
            "accept": ["Copy. Standing by for smoke inhalation."],
            "enroute": ["Rolling. Oxygen and burn kit ready."],
            "onscene": ["On scene. Patient from the fire crew, smoke inhalation, coughing."],
            "work": ["Oxygen on, vitals stable. Transporting for observation."],
            "done": ["Handed over at the hospital. Back in service."]},
         "police": {
            "accept": ["Copy. Securing the cordon."],
            "enroute": ["Moving to the building to keep the road clear."],
            "onscene": ["Crowd moved back, fire lane open."],
            "work": ["Taking details from residents."],
            "done": ["Cordon released."]}},
        ["Aster ER: fire casualty alert received, one smoke inhalation patient expected."]),
    "road-accident": Scenario(
        "road-accident", "Road accident with injuries", "accident",
        {"en": "Bike and car collided near Vyttila junction, two people are hurt, one is bleeding badly and not "
               "moving. Please send an ambulance and the police.",
         "ml": "വൈറ്റില ജംഗ്ഷന് അടുത്ത് ബൈക്കും കാറും കൂട്ടിയിടിച്ചു, രണ്ടുപേർക്ക് പരിക്കുണ്ട്, ഒരാൾ ഒരുപാട് രക്തം പോകുന്നു, "
               "അനങ്ങുന്നില്ല. ആംബുലൻസും പോലീസും വേണം."},
        (9.9671, 76.3200),
        {"ambulance": {
            "accept": ["Copy. Two casualties, one with heavy bleeding. Trauma kit loaded."],
            "enroute": ["Rolling. Tell bystanders to press on the wound and not move the rider."],
            "onscene": ["On scene. Rider unresponsive, heavy bleeding from the leg. Tourniquet on."],
            "work": ["Second patient has a wrist injury, stable. Both immobilised."],
            "done": ["Both patients loaded. Transporting to the trauma centre, pre-alert sent."]},
         "police": {
            "accept": ["Copy. Collision with injuries, heading to control traffic."],
            "enroute": ["En route. Diverting traffic at Vyttila."],
            "onscene": ["On scene. Lane closed, vehicles photographed."],
            "work": ["Statements taken from two witnesses."],
            "done": ["Vehicles moved, road reopened."]}},
        ["Trauma centre: two casualties incoming, trauma team and blood bank alerted."]),
    "flood": Scenario(
        "flood", "Street flooding", "flood",
        {"en": "Water is rising fast in our street at Thevara, it is already at knee height and an old woman cannot "
               "leave her house. We need a boat or help to get out.",
         "ml": "തേവരയിൽ ഞങ്ങളുടെ തെരുവിൽ വെള്ളം പെട്ടെന്ന് ഉയരുന്നു, മുട്ടൊപ്പം ആയി, ഒരു വൃദ്ധയ്ക്ക് വീട്ടിൽ നിന്ന് ഇറങ്ങാൻ പറ്റുന്നില്ല. "
               "ബോട്ടോ സഹായമോ വേണം."},
        (9.9490, 76.2970),
        {"fire": {
            "accept": ["Copy. Rescue boat and two swimmers. Heading to Thevara."],
            "enroute": ["Launching the boat from the nearest ramp."],
            "onscene": ["On scene. Water chest high in the lane. Reaching the house."],
            "work": ["Woman evacuated by boat, cold but unhurt. Checking the neighbouring houses."],
            "done": ["Four residents moved to the relief camp. Closing out."]},
         "ambulance": {
            "accept": ["Copy. Standing by at dry ground."],
            "enroute": ["Rolling to the staging point."],
            "onscene": ["Staging at the relief camp."],
            "work": ["Checked the evacuated woman, mild hypothermia, warm blankets given."],
            "done": ["No transport needed. Back in service."]}},
        []),
    "burglary": Scenario(
        "burglary", "Break-in in progress", "other",
        {"en": "Someone is breaking into the house next door at Panampilly Nagar, I can hear glass breaking and "
               "people shouting. Please send the police.",
         "ml": "പനമ്പിള്ളി നഗറിൽ അടുത്ത വീട്ടിൽ ആരോ അതിക്രമിച്ചു കയറുന്നു, ചില്ല് പൊട്ടുന്ന ശബ്ദവും ആളുകളുടെ ബഹളവും കേൾക്കുന്നു. "
               "പോലീസിനെ അയക്കൂ."},
        (9.9560, 76.2900),
        {"police": {
            "accept": ["Copy. Break-in in progress. Two cars, approaching quietly."],
            "enroute": ["Lights off on the last street. Do not go outside, stay indoors."],
            "onscene": ["On scene. Rear window broken, suspects seen running."],
            "work": ["One suspect detained, one fled on foot. Searching the area."],
            "done": ["House secured, owner informed. Report filed."]}},
        []),
}
# phase names used by the crews, in order
PHASES = ["accept", "enroute", "onscene", "work", "done"]
GENERIC = {
    "accept": "Copy dispatch. Accepting.", "enroute": "En route.", "onscene": "On scene.",
    "work": "Working the scene.", "done": "Job complete. Back in service.",
}


# ---------------------------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------------------------
def read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def km(a: tuple[float, float], b: tuple[float, float]) -> float:
    (la1, lo1), (la2, lo2) = a, b
    p = math.pi / 180
    h = math.sin((la2 - la1) * p / 2) ** 2 + math.cos(la1 * p) * math.cos(la2 * p) * math.sin((lo2 - lo1) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def lerp(a: tuple[float, float], b: tuple[float, float], f: float) -> tuple[float, float]:
    return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def inject(api: str, key: str, text: str, category: str, where: tuple[float, float], language: str) -> str:
    """Send one sealed distress report from a throw-away device, exactly like the phone app does. Returns report_id."""
    from nacl.public import PublicKey, SealedBox
    from nacl.signing import SigningKey

    http = httpx.Client(timeout=30, headers={"ngrok-skip-browser-warning": "1"})
    server = http.get(f"{api}/config/server-key").raise_for_status().json()
    sk, device = SigningKey.generate(), str(uuid.uuid4())
    challenge = http.post(f"{api}/auth/device-challenge", json={"device_id": device}).raise_for_status().json()["challenge"]
    token = http.post(f"{api}/auth/register-device", json={
        "device_id": device, "ed25519_public_key": b64(bytes(sk.verify_key)), "language": language, "challenge": challenge,
        "challenge_signature": b64(sk.sign(f"sahay-register-v1|{device}|{challenge}".encode()).signature),
    }).raise_for_status().json()["token"]
    lat = where[0] + random.uniform(-0.002, 0.002)
    lng = where[1] + random.uniform(-0.002, 0.002)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    payload = {"schema": 1, "kind": "report", "category": category, "language": language, "captured_at": now,
               "location": {"lat": round(lat, 5), "lng": round(lng, 5), "accuracy_m": 15}, "text": text, "audio": None}
    sealed = SealedBox(PublicKey(base64.b64decode(server["x25519_public_key"]))).encrypt(json.dumps(payload).encode())
    rid = str(uuid.uuid4())
    sig = sk.sign(f"{rid}|{device}|{now}|".encode() + sealed).signature
    r = http.post(f"{api}/reports", headers={"Authorization": f"Bearer {token}"}, json={
        "envelope_version": 1, "report_id": rid, "device_id": device, "created_at": now, "ttl": 5,
        "key_id": server["key_id"], "ciphertext": b64(sealed), "signature": b64(sig)})
    r.raise_for_status()
    return rid


# ---------------------------------------------------------------------------------------------------------------
# The responders
# ---------------------------------------------------------------------------------------------------------------
@dataclass
class Options:
    api: str
    admin_password: str
    service_password: str
    approve: bool
    approve_delay: tuple[float, float]
    think: tuple[float, float]
    travel_seconds: float
    work_seconds: float
    decline_chance: float
    scenario: Scenario | None


class City:
    def __init__(self, opt: Options):
        self.o = opt
        self.http = httpx.AsyncClient(base_url=opt.api, timeout=20, headers={"ngrok-skip-browser-warning": "1"})
        self.admin = ""
        self.units: dict[str, dict] = {}  # username -> {token, unit_id, name, type}
        self.seen_incidents: set[str] = set()
        self.seen_dispatches: set[str] = set()
        self.done_incidents: set[str] = set()
        self.tasks: set[asyncio.Task] = set()
        self.unmanned: dict[str, float] = {}  # dispatch_id -> when we first saw it going to a crew nobody plays
        self.rerouted: set[str] = set()

    async def call(self, method: str, path: str, token: str, **kw):
        return await self.http.request(method, path, headers={"Authorization": f"Bearer {token}"}, **kw)

    async def login(self, username: str, password: str) -> dict:
        r = await self.http.post("/auth/login", json={"username": username, "password": password})
        r.raise_for_status()
        return r.json()

    async def open(self) -> None:
        self.admin = (await self.login("admin", self.o.admin_password))["token"]
        units = (await self.call("GET", "/units", self.admin)).json()
        units = units.get("units", units) if isinstance(units, dict) else units
        by_id = {u["unit_id"]: u for u in units}
        for name in ("amb-01", "police-01", "fire-01"):
            try:
                s = await self.login(name, self.o.service_password)
            except httpx.HTTPError:
                say("simulator", f"no login for {name}, that unit will be left to a real operator", "yel")
                continue
            unit = by_id.get(s.get("unit_id"), {})
            self.units[name] = {"token": s["token"], "unit_id": s.get("unit_id"), "name": unit.get("name", name),
                                "type": unit.get("service_type", "ambulance")}
            say("simulator", f"{self.units[name]['name']} crew is on shift ({self.units[name]['type']})", "dim")

    # --- dispatcher ---------------------------------------------------------------------------------------------
    async def watch_incidents(self) -> None:
        r = await self.call("GET", "/incidents", self.admin)
        if r.status_code != 200:
            return
        for inc in r.json().get("incidents", []):
            iid = inc["incident_id"]
            if iid not in self.seen_incidents and inc.get("status") in ("pending_approval", "triaged", "dispatched"):
                self.seen_incidents.add(iid)
                loc = inc.get("location", {})
                say("system", f"INCIDENT {inc['incident_type'].upper()} severity {inc['severity']}: "
                              f"{inc['summary_redacted'][:110]}", "red")
                say("system", f"location {loc.get('lat')}, {loc.get('lng')}, services needed: "
                              f"{', '.join(inc.get('needed_services', []))}", "dim")
                if inc["status"] == "pending_approval":
                    if self.o.approve:
                        self.spawn(self.approve_later(inc))
                    else:
                        say("dispatcher", "waiting for a human to approve this incident in the admin console", "yel")

    async def approve_later(self, inc: dict) -> None:
        await asyncio.sleep(random.uniform(*self.o.approve_delay))
        say("dispatcher", f"reviewing severity {inc['severity']} {inc['incident_type']}, "
                          "caller location plausible, approving dispatch", "mag")
        r = await self.call("POST", f"/incidents/{inc['incident_id']}/approve", self.admin)
        if r.status_code >= 300:
            say("dispatcher", f"approval failed ({r.status_code}), someone else may have done it", "yel")

    async def watch_unmanned(self) -> None:
        """A dispatch can go to a unit with no login (Ambulance 02, Fire 02...). A real dispatcher would hear nothing back
        on the radio and send another crew, so after a pause we reassign it to the simulated crew of the same type."""
        mine = {u["unit_id"]: n for n, u in self.units.items()}
        busy = {d for d in self.seen_dispatches}
        for iid in list(self.seen_incidents - self.done_incidents):
            r = await self.call("GET", f"/incidents/{iid}", self.admin)
            if r.status_code != 200:
                continue
            for d in r.json().get("dispatches", []):
                did = d["dispatch_id"]
                if d["status"] != "approved" or d["unit_id"] in mine or did in self.rerouted or did in busy:
                    continue
                first = self.unmanned.setdefault(did, time.monotonic())
                if time.monotonic() - first < 8:
                    continue
                crew = next((u for u in self.units.values() if u["type"] == d["service_type"]), None)
                if crew is None:
                    continue
                self.rerouted.add(did)
                say("dispatcher", f"no answer on the radio from the {d['service_type']} unit, "
                                  f"reassigning to {crew['name']}", "mag")
                rr = await self.call("POST", f"/incidents/{iid}/reassign", self.admin,
                                     json={"needed_service": d["service_type"], "unit_id": crew["unit_id"]})
                if rr.status_code >= 300:
                    say("dispatcher", f"reassign failed ({rr.status_code})", "yel")

    # --- crews --------------------------------------------------------------------------------------------------
    async def watch_dispatches(self) -> None:
        for username, u in self.units.items():
            r = await self.call("GET", "/dispatches/mine", u["token"])
            if r.status_code != 200:
                continue
            for d in r.json().get("dispatches", []):
                if d["status"] == "approved" and d["dispatch_id"] not in self.seen_dispatches:
                    self.seen_dispatches.add(d["dispatch_id"])
                    self.spawn(self.run_dispatch(username, d))

    async def status(self, u: dict, d: dict, status: str) -> bool:
        r = await self.call("POST", f"/dispatches/{d['dispatch_id']}/status", u["token"], json={"status": status})
        if r.status_code >= 300:
            say(u["name"], f"could not set {status} ({r.status_code})", "yel")
        return r.status_code < 300

    async def run_dispatch(self, username: str, d: dict) -> None:
        u = self.units[username]
        name, stype = u["name"], u["type"]
        inc = (await self.call("GET", f"/incidents/{d['incident_id']}", self.admin)).json()
        inc = inc.get("incident", inc)
        where = (inc["location"]["lat"], inc["location"]["lng"])
        chat = (self.o.scenario.chatter.get(stype, {}) if self.o.scenario else {})
        say(name, f"dispatch received: {inc['incident_type']}, {d['distance_km']} km, ETA {d['eta_minutes']} min", "blu")
        await asyncio.sleep(random.uniform(*self.o.think))

        if random.random() < self.o.decline_chance:
            say(name, "declining: crew is on another call, passing it to the next unit", "yel")
            await self.call("POST", f"/dispatches/{d['dispatch_id']}/decline", u["token"], json={"reason": "crew busy"})
            return
        r = await self.call("POST", f"/dispatches/{d['dispatch_id']}/accept", u["token"])
        if r.status_code >= 300:
            say(name, f"accept failed ({r.status_code}), another unit probably took it", "yel")
            return
        for line in chat.get("accept", [GENERIC["accept"]]):
            say(name, line, "grn")
        await asyncio.sleep(2)
        await self.status(u, d, "en_route")
        for line in chat.get("enroute", [GENERIC["enroute"]]):
            say(name, line, "grn")

        units = (await self.call("GET", "/units", self.admin)).json()
        units = units.get("units", units) if isinstance(units, dict) else units
        me = next((x for x in units if x["unit_id"] == u["unit_id"]), None)
        start = (me["location"]["lat"], me["location"]["lng"]) if me else where
        steps = max(4, int(self.o.travel_seconds / 2))
        marks = {int(steps * f) for f in (0.25, 0.5, 0.75)}
        for i in range(1, steps + 1):
            pos = lerp(start, where, i / steps)
            await self.call("PATCH", f"/units/{u['unit_id']}/location", u["token"], json={"lat": pos[0], "lng": pos[1]})
            if i in marks:
                say(name, f"{km(pos, where):.1f} km to go", "dim")
            await asyncio.sleep(self.o.travel_seconds / steps)
        await self.status(u, d, "on_scene")
        for line in chat.get("onscene", [GENERIC["onscene"]]):
            say(name, line, "grn")
        lines = chat.get("work", [GENERIC["work"]])
        for line in lines:
            await asyncio.sleep(self.o.work_seconds / (len(lines) + 1))
            say(name, line, "grn")
        if stype == "ambulance" and self.o.scenario and self.o.scenario.hospital:
            say("hospital", self.o.scenario.hospital[0], "mag")
        await asyncio.sleep(self.o.work_seconds / (len(lines) + 1))
        done_lines = chat.get("done", [GENERIC["done"]])
        for line in done_lines[:-1]:
            say(name, line, "grn")
            await asyncio.sleep(2)
        if stype == "ambulance" and self.o.scenario and len(self.o.scenario.hospital) > 1:
            say("hospital", self.o.scenario.hospital[1], "mag")
        await self.status(u, d, "completed")
        say(name, done_lines[-1], "grn")
        self.done_incidents.add(d["incident_id"])

    async def guarded(self, coro) -> None:
        try:
            await coro
        except Exception as exc:  # noqa: BLE001 - one crew failing must not stop the simulation
            say("simulator", f"a crew task failed: {type(exc).__name__}: {exc}", "yel")

    def spawn(self, coro) -> None:
        t = asyncio.create_task(self.guarded(coro))
        self.tasks.add(t)
        t.add_done_callback(self.tasks.discard)

    async def loop(self, stop_when_idle: bool = False) -> None:
        await self.open()
        say("simulator", "city is awake. Waiting for a distress call (Ctrl+C to stop)", "dim")
        quiet_since = None
        while True:
            try:
                await self.watch_incidents()
                await self.watch_dispatches()
                await self.watch_unmanned()
            except httpx.HTTPError as exc:
                say("simulator", f"server not reachable ({type(exc).__name__}), retrying", "yel")
            if stop_when_idle and self.seen_incidents:
                busy = bool(self.tasks) or any(d not in self.rerouted for d in self.unmanned)
                if not busy:
                    quiet_since = quiet_since or time.monotonic()
                    if time.monotonic() - quiet_since > 6:
                        say("simulator", "all crews are back in service. Scenario finished.", "grn")
                        return
                else:
                    quiet_since = None
            await asyncio.sleep(1.5)


# ---------------------------------------------------------------------------------------------------------------
def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    ap = argparse.ArgumentParser(description="Sahay demo simulator (fake dispatch city, API client only)")
    ap.add_argument("command", choices=["list", "inject", "respond", "scenario"])
    ap.add_argument("name", nargs="?", help="scenario: " + ", ".join(SCENARIOS))
    ap.add_argument("--api", default="http://localhost:8080/api/v1")
    ap.add_argument("--env-file", default=str(ROOT / "deploy" / ".env.demo"), help="read the seeded staff passwords from here")
    ap.add_argument("--admin-password", default=os.environ.get("SAHAY_ADMIN_PASSWORD", ""))
    ap.add_argument("--service-password", default=os.environ.get("SAHAY_SERVICE_PASSWORD", ""))
    ap.add_argument("--lang", choices=["en", "ml"], default="en", help="language the caller speaks")
    ap.add_argument("--no-approve", action="store_true", help="leave approval of high-severity incidents to a human")
    ap.add_argument("--travel-seconds", type=float, default=30.0, help="how long a unit takes to drive to the scene")
    ap.add_argument("--work-seconds", type=float, default=20.0, help="how long the crew works the scene")
    ap.add_argument("--decline-chance", type=float, default=0.0, help="0..1, chance a crew is busy and passes the call on")
    args = ap.parse_args()

    if args.command == "list":
        for s in SCENARIOS.values():
            print(f"{s.key:<14} {s.title}")
        return
    scenario = SCENARIOS.get(args.name or "")
    if args.command in ("inject", "scenario") and scenario is None:
        raise SystemExit("name a scenario: " + ", ".join(SCENARIOS))
    env = read_env_file(Path(args.env_file))
    admin_pw = args.admin_password or env.get("SAHAY_SEED_ADMIN_PASSWORD", "") or "admin123"
    service_pw = args.service_password or env.get("SAHAY_SEED_SERVICE_PASSWORD", "") or "demo123"
    api = args.api.rstrip("/")

    if args.command in ("inject", "scenario"):
        say("citizen", f"{scenario.title}: \"{scenario.text[args.lang][:100]}...\"", "red")
        rid = inject(api, "", scenario.text[args.lang], scenario.category, scenario.near, args.lang)
        say("citizen", f"report sent, id {rid[:8]}", "dim")
        if args.command == "inject":
            return
    opt = Options(api, admin_pw, service_pw, not args.no_approve, (4.0, 7.0), (3.0, 7.0), args.travel_seconds,
                  args.work_seconds, args.decline_chance, scenario)
    try:
        asyncio.run(City(opt).loop(stop_when_idle=args.command == "scenario"))
    except KeyboardInterrupt:
        say("simulator", "stopped", "dim")


if __name__ == "__main__":
    main()
