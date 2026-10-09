"""Hash-chain helpers and backward-compatible initialization for the audit log."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from sqlalchemy import inspect, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.models import AuditChainHead, AuditEntry

ZERO_HASH = "0" * 64


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def calculate_hash(
    seq: int,
    ts: datetime,
    actor: dict,
    action: str,
    target: dict,
    details: dict,
    prev_hash: str,
) -> str:
    """Calculate the contract hash over stable, canonical representations of an entry."""
    material = "|".join(
        (
            str(seq),
            _timestamp(ts),
            _canonical(actor),
            action,
            _canonical(target),
            _canonical(details or {}),
            prev_hash,
        )
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def initialize_audit_chain(engine: Engine) -> None:
    """Add chain columns to legacy databases and backfill history exactly once."""
    inspector = inspect(engine)
    if "audit_entries" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("audit_entries")}
    with engine.begin() as connection:
        if "prev_hash" not in columns:
            connection.exec_driver_sql("ALTER TABLE audit_entries ADD COLUMN prev_hash VARCHAR(64)")
        if "hash" not in columns:
            connection.exec_driver_sql("ALTER TABLE audit_entries ADD COLUMN hash VARCHAR(64)")

        dialect = connection.dialect.name
        values = {"id": 1, "last_seq": 0, "last_hash": ZERO_HASH}
        if dialect == "sqlite":
            from sqlalchemy.dialects.sqlite import insert

            statement = insert(AuditChainHead).values(**values).on_conflict_do_nothing(index_elements=["id"])
        elif dialect == "postgresql":
            from sqlalchemy.dialects.postgresql import insert

            statement = insert(AuditChainHead).values(**values).on_conflict_do_nothing(index_elements=["id"])
        else:
            statement = None
        if statement is not None:
            connection.execute(statement)
        elif connection.execute(select(AuditChainHead.id).where(AuditChainHead.id == 1)).first() is None:
            connection.execute(AuditChainHead.__table__.insert().values(**values))

        head = connection.execute(
            select(AuditChainHead.__table__).where(AuditChainHead.id == 1).with_for_update()
        ).mappings().one()
        if head["last_seq"] != 0:
            return

        table = AuditEntry.__table__
        rows = connection.execute(select(table).order_by(table.c.seq)).mappings().all()
        previous_hash = ZERO_HASH
        last_seq = 0
        for row in rows:
            timestamp = row["ts"] or datetime.now(timezone.utc)
            actor = row["actor"] or {}
            target = row["target"] or {}
            details = row["details"] or {}
            entry_hash = calculate_hash(
                row["seq"], timestamp, actor, row["action"], target, details, previous_hash
            )
            connection.execute(
                update(table)
                .where(table.c.seq == row["seq"])
                .values(prev_hash=previous_hash, hash=entry_hash)
            )
            previous_hash = entry_hash
            last_seq = row["seq"]
        connection.execute(
            update(AuditChainHead.__table__)
            .where(AuditChainHead.id == 1)
            .values(last_seq=last_seq, last_hash=previous_hash)
        )


def append_audit_entry(
    db: Session,
    actor: dict,
    action: str,
    target: dict,
    details: dict | None = None,
) -> AuditEntry:
    """Append one entry while holding the database's chain-head row lock."""
    db.flush()
    # This no-op UPDATE obtains a write/row lock in both SQLite and PostgreSQL. It is held
    # until the caller commits or rolls back, so concurrent transactions cannot fork the chain.
    db.execute(
        update(AuditChainHead)
        .where(AuditChainHead.id == 1)
        .values(last_seq=AuditChainHead.last_seq)
    )
    head = db.scalar(
        select(AuditChainHead)
        .where(AuditChainHead.id == 1)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if head is None:
        # Isolated database sessions (for example, unit-test databases) may not run the
        # application startup initializer. Production startup inserts this row up front.
        head = AuditChainHead(id=1, last_seq=0, last_hash=ZERO_HASH)
        db.add(head)
        db.flush()

    entry = AuditEntry(
        ts=datetime.now(timezone.utc),
        actor=actor,
        action=action,
        target=target,
        details=details or {},
        prev_hash=head.last_hash,
        hash=ZERO_HASH,
    )
    db.add(entry)
    db.flush()
    entry.hash = calculate_hash(entry.seq, entry.ts, entry.actor, entry.action, entry.target, entry.details, entry.prev_hash)
    head.last_seq = entry.seq
    head.last_hash = entry.hash
    db.flush()
    return entry


def verify_audit_chain(db: Session) -> dict:
    """Verify every row and compare the stored tip to detect deletion of the tail."""
    rows = db.scalars(select(AuditEntry).order_by(AuditEntry.seq)).all()
    head = db.get(AuditChainHead, 1)
    previous_hash = ZERO_HASH
    checked = 0
    for row in rows:
        expected = calculate_hash(row.seq, row.ts, row.actor, row.action, row.target, row.details, previous_hash)
        checked += 1
        if row.prev_hash != previous_hash or row.hash != expected:
            return {"valid": False, "checked": checked, "first_bad_seq": row.seq}
        previous_hash = row.hash

    if head is None:
        return {"valid": False, "checked": checked, "first_bad_seq": rows[0].seq if rows else 1}
    if head.last_seq != (rows[-1].seq if rows else 0) or head.last_hash != previous_hash:
        return {"valid": False, "checked": checked, "first_bad_seq": head.last_seq or 1}
    return {"valid": True, "checked": checked, "first_bad_seq": None}
