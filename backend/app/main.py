import asyncio
import hashlib
import math
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, status, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.responses import JSONResponse
from jose import JWTError, jwt
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.database import Base, engine, get_db
from app.device_auth import ChallengeError, DeviceChallenges
from app.dispatch.routes import install as install_dispatch
from app.events import manager, websocket_loop
from app.agents.store import store_pii
from app.audit_chain import append_audit_entry, initialize_audit_chain
from app.audit_routes import install as install_audit_routes
from app.incident_routes import install as install_incident_routes
from app.ingest.routes import install as install_ingest
from app.keyring import server_public_key_response
from app.live import install as install_live
from app.public_routes import install as install_public_routes, public_incident
from app.models import AgentTrace, AuditChainHead, AuditEntry, DemoUser, Device, Dispatch, Incident, IncidentPII, Report, Unit
from app.pii_crypto import ensure_pii_encryption_key
from app.rate_limit import rate_limiter
from app.schemas import DeviceChallengeRequest, DeviceRegistrationRequest, LoginRequest, MockReportRequest
from app.deploy import install as install_deploy
from app.seed import seed_demo
from app.security import verify_password
from app.settings import settings

if not settings.sahay_dev and not settings.sahay_jwt_secret:
    raise RuntimeError("SAHAY_JWT_SECRET must be configured when SAHAY_DEV is disabled")
if not settings.sahay_dev:
    ensure_pii_encryption_key()

JWT_SECRET = settings.sahay_jwt_secret or "sahay-insecure-local-dev-only"
JWT_ISSUER = "sahay"
Base.metadata.create_all(bind=engine)
initialize_audit_chain(engine)
app = FastAPI(title="Sahay API", version="1.0.0", description="Civic incident reporting and dispatch API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def http_error_handler(_: Request, exc: HTTPException):
    codes = {400: "bad_request", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "too_large", 422: "invalid_request", 429: "rate_limited"}
    message = exc.detail if isinstance(exc.detail, str) else "Request failed"
    return JSONResponse(status_code=exc.status_code, headers=exc.headers, content={"error": {"code": codes.get(exc.status_code, "request_failed"), "message": message}})


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError):
    errors = exc.errors()
    message = errors[0].get("msg", "Request validation failed") if errors else "Request validation failed"
    return JSONResponse(status_code=422, content={"error": {"code": "bad_request", "message": message}})

bearer = HTTPBearer(auto_error=False)
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_MINUTES = 12 * 60
EARTH_RADIUS_KM = 6371.0088


def utc_iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def require_dev() -> None:
    if not settings.sahay_dev:
        raise HTTPException(status_code=404, detail="Not found")


def request_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> dict:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Unauthenticated")
    claims = decode_access_token(credentials.credentials)
    role = claims.get("role")
    subject = claims.get("sub")
    rate_key = f"device:{claims.get('device_id')}" if role == "civilian" else f"user:{subject}"
    rate_limiter.check(rate_key, settings.sahay_rate_limit_per_minute)
    return claims


def decode_access_token(token: str) -> dict:
    try:
        claims = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM], issuer=JWT_ISSUER)
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="Unauthenticated") from exc
    role = claims.get("role")
    subject = claims.get("sub")
    if role not in {"civilian", "service", "admin"} or not subject:
        raise HTTPException(status_code=401, detail="Unauthenticated")
    if role == "civilian" and claims.get("device_id") != subject:
        raise HTTPException(status_code=401, detail="Unauthenticated")
    if role == "service" and not claims.get("unit_id"):
        raise HTTPException(status_code=401, detail="Unauthenticated")
    return claims


install_ingest(app, current_user)


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Forbidden")
    return user


def unit_json(unit: Unit) -> dict:
    return {
        "unit_id": unit.unit_id,
        "service_type": unit.service_type,
        "name": unit.name,
        "status": unit.status,
        "location": {"lat": unit.lat, "lng": unit.lng},
        "updated_at": utc_iso(unit.updated_at),
    }


def incident_json(incident: Incident) -> dict:
    return {
        "incident_id": incident.incident_id,
        "status": incident.status,
        "incident_type": incident.incident_type,
        "severity": incident.severity,
        "urgency_score": incident.urgency_score,
        "location": {"lat": incident.lat, "lng": incident.lng},
        "summary_redacted": incident.summary_redacted,
        "people_count": incident.people_count,
        "hazards": incident.hazards,
        "needed_services": incident.needed_services,
        "report_count": incident.report_count,
        "report_ids": incident.report_ids,
        "reason": incident.reason,
        "created_at": utc_iso(incident.created_at),
        "updated_at": utc_iso(incident.updated_at),
    }


install_dispatch(app, current_user, require_admin, incident_json)
install_live(app, current_user, incident_json)


def trace_json(trace: AgentTrace) -> dict:
    return {
        "incident_id": trace.incident_id,
        "step": trace.step,
        "agent": trace.agent,
        "status": trace.status,
        "started_at": utc_iso(trace.started_at),
        "finished_at": utc_iso(trace.finished_at),
        "summary": trace.summary,
        "output": trace.output,
    }


install_incident_routes(app, current_user, require_admin, incident_json, trace_json, utc_iso)
install_audit_routes(app, require_admin, utc_iso)
install_public_routes(app, JWT_SECRET, request_ip)


def distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    to_rad = math.radians
    dlat = to_rad(lat2 - lat1)
    dlng = to_rad(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


@app.get("/health")
def health():
    return {"status": "ok", "dev_mode": settings.sahay_dev}


@app.websocket("/ws/v1")
async def websocket_endpoint(websocket: WebSocket):
    """The JWT is NOT accepted in the URL (URLs end up in access logs). The client connects, then sends
    {"type":"auth","token":"<jwt>"} as its first message within SAHAY_WS_AUTH_TIMEOUT_S; the server answers
    {"type":"auth.ok"} and only then starts delivering events."""
    await websocket.accept()
    try:
        rate_limiter.check(f"ws-connect:{websocket.client.host if websocket.client else 'unknown'}",
                           settings.sahay_rate_limit_per_minute)
        first = await asyncio.wait_for(websocket.receive_json(), timeout=settings.sahay_ws_auth_timeout_s)
        token = first.get("token") if isinstance(first, dict) and first.get("type") == "auth" else None
        if not isinstance(token, str) or not token:
            raise HTTPException(status_code=401, detail="Unauthenticated")
        claims = decode_access_token(token)
        rate_subject = claims.get("device_id") or claims["sub"]
        rate_limiter.check(f"ws:{rate_subject}", settings.sahay_rate_limit_per_minute)
    except (HTTPException, asyncio.TimeoutError, ValueError, WebSocketDisconnect, RuntimeError):
        try:
            await websocket.close(code=1008, reason="Unauthenticated or rate limited")
        except RuntimeError:
            pass
        return
    await websocket.send_json({"type": "auth.ok"})
    await websocket_loop(websocket, claims)


@app.get("/api/v1/config/server-key")
def get_server_key():
    try:
        return server_public_key_response()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="Server encryption key is not configured") from exc


device_challenges = DeviceChallenges(JWT_SECRET)


@app.post("/api/v1/auth/device-challenge")
def device_challenge(body: DeviceChallengeRequest, request: Request):
    """Step 1 of registration / token refresh: a short-lived challenge the device must sign."""
    device_id = str(body.device_id)
    rate_limiter.check(f"register-ip:{request_ip(request)}", settings.sahay_register_rate_limit_per_minute)
    rate_limiter.check(f"register-device:{device_id}", settings.sahay_register_rate_limit_per_minute)
    return device_challenges.issue(device_id)


@app.post("/api/v1/auth/register-device", status_code=status.HTTP_201_CREATED)
def register_device(body: DeviceRegistrationRequest, request: Request, db: Session = Depends(get_db)):
    ip = request_ip(request)
    device_id = str(body.device_id)
    rate_limiter.check(f"register-ip:{ip}", settings.sahay_register_rate_limit_per_minute)
    rate_limiter.check(f"register-device:{device_id}", settings.sahay_register_rate_limit_per_minute)
    try:  # proof of possession: only the holder of the private key gets a token for this device
        device_challenges.verify(device_id, body.ed25519_public_key, body.challenge, body.challenge_signature)
    except ChallengeError as exc:
        raise HTTPException(status_code=401, detail=exc.message) from None
    device = db.get(Device, device_id)
    if device is not None:
        if device.disabled or device.ed25519_public_key != body.ed25519_public_key:
            raise HTTPException(status_code=409, detail="Device ID is already registered")
        device.last_seen_at = datetime.now(timezone.utc)
        device.language = body.language
    else:
        device = Device(
            device_id=device_id,
            ed25519_public_key=body.ed25519_public_key,
            language=body.language,
        )
        db.add(device)
    db.commit()
    now = datetime.now(timezone.utc)
    claims = {
        "sub": device_id,
        "role": "civilian",
        "device_id": device_id,
        "iat": int(now.timestamp()),
        "exp": int(now.timestamp()) + JWT_EXPIRY_MINUTES * 60,
        "iss": JWT_ISSUER,
    }
    return {"token": jwt.encode(claims, JWT_SECRET, algorithm=JWT_ALGORITHM), "role": "civilian", "device_id": device_id}


@app.post("/api/v1/auth/login")
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    rate_limiter.check(f"login-ip:{request_ip(request)}", settings.sahay_login_rate_limit_per_minute)
    rate_limiter.check(f"login-user:{body.username.lower()}", settings.sahay_login_rate_limit_per_minute)
    demo_user = db.get(DemoUser, body.username)
    if demo_user is None or not verify_password(body.password, demo_user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    append_audit_entry(
        db,
        {"type": demo_user.role, "id": demo_user.username},
        "auth.login",
        {"type": "user", "id": demo_user.username},
    )
    db.commit()
    now = datetime.now(timezone.utc)
    claims = {
        "sub": demo_user.username,
        "role": demo_user.role,
        "unit_id": demo_user.unit_id,
        "display_name": demo_user.display_name,
        "iat": int(now.timestamp()),
        "exp": int(now.timestamp()) + JWT_EXPIRY_MINUTES * 60,
        "iss": JWT_ISSUER,
    }
    return {
        "token": jwt.encode(claims, JWT_SECRET, algorithm=JWT_ALGORITHM),
        "role": demo_user.role,
        "unit_id": demo_user.unit_id,
        "display_name": demo_user.display_name,
    }


@app.get("/api/v1/units")
def list_units(_: dict = Depends(require_admin), db: Session = Depends(get_db)):
    return {"units": [unit_json(unit) for unit in db.scalars(select(Unit).order_by(Unit.service_type, Unit.name)).all()]}


def fuzz_coordinate(coord: float) -> float:
    return round(coord + ((hash(str(coord)) % 2000 - 1000) / 100000.0), 5)


@app.get("/api/v1/public/units")
def list_public_units(db: Session = Depends(get_db)):
    # Per §9.4: units that are accepted, en route or on scene for a confirmed incident
    # Dispatch statuses: accepted, en_route, on_scene (excludes approved, completed)
    dispatch_statuses = ("accepted", "en_route", "on_scene")
    # Incident statuses considered confirmed
    confirmed_incident_statuses = ("dispatched", "en_route", "on_scene", "resolved")

    # Subquery: for each unit, pick the earliest qualifying dispatch
    subq = (
        select(
            Dispatch.unit_id,
            Dispatch.dispatch_id,
            Dispatch.incident_id,
            Dispatch.eta_minutes,
            Dispatch.status.label("dispatch_status"),
            Incident.status.label("incident_status"),
            Incident.incident_id,
        )
        .join(Incident, Dispatch.incident_id == Incident.incident_id)
        .where(Dispatch.status.in_(dispatch_statuses))
        .where(Incident.status.in_(confirmed_incident_statuses))
        .order_by(Dispatch.unit_id, Dispatch.created_at)
    ).subquery()

    # Distinct on unit_id (first row per unit due to ordering)
    from sqlalchemy import distinct
    chosen = (
        db.query(subq.c.unit_id, subq.c.dispatch_id, subq.c.incident_id, subq.c.eta_minutes, subq.c.dispatch_status, subq.c.incident_status)
        .distinct(subq.c.unit_id)
        .all()
    )

    # Map unit_id -> dispatch info
    dispatch_by_unit = {row.unit_id: row for row in chosen}

    units = db.scalars(select(Unit).where(Unit.unit_id.in_(dispatch_by_unit.keys()))).all()

    result_units = []
    for unit in units:
        d = dispatch_by_unit[unit.unit_id]
        # Opaque id: hash of unit_id + incident_id (same pattern as incidents)
        opaque = hashlib.sha256(f"{unit.unit_id}|{d.incident_id}".encode()).hexdigest()[:12]
        # Map dispatch status to public wording (per §9.4 contract)
        status_map = {
            "accepted": "help assigned",
            "en_route": "help on the way",
            "on_scene": "help on scene",
        }
        public_status = status_map.get(d.dispatch_status, d.dispatch_status)
        # Per §9.4: coordinates rounded to 3 decimals (~100 m), not fuzzed
        result_units.append({
            "id": opaque,
            "service_type": unit.service_type,
            "status": public_status,
            "location": {"lat": round(unit.lat, 3), "lng": round(unit.lng, 3)},
            "incident": hashlib.sha256(f"{JWT_SECRET}|{d.incident_id}".encode()).hexdigest()[:12],
            "eta_minutes": d.eta_minutes,
        })

    return {
        "units": result_units,
        "generated_at": utc_iso(datetime.now(timezone.utc)),
    }


@app.post("/api/v1/dev/seed", status_code=status.HTTP_200_OK)
def dev_seed(db: Session = Depends(get_db)):
    require_dev()
    for model in (AgentTrace, IncidentPII, AuditEntry, Dispatch, Incident, Report):
        db.execute(delete(model))
    chain_head = db.get(AuditChainHead, 1)
    if chain_head is not None:
        chain_head.last_seq = 0
        chain_head.last_hash = "0" * 64
    seed_demo(db)
    return {"status": "seeded", "units": db.query(Unit).count()}


@app.post("/api/v1/dev/reset")
def dev_reset(db: Session = Depends(get_db)):
    require_dev()
    for model in (AgentTrace, IncidentPII, AuditEntry, Dispatch, Incident, Report):
        db.execute(delete(model))
    chain_head = db.get(AuditChainHead, 1)
    if chain_head is not None:
        chain_head.last_seq = 0
        chain_head.last_hash = "0" * 64
    db.commit()
    return {"status": "reset"}


@app.post("/api/v1/dev/mock-report", status_code=status.HTTP_201_CREATED)
async def mock_report(body: MockReportRequest, db: Session = Depends(get_db)):
    require_dev()
    report_id = body.report_id or str(uuid4())
    category_map = {"medical": ["ambulance"], "accident": ["ambulance", "police"], "fire": ["fire", "ambulance"], "crime": ["police"], "flood": ["municipal", "ambulance"], "other": ["municipal"]}
    needed = body.needed_services or category_map[body.category]
    summary = body.summary_redacted or f"{body.category.title()} report received; mock triage pending."
    summary = summary[:500]
    incident = Incident(
        status="pending_approval" if body.severity >= 4 else "triaged",
        incident_type=body.category,
        severity=body.severity,
        urgency_score=round(body.severity / 5, 2),
        lat=body.location.lat,
        lng=body.location.lng,
        summary_redacted=summary,
        people_count=body.people_count,
        hazards=[],
        needed_services=needed,
        report_count=1,
        report_ids=[report_id],
        reason="Development mock triage; dispatch assignments are illustrative.",
    )
    db.add(incident)
    db.flush()
    reporter = body.reporter or {}
    emergency_contact = body.emergency_contact or {}

    def pii_text(values: dict, field: str) -> str | None:
        value = values.get(field)
        if value is not None and not isinstance(value, str):
            raise HTTPException(status_code=422, detail=f"{field} must be a string")
        return value

    store_pii(db, incident.incident_id, {
        "transcript": body.text,
        "language": body.language,
        "reporters": [{
            "report_id": report_id,
            "name": pii_text(reporter, "name"),
            "phone": pii_text(reporter, "phone"),
            "language": body.language,
        }],
        "emergency_contact": {
            "name": pii_text(emergency_contact, "name"),
            "phone": pii_text(emergency_contact, "phone"),
        },
        "pii_spans": [],
    })
    traces = [
        ("transcribe", "mock_stt", "Audio transcription skipped" if body.text else "Audio accepted; mock transcription used"),
        ("intake", "mock_intake", "Structured incident created"),
        ("pii", "mock_pii", "Service summary prepared"),
        ("triage", "mock_triage", "Service types and urgency selected"),
        ("dispatch", "mock_dispatch", "Nearest seeded units proposed"),
    ]
    for step, agent, note in traces:
        db.add(AgentTrace(incident_id=incident.incident_id, step=step, agent=agent, status="done", summary=note, output={"mock": True}))
    dispatches = []
    for service_type in needed:
        unit = db.scalars(
            select(Unit).where(Unit.service_type == service_type, Unit.status == "available")
        ).all()
        if not unit:
            continue
        nearest = min(unit, key=lambda candidate: distance_km(body.location.lat, body.location.lng, candidate.lat, candidate.lng))
        distance = distance_km(body.location.lat, body.location.lng, nearest.lat, nearest.lng)
        dispatch = Dispatch(
            incident_id=incident.incident_id,
            unit_id=nearest.unit_id,
            service_type=service_type,
            status="proposed",
            distance_km=round(distance, 2),
            eta_minutes=max(1, math.ceil(distance / 30 * 60)),
            proposed_by="dev_mock",
        )
        db.add(dispatch)
        db.flush()
        dispatches.append({
            "dispatch_id": dispatch.dispatch_id,
            "incident_id": dispatch.incident_id,
            "unit_id": dispatch.unit_id,
            "service_type": dispatch.service_type,
            "status": dispatch.status,
            "distance_km": dispatch.distance_km,
            "eta_minutes": dispatch.eta_minutes,
            "proposed_by": dispatch.proposed_by,
            "created_at": utc_iso(dispatch.created_at),
            "updated_at": utc_iso(dispatch.updated_at),
        })
    append_audit_entry(
        db,
        {"type": "system", "id": "dev_mock"},
        "report.received",
        {"type": "incident", "id": incident.incident_id},
        {"report_id": report_id, "mock": True},
    )
    db.commit()
    db.refresh(incident)
    await manager.publish("incident.created", incident_json(incident))
    for dispatch_data in dispatches:
        await manager.publish("dispatch.proposed", dispatch_data)
    for trace in db.scalars(select(AgentTrace).where(AgentTrace.incident_id == incident.incident_id)).all():
        await manager.publish("agent.trace", trace_json(trace))
    return {"incident": incident_json(incident), "dispatches": dispatches, "mock": True}


@app.post("/api/v1/dev/tick")
async def dev_tick(db: Session = Depends(get_db)):
    require_dev()
    moved = []
    dispatches = db.scalars(select(Dispatch).where(Dispatch.status.in_(["approved", "accepted", "en_route"]))).all()
    for dispatch in dispatches:
        unit = db.get(Unit, dispatch.unit_id)
        incident = db.get(Incident, dispatch.incident_id)
        if unit is None or incident is None:
            continue
        d = distance_km(unit.lat, unit.lng, incident.lat, incident.lng)
        step = min(1.0, 1.0 / max(d, 1.0))
        unit.lat += (incident.lat - unit.lat) * step
        unit.lng += (incident.lng - unit.lng) * step
        unit.updated_at = datetime.now(timezone.utc)
        moved.append({"unit_id": unit.unit_id, "location": {"lat": unit.lat, "lng": unit.lng}, "status": unit.status})
    db.commit()
    for unit_data in moved:
        await manager.publish("unit.moved", unit_data)
    return {"moved": moved}


@app.get("/api/v1/dev/status")
def dev_status(db: Session = Depends(get_db)):
    require_dev()
    return {"units": db.query(Unit).count(), "incidents": db.query(Incident).count(), "dispatches": db.query(Dispatch).count()}


install_deploy(app)  # keep last: its SPA catch-all must not shadow any route above
