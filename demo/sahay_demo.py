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

Always-on mode for the demo: `serve` runs the city for ANY incident (phone, SMS, admin console, the `inject` command) and
hosts a big "dispatch radio" page (default port 8090) that shows the crews' chatter live on a projector. docker-compose
starts it as its own container next to the server.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import collections
import http.server
import json
import math
import os
import queue
import random
import sys
import threading
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


FEED: collections.deque = collections.deque(maxlen=300)  # lines for the live radio page
SUBSCRIBERS: list[queue.Queue] = []
FEED_LOCK = threading.Lock()


def say(who: str, text: str, colour: str = "cyn") -> None:
    t = int(time.monotonic() - T0)
    print(f"{C['dim']}T+{t // 60:02d}:{t % 60:02d}{C['off']}  {C[colour]}{who:<18}{C['off']} {text}", flush=True)
    if who == "simulator" and colour == "dim":
        return  # housekeeping stays in the terminal; the radio page shows only what a viewer cares about
    line = {"t": time.strftime("%H:%M:%S"), "who": who, "text": text, "colour": colour}
    with FEED_LOCK:
        FEED.append(line)
        for q in SUBSCRIBERS:
            q.put(line)


RADIO_PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Sahay dispatch radio (demo)</title>
<style>
:root{color-scheme:dark;--bg:#0f1512;--fg:#e8efe9;--dim:#7f8c83}
body{margin:0;background:var(--bg);color:var(--fg);font:22px/1.45 ui-monospace,Consolas,monospace}
header{padding:18px 28px;border-bottom:1px solid #26332b;display:flex;gap:16px;align-items:baseline}
h1{margin:0;font-size:28px;font-family:system-ui,sans-serif}h1 b{color:#34c77b}
small{color:var(--dim);font-family:system-ui,sans-serif}
#feed{padding:18px 28px 80px}
.l{display:flex;gap:18px;padding:5px 0;border-bottom:1px solid #1a241e;animation:in .35s ease}
.t{color:var(--dim);min-width:92px}.w{min-width:200px;font-weight:700}
.red{color:#ff6b6b}.grn{color:#5fe0a0}.yel{color:#ffd166}.blu{color:#7cb7ff}.mag{color:#d9a0ff}.cyn{color:#6fe0e0}.dim{color:var(--dim)}
#idle{color:var(--dim);padding:40px 28px}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1}}
</style>
<header><h1>sahay<b>.</b> dispatch radio</h1><small>demo: simulated crews, nobody real is called</small></header>
<div id=idle>Waiting for a distress call...</div><div id=feed></div>
<script>
const feed=document.getElementById('feed'),idle=document.getElementById('idle');
function add(m){idle.style.display='none';const d=document.createElement('div');d.className='l';
d.innerHTML='<span class=t></span><span class="w '+m.colour+'"></span><span class=x></span>';
d.children[0].textContent=m.t;d.children[1].textContent=m.who;d.children[2].textContent=m.text;
feed.appendChild(d);window.scrollTo(0,document.body.scrollHeight)}
const es=new EventSource('/events');es.onmessage=e=>add(JSON.parse(e.data));
</script>"""


class RadioHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:  # keep the terminal for the radio itself
        pass

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            q: queue.Queue = queue.Queue()
            with FEED_LOCK:
                backlog = list(FEED)
                SUBSCRIBERS.append(q)
            try:
                for line in backlog:
                    self.wfile.write(f"data: {json.dumps(line)}\n\n".encode())
                self.wfile.flush()
                while True:
                    try:
                        line = q.get(timeout=15)
                        self.wfile.write(f"data: {json.dumps(line)}\n\n".encode())
                    except queue.Empty:
                        self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                with FEED_LOCK:
                    if q in SUBSCRIBERS:
                        SUBSCRIBERS.remove(q)
            return
        body = RADIO_PAGE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve_radio(port: int) -> None:
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), RadioHandler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    say("simulator", f"dispatch radio page on http://localhost:{port}/", "dim")


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
# Where each crew starts the day (api-contract.md section 7 seed units). They drive back here after every job.
HOME = {"amb-01": (9.9816, 76.2999), "police-01": (9.9674, 76.2822), "fire-01": (9.9591, 76.2711)}
# Any real incident (phone, SMS, admin) gets the matching story, whichever way it arrived.
SCENARIO_FOR_TYPE = {"medical": "heart-attack", "fire": "house-fire", "accident": "road-accident",
                     "flood": "flood", "crime": "burglary"}
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
        self.history: set[str] = set()  # incidents that existed before this service started: never touched
        self.on_job: set[str] = set()  # usernames of crews currently working a dispatch

    async def call(self, method: str, path: str, token: str, **kw):
        """One API call. A 429 (the server rate-limits per IP) is waited out once instead of being treated as an answer."""
        for attempt in (1, 2):
            r = await self.http.request(method, path, headers={"Authorization": f"Bearer {token}"}, **kw)
            if r.status_code != 429 or attempt == 2:
                return r
            await asyncio.sleep(4)
        return r

    async def get_units(self) -> list[dict]:
        r = await self.call("GET", "/units", self.admin)
        if r.status_code != 200:
            return []
        body = r.json()
        return body.get("units", []) if isinstance(body, dict) else body

    async def login(self, username: str, password: str) -> dict:
        r = await self.http.post("/auth/login", json={"username": username, "password": password})
        r.raise_for_status()
        return r.json()

    async def open(self) -> None:
        self.admin = (await self.login("admin", self.o.admin_password))["token"]
        by_id = {u["unit_id"]: u for u in await self.get_units()}
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
        for iid in list(self.seen_incidents - self.done_incidents - self.history):
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
                crew = next((u for n, u in self.units.items()
                             if u["type"] == d["service_type"] and n not in self.on_job), None)
                if crew is None:
                    continue  # our crew of that type is busy: try again on a later round
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
        self.on_job.add(username)
        try:
            await self.work_dispatch(username, d)
        finally:
            self.on_job.discard(username)

    async def work_dispatch(self, username: str, d: dict) -> None:
        u = self.units[username]
        name, stype = u["name"], u["type"]
        inc = (await self.call("GET", f"/incidents/{d['incident_id']}", self.admin)).json()
        inc = inc.get("incident", inc)
        where = (inc["location"]["lat"], inc["location"]["lng"])
        story = self.o.scenario or SCENARIOS.get(SCENARIO_FOR_TYPE.get(inc["incident_type"], ""))
        chat = story.chatter.get(stype, {}) if story else {}
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

        me = next((x for x in await self.get_units() if x["unit_id"] == u["unit_id"]), None)
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
        if stype == "ambulance" and story and story.hospital:
            say("hospital", story.hospital[0], "mag")
        await asyncio.sleep(self.o.work_seconds / (len(lines) + 1))
        done_lines = chat.get("done", [GENERIC["done"]])
        for line in done_lines[:-1]:
            say(name, line, "grn")
            await asyncio.sleep(2)
        if stype == "ambulance" and story and len(story.hospital) > 1:
            say("hospital", story.hospital[1], "mag")
        await self.status(u, d, "completed")
        say(name, done_lines[-1], "grn")
        self.done_incidents.add(d["incident_id"])
        home = HOME.get(username)
        if home:  # drive back to the station so the next call starts from a believable place
            for i in range(1, 6):
                pos = lerp(where, home, i / 5)
                await self.call("PATCH", f"/units/{u['unit_id']}/location", u["token"], json={"lat": pos[0], "lng": pos[1]})
                await asyncio.sleep(max(1.0, self.o.travel_seconds / 12))

    async def guarded(self, coro) -> None:
        try:
            await coro
        except Exception as exc:  # noqa: BLE001 - one crew failing must not stop the simulation
            say("simulator", f"a crew task failed: {type(exc).__name__}: {exc}", "yel")

    def spawn(self, coro) -> None:
        t = asyncio.create_task(self.guarded(coro))
        self.tasks.add(t)
        t.add_done_callback(self.tasks.discard)

    async def open_with_retry(self) -> None:
        """On a fresh server the staff accounts do not exist yet (seeding happens at startup): keep trying."""
        while True:
            try:
                await self.open()
                if self.units:
                    return
                say("simulator", "no crew logins yet, retrying", "dim")
            except (httpx.HTTPError, KeyError, ValueError) as exc:
                say("simulator", f"server not ready ({type(exc).__name__}), retrying", "dim")
            await asyncio.sleep(5)

    async def skip_backlog(self) -> None:
        """Incidents and dispatches that already exist are history: do not replay them when the service starts."""
        r = await self.call("GET", "/incidents", self.admin)
        if r.status_code == 200:
            self.history = {i["incident_id"] for i in r.json().get("incidents", [])}
            self.seen_incidents |= self.history
        for username, u in self.units.items():
            d = await self.call("GET", "/dispatches/mine", u["token"])
            if d.status_code == 200:
                rows = d.json().get("dispatches", [])
                self.seen_dispatches |= {x["dispatch_id"] for x in rows}
                for x in rows:  # a job left half done by an earlier run would keep the unit busy forever: close it
                    if x["status"] in ("accepted", "en_route", "on_scene"):
                        for st in ("en_route", "on_scene", "completed"):
                            rr = await self.call("POST", f"/dispatches/{x['dispatch_id']}/status", u["token"], json={"status": st})
                            if st == "completed" and rr.status_code < 300:
                                break
                        say("simulator", f"{u['name']}: closed an unfinished job from earlier", "dim")
            await self.call("PATCH", f"/units/{u['unit_id']}/location", u["token"],
                            json={"lat": HOME[username][0], "lng": HOME[username][1]})  # crews start at their station

    async def loop(self, stop_when_idle: bool = False, ignore_backlog: bool = False) -> None:
        await self.open_with_retry()
        if ignore_backlog:
            await self.skip_backlog()
        say("simulator", "city is awake. Waiting for a distress call (Ctrl+C to stop)", "dim")
        quiet_since = None
        tick = 0
        opened_at = time.monotonic()
        while True:
            if time.monotonic() - opened_at > 4 * 3600:  # staff tokens last 12 h: renew well before
                await self.open_with_retry()
                opened_at = time.monotonic()
            try:
                await self.watch_incidents()
                await self.watch_dispatches()
                tick += 1
                if tick % 4 == 0:  # reassigning is not urgent: look every few rounds to stay under the server's rate limit
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
            await asyncio.sleep(2.5)


# ---------------------------------------------------------------------------------------------------------------
def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    ap = argparse.ArgumentParser(description="Sahay demo simulator (fake dispatch city, API client only)")
    env_default = lambda k, d: os.environ.get(k, d)  # noqa: E731 - the container passes its settings as env vars
    ap.add_argument("command", choices=["list", "inject", "respond", "scenario", "serve"])
    ap.add_argument("name", nargs="?", help="scenario: " + ", ".join(SCENARIOS))
    ap.add_argument("--api", default=env_default("SAHAY_DEMO_API", "http://localhost:8080/api/v1"))
    ap.add_argument("--feed-port", type=int, default=int(env_default("SAHAY_DEMO_FEED_PORT", "8090")),
                    help="serve: port of the live dispatch radio page")
    ap.add_argument("--env-file", default=str(ROOT / "deploy" / ".env.demo"), help="read the seeded staff passwords from here")
    ap.add_argument("--admin-password", default=os.environ.get("SAHAY_ADMIN_PASSWORD", ""))
    ap.add_argument("--service-password", default=os.environ.get("SAHAY_SERVICE_PASSWORD", ""))
    ap.add_argument("--lang", choices=["en", "ml"], default="en", help="language the caller speaks")
    ap.add_argument("--no-approve", action="store_true", default=env_default("SAHAY_DEMO_APPROVE", "1") == "0",
                    help="leave approval of high-severity incidents to a human")
    ap.add_argument("--travel-seconds", type=float, default=float(env_default("SAHAY_DEMO_TRAVEL_SECONDS", "30")),
                    help="how long a unit takes to drive to the scene")
    ap.add_argument("--work-seconds", type=float, default=float(env_default("SAHAY_DEMO_WORK_SECONDS", "20")),
                    help="how long the crew works the scene")
    ap.add_argument("--decline-chance", type=float, default=float(env_default("SAHAY_DEMO_DECLINE_CHANCE", "0")),
                    help="0..1, chance a crew is busy and passes the call on")
    args = ap.parse_args()

    if args.command == "list":
        for s in SCENARIOS.values():
            print(f"{s.key:<14} {s.title}")
        return
    scenario = SCENARIOS.get(args.name or "")
    if args.command in ("inject", "scenario") and scenario is None:
        raise SystemExit("name a scenario: " + ", ".join(SCENARIOS))
    env = read_env_file(Path(args.env_file))
    admin_pw = (args.admin_password or os.environ.get("SAHAY_SEED_ADMIN_PASSWORD", "")
                or env.get("SAHAY_SEED_ADMIN_PASSWORD", "") or "admin123")
    service_pw = (args.service_password or os.environ.get("SAHAY_SEED_SERVICE_PASSWORD", "")
                  or env.get("SAHAY_SEED_SERVICE_PASSWORD", "") or "demo123")
    api = args.api.rstrip("/")

    if args.command in ("inject", "scenario"):
        say("citizen", f"{scenario.title}: \"{scenario.text[args.lang][:100]}...\"", "red")
        rid = inject(api, "", scenario.text[args.lang], scenario.category, scenario.near, args.lang)
        say("citizen", f"report sent, id {rid[:8]}", "dim")
        if args.command == "inject":
            return
    opt = Options(api, admin_pw, service_pw, not args.no_approve, (4.0, 7.0), (3.0, 7.0), args.travel_seconds,
                  args.work_seconds, args.decline_chance, scenario)
    if args.command == "serve":
        serve_radio(args.feed_port)
    try:
        asyncio.run(City(opt).loop(stop_when_idle=args.command == "scenario", ignore_backlog=args.command == "serve"))
    except KeyboardInterrupt:
        say("simulator", "stopped", "dim")


if __name__ == "__main__":
    main()
