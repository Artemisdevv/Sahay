"""Pure-function checks for the demo simulator. Run: backend\.venv\Scripts\python.exe -m pytest demo -q"""
import ast
from pathlib import Path

import sahay_demo as d


def test_every_scenario_is_playable():
    assert set(d.SCENARIOS) == {"heart-attack", "house-fire", "road-accident", "flood", "burglary"}
    for s in d.SCENARIOS.values():
        assert s.text["en"] and s.text["ml"] and s.category in {"accident", "fire", "medical", "crime", "flood", "other"}
        for crew in s.chatter.values():
            assert set(crew) == set(d.PHASES), (s.key, crew.keys())


def test_distance_and_interpolation():
    assert abs(d.km((9.9312, 76.2673), (9.9312, 76.2673))) < 1e-9
    assert 110 < d.km((9.0, 76.0), (10.0, 76.0)) < 112
    assert d.lerp((0, 0), (10, 20), 0.5) == (5, 10)


def test_demo_is_isolated_from_the_app_code():
    tree = ast.parse(Path(d.__file__).read_text(encoding="utf-8"))
    roots = {n.names[0].name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import)}
    roots |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
    assert not roots & {"app", "backend", "web"}, roots


def test_every_incident_type_has_a_story():
    for story in d.SCENARIO_FOR_TYPE.values():
        assert story in d.SCENARIOS
