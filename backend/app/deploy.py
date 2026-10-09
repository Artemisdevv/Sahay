"""Single-origin deployment helpers: serve the built SPA and seed staff accounts from secrets.

Both are opt-in through settings, so tests and the normal dev setup are unaffected.
"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.database import SessionLocal
from app.models import DemoUser
from app.seed import seed_demo
from app.settings import settings


def seed_from_env() -> bool:
    """Create the Kochi units and staff accounts once, with passwords from the environment."""
    admin, service = settings.sahay_seed_admin_password, settings.sahay_seed_service_password
    if not (admin and service):
        return False
    with SessionLocal() as db:
        if db.scalars(select(DemoUser).limit(1)).first() is not None:
            return False
        seed_demo(db, admin_password=admin, service_password=service)
    return True


def install(app: FastAPI) -> None:
    inner = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(a: FastAPI):
        seed_from_env()
        async with inner(a) as state:
            yield state

    app.router.lifespan_context = lifespan
    root = Path(settings.sahay_static_dir).resolve() if settings.sahay_static_dir else None
    if root is None or not (root / "index.html").is_file():
        return

    # Registered last, so every /api and /ws route matches first. Unknown API paths stay JSON 404s.
    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith(("api/", "ws/")):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = (root / path).resolve()
        if path and candidate.is_file() and root in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(root / "index.html")
