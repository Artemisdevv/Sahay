import itertools

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.dispatch import engine as e
from app.models import Dispatch, Incident, Report, Unit

CENTER = (9.9312, 76.2673)
ADMIN = {"type": "admin", "id": "admin"}
SEED = [
    ("Ambulance 01", "ambulance", 9.9816, 76.2999),
    ("Ambulance 02", "ambulance", 9.9158, 76.2540),
    ("Police 01", "police", 9.9674, 76.2822),
    ("Police 02", "police", 9.9312, 76.2673),
    ("Fire 01", "fire", 9.9591, 76.2711),
    ("Fire 02", "fire", 10.0159, 76.3419),
]


@pytest.fixture()
def db():
    eng = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with sessionmaker(bind=eng, autoflush=False, expire_on_commit=False)() as s:
        for name, st, lat, lng in SEED:
            s.add(Unit(name=name, service_type=st, lat=lat, lng=lng, status="available"))
        s.commit()
        yield s


def unit(db, name) -> Unit:
    return db.query(Unit).filter_by(name=name).one()


def incident(db, lat=CENTER[0], lng=CENTER[1], status="pending_approval", report_ids=None) -> Incident:
    inc = Incident(status=status, incident_type="accident", severity=4, urgency_score=0.8, lat=lat, lng=lng,
                   summary_redacted="x", needed_services=["ambulance"], report_ids=report_ids or [])
    db.add(inc)
    db.commit()
    return inc


def by_service(out, st):
    return [d for d in out.dispatches if d.service_type == st]


# ---- pure math ---------------------------------------------------------------

def test_haversine_zero_symmetry_and_known_degree():
    assert e.haversine_km(*CENTER, *CENTER) == 0
    a, b = (9.99, 76.30), (9.93, 76.26)
    assert e.haversine_km(*a, *b) == pytest.approx(e.haversine_km(*b, *a))
    assert e.haversine_km(0, 0, 1, 0) == pytest.approx(111.195, abs=0.05)  # 1 degree of latitude


@pytest.mark.parametrize("km,minutes", [(0, 1), (0.01, 1), (0.5, 1), (15, 30), (30, 60), (30.01, 61), (7.6, 16)])
def test_eta_is_ceil_at_30kmh_min_1(km, minutes):
    assert e.eta_minutes(km) == minutes


# ---- nearest available -------------------------------------------------------

def test_nearest_picks_closest_by_type(db):
    assert e.find_nearest_available(db, "police", *CENTER).unit.name == "Police 02"
    assert e.find_nearest_available(db, "ambulance", *CENTER).unit.name == "Ambulance 02"
    far = e.find_nearest_available(db, "fire", 10.02, 76.34)
    assert far.unit.name == "Fire 02" and far.distance_km < 1


def test_nearest_result_carries_distance_and_eta(db):
    c = e.find_nearest_available(db, "ambulance", *CENTER)
    assert c.distance_km == round(e.haversine_km(*CENTER, c.unit.lat, c.unit.lng), 2)
    assert c.eta_minutes == e.eta_minutes(c.distance_km) or c.eta_minutes == e.eta_minutes(e.haversine_km(*CENTER, c.unit.lat, c.unit.lng))


def test_nearest_skips_unavailable_and_excluded(db):
    unit(db, "Ambulance 02").status = "assigned"
    db.commit()
    assert e.find_nearest_available(db, "ambulance", *CENTER).unit.name == "Ambulance 01"
    assert e.find_nearest_available(db, "ambulance", *CENTER, {unit(db, "Ambulance 01").unit_id}) is None


def test_nearest_none_when_no_units_or_type_missing(db):
    assert e.find_nearest_available(db, "municipal", *CENTER) is None
    with pytest.raises(e.DispatchError) as err:
        e.find_nearest_available(db, "helicopter", *CENTER)
    assert err.value.status == 400


def test_tie_breaks_on_unit_id_deterministically(db):
    a = Unit(unit_id="aaa", name="T1", service_type="municipal", lat=1, lng=1, status="available")
    b = Unit(unit_id="bbb", name="T2", service_type="municipal", lat=1, lng=1, status="available")
    db.add_all([b, a])
    db.commit()
    for _ in range(10):
        assert e.find_nearest_available(db, "municipal", 1, 1).unit.unit_id == "aaa"


# ---- state machine -----------------------------------------------------------

def test_transition_table_is_closed_exhaustively(db):
    inc = incident(db)
    states = list(e.TRANSITIONS)
    for src, dst in itertools.product(states, states):
        d = Dispatch(incident_id=inc.incident_id, unit_id=unit(db, "Police 01").unit_id, service_type="police",
                     status=src, distance_km=1, eta_minutes=1)
        db.add(d)
        db.flush()
        if dst in e.TRANSITIONS[src]:
            e._set_status(db, d, dst, e.Outcome())
            assert d.status == dst
        else:
            with pytest.raises(e.DispatchError) as err:
                e._set_status(db, d, dst, e.Outcome())
            assert err.value.status == 409 and d.status == src
    db.rollback()


def test_terminal_states_have_no_exits():
    for s in ("declined", "completed", "cancelled"):
        assert e.TRANSITIONS[s] == ()


# ---- propose / approve -------------------------------------------------------

def test_propose_does_not_reserve_units(db):
    inc = incident(db)
    out = e.propose(db, inc, ["ambulance", "police"])
    assert {d.status for d in out.dispatches} == {"proposed"}
    assert unit(db, "Ambulance 02").status == "available"
    assert out.unfilled == []


def test_propose_reports_unfilled_service_and_dedupes(db):
    out = e.propose(db, incident(db), ["ambulance", "municipal", "ambulance"])
    assert len(out.dispatches) == 1 and out.unfilled == ["municipal"]


def test_approve_reserves_units_and_marks_incident_dispatched(db):
    inc = incident(db)
    e.propose(db, inc, ["ambulance", "police"])
    out = e.approve_incident(db, inc.incident_id, ADMIN)
    assert {d.status for d in out.dispatches} == {"approved"}
    assert unit(db, "Ambulance 02").status == "assigned" and unit(db, "Police 02").status == "assigned"
    assert out.incident.status == "dispatched"


def test_unit_cannot_be_committed_to_two_incidents(db):
    i1, i2 = incident(db), incident(db)
    e.propose(db, i1, ["ambulance"])
    e.propose(db, i2, ["ambulance"])  # both propose Ambulance 02
    e.approve_incident(db, i1.incident_id, ADMIN)
    out = e.approve_incident(db, i2.incident_id, ADMIN)
    chosen = by_service(out, "ambulance")
    live = [d for d in chosen if d.status == "approved"]
    assert len(live) == 1 and live[0].unit_id == unit(db, "Ambulance 01").unit_id
    assert any(d.status == "cancelled" for d in chosen)


def test_approve_with_no_replacement_reports_unfilled(db):
    i1, i2 = incident(db), incident(db)
    e.propose(db, i1, ["fire"])
    e.propose(db, i2, ["fire"])
    e.approve_incident(db, i1.incident_id, ADMIN)
    unit(db, "Fire 02").status = "offline"
    db.commit()
    out = e.approve_incident(db, i2.incident_id, ADMIN)
    assert out.unfilled == ["fire"] and "No available unit" in out.incident.reason


def test_approve_requires_proposed_and_open_incident(db):
    inc = incident(db)
    with pytest.raises(e.DispatchError) as err:
        e.approve_incident(db, inc.incident_id, ADMIN)
    assert err.value.status == 409
    with pytest.raises(e.DispatchError) as err:
        e.approve_incident(db, "nope", ADMIN)
    assert err.value.status == 404
    inc.status = "resolved"
    db.commit()
    with pytest.raises(e.DispatchError):
        e.approve_incident(db, inc.incident_id, ADMIN)


def test_auto_approve_for_low_severity(db):
    inc = incident(db)
    out = e.propose(db, inc, ["police", "municipal"], auto_approve=True)
    assert out.incident.status == "dispatched" and out.unfilled == ["municipal"]
    assert unit(db, "Police 02").status == "assigned"


# ---- reject / reassign -------------------------------------------------------

def test_reject_cancels_all_and_needs_reason(db):
    inc = incident(db)
    e.propose(db, inc, ["ambulance", "police"])
    with pytest.raises(e.DispatchError) as err:
        e.reject_incident(db, inc.incident_id, ADMIN, "  ")
    assert err.value.status == 400
    out = e.reject_incident(db, inc.incident_id, ADMIN, "duplicate hoax")
    assert out.incident.status == "rejected" and out.incident.reason == "duplicate hoax"
    assert {d.status for d in out.dispatches} == {"cancelled"}


def test_reject_releases_reserved_units(db):
    inc = incident(db)
    e.propose(db, inc, ["police"])
    e.approve_incident(db, inc.incident_id, ADMIN)
    e.reject_incident(db, inc.incident_id, ADMIN, "stand down")
    assert unit(db, "Police 02").status == "available"


def test_reassign_swaps_unit_and_frees_old(db):
    inc = incident(db)
    e.propose(db, inc, ["ambulance"])
    e.approve_incident(db, inc.incident_id, ADMIN)
    out = e.reassign(db, inc.incident_id, ADMIN, "ambulance", unit(db, "Ambulance 01").unit_id)
    assert unit(db, "Ambulance 02").status == "available" and unit(db, "Ambulance 01").status == "assigned"
    assert sorted(d.status for d in out.dispatches) == ["approved", "cancelled"]


def test_reassign_before_approval_stays_proposed(db):
    inc = incident(db)
    e.propose(db, inc, ["ambulance"])
    out = e.reassign(db, inc.incident_id, ADMIN, "ambulance", unit(db, "Ambulance 01").unit_id)
    assert unit(db, "Ambulance 01").status == "available"
    assert [d.status for d in out.dispatches if d.status != "cancelled"] == ["proposed"]


def test_reassign_validation(db):
    inc = incident(db)
    e.propose(db, inc, ["ambulance"])
    with pytest.raises(e.DispatchError) as err:
        e.reassign(db, inc.incident_id, ADMIN, "ambulance", unit(db, "Police 01").unit_id)
    assert err.value.status == 409
    unit(db, "Ambulance 01").status = "assigned"
    db.commit()
    with pytest.raises(e.DispatchError) as err:
        e.reassign(db, inc.incident_id, ADMIN, "ambulance", unit(db, "Ambulance 01").unit_id)
    assert err.value.status == 409
    with pytest.raises(e.DispatchError) as err:
        e.reassign(db, inc.incident_id, ADMIN, "ambulance", "missing")
    assert err.value.status == 404


# ---- service actions ---------------------------------------------------------

def approved_dispatch(db, svc="ambulance"):
    inc = incident(db)
    e.propose(db, inc, [svc])
    out = e.approve_incident(db, inc.incident_id, ADMIN)
    return inc, out.dispatches[0]


def test_full_lifecycle_updates_unit_and_incident_status(db):
    inc, d = approved_dispatch(db)
    u = db.get(Unit, d.unit_id)
    actor = {"type": "service", "id": u.unit_id}
    e.accept(db, d.dispatch_id, u.unit_id, actor)
    assert u.status == "assigned" and inc.status == "dispatched"
    e.set_progress(db, d.dispatch_id, u.unit_id, actor, "en_route")
    assert u.status == "en_route" and inc.status == "en_route"
    e.set_progress(db, d.dispatch_id, u.unit_id, actor, "on_scene")
    assert u.status == "on_scene" and inc.status == "on_scene"
    e.set_progress(db, d.dispatch_id, u.unit_id, actor, "completed")
    assert u.status == "available" and d.status == "completed"


def test_progress_cannot_skip_steps_or_use_bad_value(db):
    inc, d = approved_dispatch(db)
    uid = d.unit_id
    with pytest.raises(e.DispatchError) as err:
        e.set_progress(db, d.dispatch_id, uid, ADMIN, "en_route")  # not accepted yet
    assert err.value.status == 409
    with pytest.raises(e.DispatchError) as err:
        e.set_progress(db, d.dispatch_id, uid, ADMIN, "approved")
    assert err.value.status == 400


def test_other_unit_cannot_touch_dispatch(db):
    _, d = approved_dispatch(db)
    other = unit(db, "Ambulance 01").unit_id
    for fn in (lambda: e.accept(db, d.dispatch_id, other, ADMIN),
               lambda: e.decline(db, d.dispatch_id, other, ADMIN, "x"),
               lambda: e.set_progress(db, d.dispatch_id, other, ADMIN, "en_route")):
        with pytest.raises(e.DispatchError) as err:
            fn()
        assert err.value.status == 404


def test_decline_repropose_next_nearest_and_never_the_decliner(db):
    inc, d = approved_dispatch(db)
    decliner = db.get(Unit, d.unit_id)
    assert decliner.name == "Ambulance 02"
    out = e.decline(db, d.dispatch_id, decliner.unit_id, ADMIN, "vehicle fault")
    assert d.status == "declined" and decliner.status == "available"
    new = out.dispatches[1]
    assert db.get(Unit, new.unit_id).name == "Ambulance 01" and new.status == "approved"
    assert db.get(Unit, new.unit_id).status == "assigned"
    # the decliner is free again but must not be re-picked for this incident
    out2 = e.decline(db, new.dispatch_id, new.unit_id, ADMIN, "also busy")
    assert out2.unfilled == ["ambulance"] and "after decline" in out2.incident.reason


def test_cannot_decline_after_accepting(db):
    _, d = approved_dispatch(db)
    e.accept(db, d.dispatch_id, d.unit_id, ADMIN)
    with pytest.raises(e.DispatchError) as err:
        e.decline(db, d.dispatch_id, d.unit_id, ADMIN, "late")
    assert err.value.status == 409


# ---- report status sync ------------------------------------------------------

def test_report_status_follows_incident(db):
    r = Report(report_id="r1", device_id="dev", created_at_signed="t", ciphertext=b"x", signature="s", kind="report",
               category="accident", server_time="t", receipt_signature="s")
    db.add(r)
    inc = incident(db, report_ids=["r1"])
    e.propose(db, inc, ["ambulance"])
    out = e.approve_incident(db, inc.incident_id, ADMIN)
    assert r.status == "dispatched" and r.incident_id == inc.incident_id and out.reports == [r]
    d = out.dispatches[0]
    e.accept(db, d.dispatch_id, d.unit_id, ADMIN)
    e.set_progress(db, d.dispatch_id, d.unit_id, ADMIN, "en_route")
    assert r.status == "en_route"


# ---- audit -------------------------------------------------------------------

def test_every_action_is_audited(db):
    from app.models import AuditEntry

    inc = incident(db)
    e.propose(db, inc, ["ambulance"])
    out = e.approve_incident(db, inc.incident_id, ADMIN)
    d = out.dispatches[0]
    e.accept(db, d.dispatch_id, d.unit_id, ADMIN)
    e.set_progress(db, d.dispatch_id, d.unit_id, ADMIN, "en_route")
    actions = [a.action for a in db.query(AuditEntry).order_by(AuditEntry.seq)]
    assert actions == ["dispatch.propose", "dispatch.approve", "dispatch.accept", "dispatch.status"]


def test_nearest_sees_unflushed_status_changes(db):
    u = unit(db, "Ambulance 02")
    u.status = "assigned"  # pending in the session, not flushed
    assert e.find_nearest_available(db, "ambulance", *CENTER).unit.name == "Ambulance 01"


def test_closed_incidents_reject_reject_and_reassign(db):
    inc = incident(db, status="resolved")
    with pytest.raises(e.DispatchError) as err:
        e.reject_incident(db, inc.incident_id, ADMIN, "late")
    assert err.value.status == 409
    with pytest.raises(e.DispatchError) as err:
        e.reassign(db, inc.incident_id, ADMIN, "ambulance", unit(db, "Ambulance 01").unit_id)
    assert err.value.status == 409


def test_report_sync_skips_statuses_reports_do_not_have(db):
    r = Report(report_id="r2", device_id="dev", created_at_signed="t", ciphertext=b"x", signature="s", kind="report",
               category="accident", server_time="t", receipt_signature="s")
    db.add(r)
    inc = incident(db, status="new", report_ids=["r2"])
    out = e.Outcome()
    e._sync_reports(db, inc, out)
    assert r.status == "received" and out.reports == []
