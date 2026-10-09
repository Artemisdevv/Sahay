from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app import deploy
from app.database import SessionLocal
from app.models import DemoUser, Unit
from app.security import verify_password
from app.seed import seed_demo


def _spa_client(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>shell</html>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("outside")
    monkeypatch.setattr(deploy.settings, "sahay_static_dir", str(dist))
    app = FastAPI()

    @app.get("/api/v1/ping")
    def ping():
        return {"ok": True}

    deploy.install(app)
    return TestClient(app)


def test_spa_served_with_fallback_and_api_untouched(tmp_path, monkeypatch):
    client = _spa_client(tmp_path, monkeypatch)
    assert client.get("/").text == "<html>shell</html>"
    assert client.get("/admin/dashboard").text == "<html>shell</html>"  # client-side route
    assert client.get("/assets/app.js").text == "console.log(1)"
    assert client.get("/api/v1/ping").json() == {"ok": True}
    assert client.get("/api/v1/nope").status_code == 404  # not the HTML shell


def test_spa_blocks_path_traversal(tmp_path, monkeypatch):
    client = _spa_client(tmp_path, monkeypatch)
    for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"):
        assert "outside" not in client.get(path).text


def test_no_static_dir_means_no_catch_all(monkeypatch):
    monkeypatch.setattr(deploy.settings, "sahay_static_dir", "")
    app = FastAPI()
    deploy.install(app)
    assert TestClient(app).get("/").status_code == 404


def test_seed_from_env_uses_given_passwords_once(monkeypatch):
    with SessionLocal() as db:
        db.execute(delete(Unit))
        db.execute(delete(DemoUser))
        db.commit()
    try:
        monkeypatch.setattr(deploy.settings, "sahay_seed_admin_password", "")
        monkeypatch.setattr(deploy.settings, "sahay_seed_service_password", "svc-pass")
        assert deploy.seed_from_env() is False  # both passwords are required

        monkeypatch.setattr(deploy.settings, "sahay_seed_admin_password", "adm-pass")
        assert deploy.seed_from_env() is True
        with SessionLocal() as db:
            admin = db.scalars(select(DemoUser).where(DemoUser.username == "admin")).one()
            service = db.scalars(select(DemoUser).where(DemoUser.username == "fire-01")).one()
            assert verify_password("adm-pass", admin.password_hash)
            assert not verify_password("admin123", admin.password_hash)
            assert verify_password("svc-pass", service.password_hash)
        assert deploy.seed_from_env() is False  # already seeded: never overwrite
    finally:
        with SessionLocal() as db:
            seed_demo(db)
