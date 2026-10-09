from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.models import DemoUser, Unit, now_utc
from app.security import hash_password

SEED_UNITS = [
    ("Ambulance 01", "ambulance", 9.9816, 76.2999, "amb-01"),
    ("Ambulance 02", "ambulance", 9.9158, 76.2540, None),
    ("Police 01", "police", 9.9674, 76.2822, "police-01"),
    ("Police 02", "police", 9.9312, 76.2673, None),
    ("Fire 01", "fire", 9.9591, 76.2711, "fire-01"),
    ("Fire 02", "fire", 10.0159, 76.3419, None),
]


def seed_demo(db: Session, admin_password: str = "admin123", service_password: str = "demo123") -> None:
    db.execute(delete(Unit))
    db.execute(delete(DemoUser))
    units_by_username = {}
    for name, service_type, lat, lng, username in SEED_UNITS:
        unit = Unit(name=name, service_type=service_type, lat=lat, lng=lng, status="available", updated_at=now_utc())
        db.add(unit)
        db.flush()
        if username:
            units_by_username[username] = (unit.unit_id, name)
    db.add(DemoUser(username="admin", password_hash=hash_password(admin_password), role="admin", display_name="Sahay Admin"))
    for username, (unit_id, display_name) in units_by_username.items():
        db.add(DemoUser(username=username, password_hash=hash_password(service_password), role="service", unit_id=unit_id, display_name=display_name))
    db.commit()
