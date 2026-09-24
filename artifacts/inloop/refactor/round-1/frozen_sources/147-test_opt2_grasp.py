"""Offline public-window geometry and bounded recovery contracts; no simulator run."""
import ast
import asyncio
import importlib.util
import math
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools.platform_paths import platform_root, platform_worker

SOURCE = Path(__file__).resolve().parents[1] / "src/opt2_grasp_fragment.py"


class Rig:
    """Tiny analytic test fixture, deliberately separate true and WM locations."""
    def __init__(self, ball_forward=12, ball_side=0, wm_forward=22, wm_side=0):
        self.ball = (ball_side, ball_forward)
        self.odo = {"rightCm": 0., "forwardCm": 0., "headingDeg": 0., "distanceCm": 0., "tick": 0}
        self.road = {"onRoad": True, "roadId": "synthetic-road"}
        self.target = SimpleNamespace(obj_id="locked", name="target", x=wm_side/100, z=wm_forward/100,
                                      state=SimpleNamespace(value="confirmed"))
        self.scene = [self.target]
        self.held = None; self.actions = []; self.logs = []; self.query_count = 0
        self.after_turn = None; self.after_grab = None
        self.state = {"confirmation_track_id": "locked", "forward_after_last_observe_cm": 40.,
                      "last_observe_distance_m": .6, "last_observe_camera_distance_cm": 50,
                      "approach_calls": 1, "observe_count": 7}
    def turn(self, angle):
        self.actions.append(("turn", angle));self.odo["headingDeg"] += angle;self.odo["tick"] += 1
        if self.after_turn:self.after_turn(self)
    def grab(self):
        self.actions.append(("grab", self.odo["headingDeg"]));self.odo["tick"] += 1
        x, z = self.ball[0]-self.odo["rightCm"], self.ball[1]-self.odo["forwardCm"]
        # Independent rectangular interaction condition, with a unit heading vector.
        a = math.radians(self.odo["headingDeg"])
        f = (-math.sin(a), math.cos(a)); right = (math.cos(a), math.sin(a))
        longitudinal = x*f[0] + z*f[1]; lateral = x*right[0] + z*right[1]
        if 4.75-1e-9 <= longitudinal <= 16.875+1e-9 and abs(lateral) <= 4.75+1e-9:
            self.held = "目标物"
        if self.after_grab:self.after_grab(self)
    def forward(self, cm):
        self.actions.append(("forward", cm));a = math.radians(self.odo["headingDeg"])
        self.odo["rightCm"] -= cm*math.sin(a);self.odo["forwardCm"] += cm*math.cos(a)
        self.odo["distanceCm"] += cm;self.odo["tick"] += 1
    def odometry(self):
        self.query_count += 1;return dict(self.odo)
    def road_state(self):
        self.query_count += 1;return dict(self.road)
    def event(self, event, **kw):self.logs.append({"event": event, **kw})


def module_for(rig):
    spec = importlib.util.spec_from_file_location("grasp_test", SOURCE)
    mod = importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    mod.STATE = rig.state;mod.GRAB_AIM_TOL_DEG = 3.;mod.GRAB_STEP_CM = 6.;mod.GRAB_MAX_ADVANCE_CM = 42.
    mod.MEMORY_FORWARD_MIN_CM = 30.
    mod._wm_target = lambda:rig.target
    mod.wm = SimpleNamespace(get_scene=lambda:rig.scene)
    mod.robot = SimpleNamespace(holding=lambda:rig.held)
    mod.nav_odometry = rig.odometry;mod.nav_road_state = rig.road_state
    mod.motion_left_angle = rig.turn;mod.motion_right_angle = lambda angle:rig.turn(-angle)
    mod.motion_grab = rig.grab;mod.motion_forward = rig.forward;mod._approach_event = rig.event
    return mod


def scan(rig):
    # Exercise the retained lateral scan independently of a following step.
    return module_for(rig)._opt2_grasp_recover_after_miss("locked", dict(rig.odo), dict(rig.road), None, False)


def test_analytic_coverage_bounds_are_strict():
    mod = module_for(Rig());step = mod.opt2_grasp_scan_offsets()[0];half = math.radians(step/2)
    assert 16.875*math.sin(half) < 4.75
    assert math.sqrt(2)*4.75*math.cos(half) > 4.75
    assert math.degrees(math.acos(4.75/16.875)) < 2.5*step
    assert len(mod.opt2_grasp_scan_offsets()) == 4


def test_dense_forward_cap_coverage_and_original_rectangle():
    mod = module_for(Rig());angles = [0., *mod.opt2_grasp_scan_offsets()]
    checked = 0
    # Required f range is the exact public 4.75..16.875 (16.9 is display rounding).
    for i in range(244):
        f = 4.75+(16.875-4.75)*i/243
        for j in range(651):
            side = -16.25 + .05*j
            original = abs(side) <= 4.75
            if not original and math.hypot(f, side) > 16.875:continue
            feasible = []
            for h in angles:
                a = math.radians(h)
                ff, ss = f*math.cos(a)-side*math.sin(a), side*math.cos(a)+f*math.sin(a)
                feasible.append(4.75-1e-8 <= ff <= 16.875+1e-8 and abs(ss) <= 4.75+1e-8)
            assert any(feasible), (f, side)
            checked += 1
    assert checked > 90000


@pytest.mark.parametrize("side", [-10., -5., 5., 10.])
def test_lateral_miss_caught_before_any_forward_step(side):
    rig = Rig(10, side, wm_forward=10, wm_side=side);mod = module_for(rig)
    assert mod._opt2_grab_loop()
    assert rig.actions[0][0] == "grab"
    assert not any(a[0] == "forward" for a in rig.actions)
    assert sum(a[0] == "grab" for a in rig.actions) <= 5
    assert rig.state["approach_calls"] == 1 and rig.state["observe_count"] == 7


def test_first_grab_success_has_identical_one_action_path():
    rig = Rig();assert module_for(rig)._opt2_grab_loop()
    assert rig.actions == [("grab", 0.)]
    assert not any("lateral" in e["event"] for e in rig.logs)
    assert rig.logs[-1]["grab_attempts"] == 1


@pytest.mark.parametrize("forward,side,expected_advance", [(23.4,1.2,12.),(22.3,2.4,6.),(17.8,-4.7,6.),(31.1,3.9,18.)])
def test_three_distinct_old_target_geometries_preserve_forward_capture(forward, side, expected_advance):
    rig = Rig(forward, side);assert module_for(rig)._opt2_grab_loop()
    assert sum(a[1] for a in rig.actions if a[0] == "forward") == pytest.approx(expected_advance)
    assert rig.logs[-1]["grab_advanced_cm"] == pytest.approx(expected_advance)
    assert rig.state["forward_after_last_observe_cm"] == pytest.approx(40+expected_advance)


def test_far_empty_scan_restores_heading_and_caps_queries():
    rig = Rig(100, 0);rig.odo["headingDeg"] = 179.
    r = scan(rig)
    assert r["status"] == "empty_restored" and r["safe_to_advance"]
    assert rig.odo["headingDeg"] == pytest.approx(179)
    assert r["extra_grab_attempts"] == 4 and rig.query_count <= 18
    assert sum(a[0] == "turn" for a in rig.actions) == 5
    assert rig.odo["rightCm"] == rig.odo["forwardCm"] == 0


def test_entire_empty_loop_is_bounded_by_original_translation_cap():
    rig = Rig(100, wm_forward=12);assert not module_for(rig)._opt2_grab_loop()
    assert sum(a[0] == "grab" for a in rig.actions) == 40  # 8 stations * (1+4)
    assert sum(a[1] for a in rig.actions if a[0] == "forward") == pytest.approx(42)
    assert rig.logs[-1]["reason"] == "max_advance_reached"


@pytest.mark.parametrize("mutation,reason", [
    (lambda r:r.road.update(onRoad=False), "off_road"),
    (lambda r:r.odo.update(rightCm=1), "unexpected_translation_during_in_place_scan"),
    (lambda r:r.state.update(confirmation_track_id="different"), "confirmed_track_changed"),
    (lambda r:setattr(r.target.state,"value","suspected"), "target_not_confirmed"),
])
def test_abort_before_grab_on_changed_contract(mutation,reason):
    rig = Rig(100);rig.after_turn = mutation;r = scan(rig)
    assert r["reason"] == reason and not r["safe_to_advance"]
    assert not any(a[0] == "grab" for a in rig.actions)


def test_wrong_holding_class_stops_without_forward_or_more_grabs():
    rig = Rig(100);rig.after_grab = lambda r:setattr(r,"held","干扰物")
    r = scan(rig);assert r["reason"] == "holding_wrong_class"
    assert r["extra_grab_attempts"] == 1 and not r["safe_to_advance"]


def test_known_competitor_blocks_its_scan_angle():
    rig = Rig(100);mod = module_for(rig)
    first_angle = mod.opt2_grasp_scan_offsets()[0];a = math.radians(first_angle)
    other = SimpleNamespace(obj_id="other",name="target",x=-.12*math.sin(a),z=.12*math.cos(a),
                            state=SimpleNamespace(value="confirmed"))
    rig.scene.append(other);r = scan(rig)
    assert r["trials"][0]["skipped"] == "known_other_ball_may_be_grabbed"
    assert r["trials"][0]["competitors"][0]["track_id"] == "other"
    assert r["extra_grab_attempts"] <= 3


def test_preexisting_holding_never_becomes_new_capture():
    rig = Rig();rig.held = "目标物"
    assert not module_for(rig)._opt2_grab_loop()
    assert not rig.actions and rig.logs[-1]["reason"] == "unexpected_preexisting_holding"


def test_geometric_limit_is_explicit_not_a_universal_guarantee():
    rig = Rig(16.875, 10.)
    r = scan(rig)
    assert math.hypot(*rig.ball) > math.hypot(16.875,4.75)
    assert r["status"] == "empty_restored"  # No in-place angle can capture this radius.


@pytest.mark.parametrize("forward,side,wm_forward,wm_side,expected_advance", [
    (10., 8., 10., 8., 0.),
    (22., 0., 22., 0., 6.),
])
def test_platform_async_transform_executes_complete_loop(forward, side, wm_forward, wm_side, expected_advance):
    rig = Rig(forward, side, wm_forward=wm_forward, wm_side=wm_side)
    wrapper_source = '''
def nav_odometry(): return driver.odometry()
def nav_road_state(): return driver.road_state()
def motion_left_angle(angle): driver.turn(angle)
def motion_right_angle(angle): driver.turn(-angle)
def motion_grab(): driver.grab()
def motion_forward(cm): driver.forward(cm)
def _wm_target(): return driver.target
def _approach_event(event, **kw): driver.event(event, **kw)
'''
    source = SOURCE.read_text()+wrapper_source;tree = ast.parse(source)
    assert not any(isinstance(n,ast.ClassDef) for n in ast.walk(tree))
    names = {n.name for n in ast.walk(tree) if isinstance(n,ast.FunctionDef)}
    assert not any(isinstance(n,ast.Attribute) and n.attr in ("observe","approach") for n in ast.walk(tree))
    platform = platform_root()
    worker = (platform/"python-worker.js").read_text()
    transformer = worker[worker.index("class AsyncRobotTransformer("):worker.index("student_run_target =")]
    ns = {"ast":ast};exec(transformer,ns)
    async def holding():return rig.held
    runtime = {"driver":rig,"STATE":rig.state,"GRAB_AIM_TOL_DEG":3.,"GRAB_STEP_CM":6.,
               "GRAB_MAX_ADVANCE_CM":42.,"MEMORY_FORWARD_MIN_CM":30.,
               "robot":SimpleNamespace(holding=holding),"wm":SimpleNamespace(get_scene=lambda:rig.scene)}
    transformed = ns["AsyncRobotTransformer"](names).visit(tree);ast.fix_missing_locations(transformed)
    exec(compile(transformed,str(SOURCE),"exec"),runtime)
    assert asyncio.run(runtime["_opt2_grab_loop"]())
    assert sum(a[1] for a in rig.actions if a[0] == "forward") == pytest.approx(expected_advance)


@pytest.mark.parametrize("forward,side,available,expected", [
    (22., 0., True, True),
    (22., 4.75, True, True),
    (22., 4.751, True, False),
    (16.875, 4.75, True, False),  # Exact corner: strict outside test.
    (17., 0., True, False),  # forward > max is insufficient; radius can fit a corner.
    (-22., 0., True, False),
    (22., 0., False, False),  # The last station retains its scan.
])
def test_skip_gate_uses_only_public_geometry_and_available_original_step(forward, side, available, expected):
    rig = Rig(wm_forward=forward, wm_side=side);mod = module_for(rig)
    decision = mod.opt2_grasp_scan_decision(rig.target.x, rig.target.z, rig.odo, 6., available)
    assert decision["skip_scan"] is expected
    assert decision["public_corner_radius_cm"] == pytest.approx(math.sqrt(16.875**2+4.75**2))
    assert decision["next_predicted_forward_cm"] == pytest.approx(forward-6.)
    assert decision["wm_right_cm"] == pytest.approx(side)


def test_far_prediction_skips_without_queries_turns_or_extra_grabs():
    rig = Rig(100);mod = module_for(rig)
    result = mod._opt2_grasp_recover_after_miss("locked", dict(rig.odo), dict(rig.road), None, True)
    assert result["status"] == "empty_geometry_advance" and result["safe_to_advance"]
    assert result["heading_restored"] and result["extra_grab_attempts"] == 0
    assert not rig.actions and rig.query_count == 0
    assert rig.logs[-1]["event"] == "grab_lateral_recovery_decision"
    assert rig.logs[-1]["wm_forward_cm"] == pytest.approx(22.)
    assert all(rig.logs[-1]["conditions"].values())


def test_original_first_grab_then_original_six_cm_step_and_capture():
    rig = Rig(22., 0.);assert module_for(rig)._opt2_grab_loop()
    assert rig.actions == [("grab", 0.), ("forward", 6.), ("grab", 0.)]
    assert rig.logs[-1]["grab_attempts"] == 2
    assert rig.logs[-1]["grab_advanced_cm"] == pytest.approx(6.)
    assert rig.state["observe_count"] == 7 and rig.state["approach_calls"] == 1


def test_final_station_scans_even_when_wm_prediction_is_far():
    rig = Rig(100);mod = module_for(rig);mod.GRAB_MAX_ADVANCE_CM = 0.
    assert not mod._opt2_grab_loop()
    assert sum(action[0] == "grab" for action in rig.actions) == 5
    assert not any(action[0] == "forward" for action in rig.actions)
    decision = next(row for row in rig.logs if row["event"] == "grab_lateral_recovery_decision")
    assert not decision["skip_scan"] and not decision["conditions"]["advance_available"]


def test_overestimated_wm_distance_can_skip_useful_scan_is_explicit_risk():
    rig = Rig(10., 10., wm_forward=22., wm_side=0.)
    assert module_for(rig)._opt2_grab_loop()
    # A rotation could capture the original truth point, but the estimate says far.
    # This counterexample intentionally prevents a claim of universal safety.
    assert rig.actions[:2] == [("grab", 0.), ("forward", 6.)]
    assert any(row.get("skip_scan") for row in rig.logs)


def test_changed_confirmation_still_stops_before_geometry_skip():
    rig = Rig(100);rig.state["confirmation_track_id"] = "different"
    result = module_for(rig)._opt2_grasp_recover_after_miss("locked", dict(rig.odo), dict(rig.road), None, True)
    assert result["reason"] == "confirmed_track_changed" and not result["safe_to_advance"]
    assert not rig.actions


@pytest.mark.parametrize("forward,side,wm_forward,wm_side,advance", [
    (19.45480230139138, -1.6094284339715812, 21.211526611108187, .033746499799695906, 6.),
    (17.82258877713831, -4.737146663344968, 21.973308918480306, 2.3310287799668634, 6.),
    (31.0824123648595, 3.9003074517401246, 22.07718071669727, -1.047898660315096, 18.),
])
def test_three_independent_native_geometries_keep_original_forward_capture(forward, side, wm_forward, wm_side, advance):
    # Round1 map05-C, map06-D, map09-E. Truth exists only in this analytic fixture;
    # source events and same-tick pose hashes are in evidence-diagnosis artifacts.
    rig = Rig(forward, side, wm_forward=wm_forward, wm_side=wm_side)
    assert module_for(rig)._opt2_grab_loop()
    assert rig.actions[:2] == [("grab", 0.), ("forward", 6.)]
    assert sum(a[1] for a in rig.actions if a[0] == "forward") == pytest.approx(advance)
    assert rig.held == "目标物"
