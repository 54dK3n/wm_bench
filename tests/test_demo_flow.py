"""Offline orchestration regressions; no simulator or top-level student program runs."""

import ast
from enum import Enum
import json
import math
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


ROOT = Path(__file__).resolve().parents[1]
PROGRAM = ROOT / "programs/world_model_two_target_demo.py"
BASE = ROOT / "artifacts/inloop/stage-1/round-3/program.py"
FRAGMENT = ROOT / "programs/demo_flow_fragment.py"


class Status(Enum):
    CONFIRMED = "confirmed"
    TENTATIVE = "tentative"
    STALE = "stale"
    LOST = "lost"


def target(track_id, x=1.0, z=1.0, confidence=0.9, state=Status.CONFIRMED):
    return SimpleNamespace(obj_id=track_id, name="target", x=x, z=z,
                           confidence=confidence, state=state, hit_count=3)


class Memory:
    def __init__(self, tracks):
        self.tracks = list(tracks)
        self.assoc_cfg = SimpleNamespace(gate_distance_m=0.30)

    def get_scene(self):
        return self.tracks

    def get_object(self, track_id):
        return next((obj for obj in self.tracks if obj.obj_id == track_id), None)


def namespace(tracks=()):
    tree = ast.parse(PROGRAM.read_text())
    nodes = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            nodes.append(node)
        elif isinstance(node, ast.Assign) and len(node.targets) == 1:
            name = getattr(node.targets[0], "id", "")
            if name.isupper() and name not in ("_WM_ZIP_BYTES", "WM_EMBED_SHA256"):
                try:
                    ast.literal_eval(node.value)
                except (ValueError, TypeError):
                    if name not in ("VP_STATE", "DEMO_STATE"):
                        continue
                nodes.append(node)
    ns = {"json": json, "math": math, "ObjectState": Status}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PROGRAM), "exec"), ns)
    machine = {"tick": 123, "held": None, "completed": 0}
    odo = {"tick": 123, "rightCm": 0.0, "forwardCm": 0.0, "headingDeg": 0.0}
    ns.update(wm=Memory(tracks), robot=SimpleNamespace(holding=lambda: machine["held"]),
              mission={"storage": {"roadId": "storage-road", "progressCm": 15.0}},
              nav_odometry=Mock(return_value=odo),
              nav_task_state=lambda: {"completed": machine["completed"],
                                      "targetDelivered": machine["completed"] == 2},
              odometry_to_pose=lambda item: SimpleNamespace(x=item.get("rightCm", 0.0) / 100,
                                                            z=item.get("forwardCm", 0.0) / 100,
                                                            yaw_rad=-math.radians(item.get("headingDeg", 0.0))))
    ns["_vp_remember"] = Mock(return_value=(ns["odometry_to_pose"](odo), {"onRoad": True}))
    ns["_delivery_event"] = Mock()

    def release():
        machine["held"] = None
        machine["completed"] += 1
        machine["tick"] += 1
        odo["tick"] = machine["tick"]
        return {"accepted": True}

    ns["motion_release"] = Mock(side_effect=release)
    return ns, machine


def recorded(capsys):
    return [json.loads(line[3:]) for line in capsys.readouterr().out.splitlines() if line.startswith("GY ")]


def preview():
    return {"holding": "target", "releaseAccepted": True, "wouldCompleteDelivery": True}


def successful_motion(ns, machine):
    def confirm(_pose, observations):
        assert observations == []
        assert ns["STATE"]["accepted_hits"] == []
        selected = ns["_wm_target"]()
        ns["STATE"]["accepted_hits"] = [{"track_id": selected.obj_id}] * 3
        ns["STATE"]["observe_count"] += 3
        return selected

    def approach(selected):
        machine["held"] = "目标物"
        ns["STATE"]["approach_calls"] += 1
        return True

    ns["_try_enter_range_and_confirm"] = Mock(side_effect=confirm)
    ns["approach_target_with_world_model"] = Mock(side_effect=approach)
    ns["patrol_until_target_seen"] = Mock(side_effect=AssertionError("memory must precede patrol"))
    ns["release_target_at_storage"] = Mock(side_effect=lambda: ns["_demo_release_active_target"](preview()))


def test_two_memory_targets_each_reconfirm_then_release_and_finish_once(capsys):
    ns, machine = namespace([target("first", 1, 1), target("second", 3, 3, confidence=0.8)])
    successful_motion(ns, machine)
    ns["run_target_flow"]()
    log = recorded(capsys)
    assert [item["track_id"] for item in log if item["event"] == "ball_selection"] == ["first", "second"]
    assert all(item["target_source"] == "memory" for item in log if item["event"] == "ball_start")
    assert [item["delivered_count"] for item in log if item["event"] == "ball_delivered"] == [1, 2]
    assert ns["_try_enter_range_and_confirm"].call_count == 2
    assert ns["STATE"]["observe_count"] == 6
    assert ns["STATE"]["approach_calls"] == 2
    assert ns["DEMO_STATE"]["delivered_track_ids"] == {"first", "second"}
    final = [item for item in log if item["event"] == "flow_end"]
    assert len(final) == 1 and final[0]["success"] and final[0]["full_targetDelivered"]
    assert all(item["tick"] is not None for item in log)


def test_no_memory_patrols_once_then_reuses_other_target_memory(capsys):
    ns, machine = namespace()
    successful_motion(ns, machine)

    def patrol(max_obs):
        assert max_obs == ns["PATROL_OBSERVE_BUDGET"]
        ns["wm"].tracks.extend([target("first"), target("second", 3, 3, confidence=0.8)])
        selected = ns["_wm_target"]()
        ns["STATE"]["accepted_hits"] = [{"track_id": selected.obj_id}] * 3
        return selected

    ns["patrol_until_target_seen"] = Mock(side_effect=patrol)
    ns["run_target_flow"]()
    assert ns["patrol_until_target_seen"].call_count == 1
    assert ns["_try_enter_range_and_confirm"].call_count == 1
    log = recorded(capsys)
    assert [item["target_source"] for item in log if item["event"] == "ball_start"] == ["new_observations", "memory"]


def test_per_ball_reset_preserves_motion_guard_wm_geometry_and_global_budgets():
    ns, _ = namespace([target("one")])
    ns["STATE"].update(observe_count=59, approach_calls=2, last_observe_pose=[0, 0, 0],
                       accepted_hits=[{"track_id": "old"}], confirmation_track_id="old")
    ns["NAV_STATE"].update(queries=500, controls=200)
    ns["VP_STATE"]["roads"]["road"] = [{"s": 5, "x": 0, "z": 0}]
    ns["VP_STATE"]["intervals"]["road"] = [(0, 10)]
    for key in ("explored", "failed", "nudged", "travel_attempts"):
        ns["VP_STATE"][key].add("old")
    ns["_demo_reset_ball"](2)
    assert ns["STATE"]["observe_count"] == 59 and ns["STATE"]["approach_calls"] == 2
    assert ns["STATE"]["last_observe_pose"] == [0, 0, 0]
    assert not ns["_observe_motion"]()[0]
    assert ns["NAV_STATE"]["queries"] == 500 and ns["NAV_STATE"]["controls"] == 200
    assert ns["wm"].get_scene()[0].obj_id == "one"
    assert ns["VP_STATE"]["roads"]["road"] and ns["VP_STATE"]["intervals"]["road"]
    assert all(not ns["VP_STATE"][key] for key in ("explored", "failed", "nudged", "travel_attempts"))
    assert ns["STATE"]["accepted_hits"] == [] and ns["STATE"]["confirmation_track_id"] is None


def test_selection_excludes_collected_ids_release_region_and_lost_tracks():
    ns, _ = namespace([target("delivered", 3, 3, 0.99), target("storage-alias", 0, 0, 0.98),
                       target("lost", 4, 4, 0.97, Status.LOST), target("remaining", 2, 2, 0.7)])
    ns["DEMO_STATE"]["collected_track_ids"].add("delivered")
    ns["DEMO_STATE"]["deliveries"].append({"x": 0, "z": 0, "track_id": "delivered"})
    assert ns["_demo_memory_target"]().obj_id == "remaining"


def test_locked_id_never_silently_switches_when_track_disappears():
    ns, _ = namespace([target("other", 2, 2)])
    ns["STATE"]["confirmation_track_id"] = "missing"
    assert ns["_wm_target"]() is None


def test_capped_reading_is_not_projected_for_delivered_exclusion():
    ns, _ = namespace()
    ns["calibrated_detection"] = Mock(side_effect=AssertionError("100cm cannot become a point"))
    assert ns["_demo_observation_eligible"]({"category": "target", "distanceCm": 100}, object())
    ns["calibrated_detection"].assert_not_called()


def test_raw_logs_keep_delivered_and_low_confidence_red_blue(capsys):
    ns, _ = namespace()
    raw = [dict(category="target", distanceCm=55, bearingDeg=0, confidence=0.9),
           dict(category="target", distanceCm=100, bearingDeg=10, confidence=0.8),
           dict(category="target", distanceCm=65, bearingDeg=-5, confidence=0.2),
           dict(category="distractor", distanceCm=85, bearingDeg=20, confidence=0.1)]
    ns["query_observe"] = Mock(return_value=raw)
    ns["calibrated_detection"] = Mock(return_value=SimpleNamespace(x=0, z=0))
    ns["DEMO_STATE"]["deliveries"].append({"x": 0, "z": 0, "track_id": "old"})
    result = ns["counted_observe"](None, 0.4, targets_only=True)
    assert result == [raw[1]]
    ns["query_observe"].assert_called_once_with(None, 0.0)
    log = recorded(capsys)
    assert next(item for item in log if item["event"] == "observe")["raw"] == raw
    assert next(item for item in log if item["event"] == "delivered_target_excluded")["distanceCm"] == 55
    assert ns["calibrated_detection"].call_count == 1


def test_release_uses_actual_pose_and_public_forward_projection(capsys):
    ns, machine = namespace()
    ns["STATE"]["confirmation_track_id"] = "one"
    ns["nav_odometry"].return_value.update(rightCm=120, forwardCm=340, headingDeg=-90)
    machine["held"] = "目标物"
    assert ns["_demo_release_active_target"](preview())
    delivery = ns["DEMO_STATE"]["deliveries"][0]
    assert delivery["x"] == pytest.approx(1.3375) and delivery["z"] == pytest.approx(3.4)
    event = next(item for item in recorded(capsys) if item["event"] == "ball_delivered")
    assert event["holding_after"] is None
    assert (event["completed_before"], event["completed_after"]) == (0, 1)
    assert event["exclusion_radius_m"] == 0.3


@pytest.mark.parametrize("held,increment", [("目标物", True), (None, False)])
def test_release_missing_required_evidence_does_not_count_delivery(held, increment, capsys):
    ns, machine = namespace()
    ns["STATE"]["confirmation_track_id"] = "one"

    def release():
        machine["held"] = held
        machine["completed"] += int(increment)

    ns["motion_release"] = release
    assert not ns["_demo_release_active_target"](preview())
    assert ns["DEMO_STATE"]["deliveries"] == []
    assert not any(item["event"] == "ball_delivered" for item in recorded(capsys))


def test_delivery_bookkeeping_precedes_leave_failure():
    ns, machine = namespace()
    ns["STATE"]["confirmation_track_id"] = "one"
    machine["held"] = "目标物"
    ns.update(go_to_anchor=Mock(), motion_left_angle=Mock(), _observe_motion=lambda: (False,),
              _dl_follow=Mock(return_value={"accepted": True, "distanceCm": 110}),
              nav_release_preview=Mock(return_value=preview()),
              leave_released_package=Mock(side_effect=ns["MissionFailure"]("leave_failed")))
    with pytest.raises(ns["MissionFailure"], match="leave_failed"):
        ns["release_target_at_storage"]()
    assert ns["DEMO_STATE"]["delivered_track_ids"] == {"one"}
    assert len(ns["DEMO_STATE"]["deliveries"]) == 1


@pytest.mark.parametrize("stage", ["confirmation", "grab", "delivery"])
def test_normal_failure_stops_before_second_ball(stage, capsys):
    ns, machine = namespace([target("one"), target("two", 3, 3, 0.8)])
    successful_motion(ns, machine)
    if stage == "confirmation":
        ns["_try_enter_range_and_confirm"] = Mock(return_value=None)
    elif stage == "grab":
        ns["approach_target_with_world_model"] = Mock(return_value=False)
    else:
        ns["release_target_at_storage"] = Mock(return_value=False)
    ns["run_target_flow"]()
    log = recorded(capsys)
    assert len([item for item in log if item["event"] == "ball_start"]) == 1
    final = next(item for item in log if item["event"] == "flow_end")
    assert not final["success"] and final["stage"] == stage
    if stage == "confirmation":
        ns["approach_target_with_world_model"].assert_not_called()


def test_unexpected_type_error_still_propagates():
    ns, _ = namespace([target("one")])
    ns["_try_enter_range_and_confirm"] = Mock(side_effect=TypeError("real_bug"))
    with pytest.raises(TypeError, match="real_bug"):
        ns["run_target_flow"]()


def test_target_anchor_fields_are_not_read_during_initialization_or_flow(capsys):
    class ProtectedTarget(dict):
        def __getitem__(self, key):
            if key in ("roadId", "progressCm"):
                raise AssertionError("target anchor access forbidden")
            return super().__getitem__(key)

        def get(self, key, default=None):
            if key in ("roadId", "progressCm"):
                raise AssertionError("target anchor access forbidden")
            return super().get(key, default)

    ns, machine = namespace([target("one"), target("two", 3, 3, 0.8)])
    ns["mission"]["objects"] = [ProtectedTarget(role="target", roadId="hidden", progressCm=42),
                                 {"role": "obstacle", "roadId": "closed", "progressCm": 5}]
    assignment = next(node for node in ast.parse(PROGRAM.read_text()).body
                      if isinstance(node, ast.Assign) and any(getattr(item, "id", "") == "obstacle_anchors"
                                                              for item in node.targets))
    exec(compile(ast.Module(body=[assignment], type_ignores=[]), str(PROGRAM), "exec"), ns)
    assert ns["obstacle_anchors"] == [{"role": "obstacle", "roadId": "closed", "progressCm": 5}]
    successful_motion(ns, machine)
    ns["run_target_flow"]()
    assert next(item for item in recorded(capsys) if item["event"] == "flow_end")["success"]
    assert "target_anchors" not in PROGRAM.read_text()


def test_frozen_measurement_confirmation_wm_and_motion_routines_unchanged():
    original = ast.parse(BASE.read_text())
    demo = ast.parse(PROGRAM.read_text())
    original_defs = {node.name: node for node in original.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
    demo_defs = {node.name: node for node in demo.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
    permitted = {"release_target_at_storage", "counted_observe", "_wm_target", "_finish_flow", "run_target_flow"}
    removed = {"_approach_graph_exit_fallback", "_approach_choose_exit"}
    assert set(original_defs) - set(demo_defs) == removed
    for name in set(original_defs) & set(demo_defs) - permitted:
        assert ast.dump(original_defs[name], include_attributes=False) == ast.dump(demo_defs[name], include_attributes=False), name
    for name in ("RANGE_CAL", "_WM_ZIP_BYTES"):
        before = next(node for node in original.body if isinstance(node, ast.Assign)
                      and any(getattr(item, "id", "") == name for item in node.targets))
        after = next(node for node in demo.body if isinstance(node, ast.Assign)
                     and any(getattr(item, "id", "") == name for item in node.targets))
        assert ast.dump(before.value, include_attributes=False) == ast.dump(after.value, include_attributes=False)
    assert FRAGMENT.read_text().strip() in PROGRAM.read_text()
