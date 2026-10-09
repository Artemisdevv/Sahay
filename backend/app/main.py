import math
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.responses import JSONResponse
from jose import JWTError, jwt
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.database import Base, engine, get_db
from app.keyring import server_public_key_response
from app.models import AgentTrace, AuditEntry, DemoUser, Device, Dispatch, Incident, Unit
from app.rate_limit import rate_limiter
from app.schemas import DeviceRegistrationRequest, LoginRequest, MockReportRequest
from app.seed import seed_demo
from app.security import verify_password
from app.settings import settings

if not settings.sahay_dev and not settings.sahay_jwt_secret:
    raise RuntimeError("SAHAY_JWT_SECRET must be configured when SAHAY_DEV is disabled")

JWT_SECRET = settings.sahay_jwt_secret or "sahay-insecure-local-dev-only"
JWT_ISSUER = "sahay"
Base.metadata.create_all(bind=engine)
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


def distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    to_rad = math.radians
    dlat = to_rad(lat2 - lat1)
    dlng = to_rad(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


@app.get("/health")
def health():
    return {"status": "ok", "dev_mode": settings.sahay_dev}


@app.get("/api/v1/config/server-key")
def get_server_key():
    try:
        return server_public_key_response()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="Server encryption key is not configured") from exc


@app.post("/api/v1/auth/register-device", status_code=status.HTTP_201_CREATED)
def register_device(body: DeviceRegistrationRequest, request: Request, db: Session = Depends(get_db)):
    ip = request_ip(request)
    device_id = str(body.device_id)
    rate_limiter.check(f"register-ip:{ip}", settings.sahay_register_rate_limit_per_minute)
    rate_limiter.check(f"register-device:{device_id}", settings.sahay_register_rate_limit_per_minute)
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


@app.post("/api/v1/dev/seed", status_code=status.HTTP_200_OK)
def dev_seed(db: Session = Depends(get_db)):
    require_dev()
    for model in (AgentTrace, AuditEntry, Dispatch, Incident):
        db.execute(delete(model))
    seed_demo(db)
    return {"status": "seeded", "units": db.query(Unit).count()}


@app.post("/api/v1/dev/reset")
def dev_reset(db: Session = Depends(get_db)):
    require_dev()
    for model in (AgentTrace, AuditEntry, Dispatch, Incident):
        db.execute(delete(model))
    db.commit()
    return {"status": "reset"}


@app.post("/api/v1/dev/mock-report", status_code=status.HTTP_201_CREATED)
def mock_report(body: MockReportRequest, db: Session = Depends(get_db)):
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
    db.add(AuditEntry(actor={"type": "system", "id": "dev_mock"}, action="report.received", target={"type": "incident", "id": incident.incident_id}, details={"report_id": report_id, "mock": True}))
    db.commit()
    db.refresh(incident)
    return {"incident": incident_json(incident), "dispatches": dispatches, "mock": True}


@app.post("/api/v1/dev/tick")
def dev_tick(db: Session = Depends(get_db)):
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
    return {"moved": moved, "note": "WebSocket unit.moved events are added in B-07."}


@app.get("/api/v1/dev/status")
def dev_status(db: Session = Depends(get_db)):
    require_dev()
    return {"units": db.query(Unit).count(), "incidents": db.query(Incident).count(), "dispatches": db.query(Dispatch).count()}
