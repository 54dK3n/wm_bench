"""Platform-independent regression checks for confirmation and observation logging.

Load only the relevant definitions from the deployed program. Its top-level code
requires the simulator and must never run when collecting these tests.
"""

import ast
import json
import math
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


PROGRAM = Path(__file__).resolve().parents[2] / "artifacts/inloop/stage-1/round-3/program.py"


def isolated(*names, **overrides):
    tree = ast.parse(PROGRAM.read_text(encoding="utf-8"), filename=str(PROGRAM))
    namespace = {"math": math, "json": json}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name) or not target.id.isupper():
            continue
        try:
            namespace[target.id] = ast.literal_eval(node.value)
        except (ValueError, TypeError):
            pass
    selected = [
        node for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names
    ]
    assert {node.name for node in selected} == set(names)
    namespace.update(overrides)
    # Business tests use the same fake robot calls before and after navigation
    # caching was introduced. The real wrappers and async transformation are
    # exercised separately in test_navigation_cache.py.
    if "robot" in namespace:
        aliases = {
            **{f"nav_{method}": method for method in (
                "odometry", "road_state", "mission", "map_graph",
                "task_state", "release_preview",
            )},
            **{f"motion_{method}": method for method in (
                "forward", "backward", "left_angle", "right_angle",
                "follow_road", "take_exit", "approach", "grab", "release",
            )},
            "query_observe": "observe",
        }

        def robot_call(method):
            def call(*args, **kwargs):
                return getattr(namespace["robot"], method)(*args, **kwargs)
            return call

        for alias, method in aliases.items():
            if hasattr(namespace["robot"], method):
                namespace.setdefault(alias, robot_call(method))
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(PROGRAM), "exec"), namespace)
    return namespace


def events(capsys):
    return [
        json.loads(line.removeprefix("GY "))
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("GY ")
    ]


@pytest.mark.parametrize("distance_cm", [40.0, 65.0, 89.0])
@pytest.mark.parametrize("bearing_deg", [-35.0, -12.0, 0.0, 21.0, 35.0])
def test_calibration_inverse_recovers_raw_distance(distance_cm, bearing_deg):
    ns = isolated("calibrate_reading", "uncalibrate_reading")
    corrected = ns["calibrate_reading"](distance_cm, bearing_deg)
    assert ns["uncalibrate_reading"](*corrected) == pytest.approx(distance_cm, abs=1e-10)












@pytest.mark.parametrize("query,targets_only", [(None, True), ("存放点", False)])
def test_observe_logs_all_red_blue_before_category_and_confidence_filters(capsys, query, targets_only):
    low_red = {"category": "target", "name": "红球", "distanceCm": 25, "bearingDeg": -5, "confidence": 0.2}
    low_blue = {"category": "distractor", "name": "蓝球", "distanceCm": 100, "bearingDeg": 7, "confidence": 0.3}
    red = {"category": "target", "name": "红球", "distanceCm": 65, "bearingDeg": 2, "confidence": 0.91}
    storage = {"category": "storage-zone", "name": "存放点", "distanceCm": 40, "bearingDeg": 0, "confidence": 0.95}
    observe = Mock(return_value=[low_red, low_blue, red, storage])
    ns = isolated(
        "MissionFailure", "_wrap_deg", "_observe_motion", "_is_target", "counted_observe",
        robot=SimpleNamespace(odometry=lambda: {"tick": 123}, observe=observe),
        STATE={"observe_count": 0},
    )
    result = ns["counted_observe"](query, 0.4, targets_only=targets_only)
    observe.assert_called_once_with(None, 0.0)
    assert result == ([red] if targets_only else [storage])
    logged = next(event for event in events(capsys) if event["event"] == "observe")
    assert logged["tick"] == 123
    assert logged["observe_count"] == 1
    assert logged["raw"] == [
        {key: item[key] for key in ("category", "distanceCm", "bearingDeg", "confidence")}
        for item in (low_red, low_blue, red)
    ]


def test_window_log_distinguishes_seen_outside_from_no_detection(capsys):
    update = Mock()
    ns = isolated(
        "_is_target", "calibrate_reading", "_update_wm",
        wm=SimpleNamespace(update=update, get_scene=lambda: [], aliases={}, assoc_cfg=object()),
        associate=Mock(return_value=SimpleNamespace(matches=[], unmatched_detections=[])),
        _wm_target=lambda: None,
        robot=SimpleNamespace(odometry=lambda: {"tick": 123}),
        calibrated_detection=lambda *_args: SimpleNamespace(x=0.0, z=0.0),
        STATE={},
    )
    pose = SimpleNamespace(x=0.0, z=0.0)
    observations = [
        {"category": "target", "distanceCm": distance, "bearingDeg": 0.0, "confidence": 0.9}
        for distance in [39, 40, 89, 90, 100]
    ]
    ns["_update_wm"](observations, pose, 1.0)
    logged = next(event for event in events(capsys) if event["event"] == "target_observations")
    assert (logged["count"], logged["seen"]) == (2, 5)
    assert [item["distanceCm"] for item in logged["items"]] == [40, 89]
    assert [item["distanceCm"] for item in logged["outside_window"]] == [39, 90, 100]
    assert len(update.call_args.args[0]) == 2

    ns["_update_wm"](observations[-1:], pose, 2.0)
    outside = next(event for event in events(capsys) if event["event"] == "target_observations")
    ns["_update_wm"]([], pose, 3.0)
    unseen = next(event for event in events(capsys) if event["event"] == "target_observations")
    assert outside["count"] == unseen["count"] == 0
    assert outside["seen"] == 1
    assert unseen["seen"] == 0
    assert update.call_count == 1


@pytest.mark.parametrize("failed_stage", ["confirmation", "grab", "delivery"])
def test_expected_flow_failure_reports_false_and_stops_later_stages(capsys, failed_stage):
    patrol = Mock(return_value=None if failed_stage == "confirmation" else object())
    approach = Mock(return_value=failed_stage != "grab")
    release = Mock(return_value=False)
    ns = isolated(
        "_finish_flow", "run_target_flow",
        robot=SimpleNamespace(task_state=lambda: {}, holding=lambda: None),
        patrol_until_target_seen=patrol,
        approach_target_with_world_model=approach,
        release_target_at_storage=release,
        _delivery_event=Mock(),
        DELIVERY_LOG={"on": False},
    )
    ns["run_target_flow"]()
    logged = next(event for event in events(capsys) if event["event"] == "flow_end")
    assert logged["success"] is False
    assert logged["one_target_released"] is False
    assert logged["stage"] == failed_stage
    assert logged["reason"]
    assert approach.call_count == (0 if failed_stage == "confirmation" else 1)
    assert release.call_count == (1 if failed_stage == "delivery" else 0)


@pytest.mark.parametrize("broken_stage", ["confirmation", "grab", "delivery"])
def test_unexpected_typeerror_propagates_unchanged(broken_stage):
    failure = TypeError("unexpected robot API signature")
    patrol = Mock(return_value=object())
    approach = Mock(return_value=True)
    release = Mock(return_value=True)
    {"confirmation": patrol, "grab": approach, "delivery": release}[broken_stage].side_effect = failure
    finish = Mock()
    ns = isolated(
        "run_target_flow",
        robot=SimpleNamespace(holding=lambda: None),
        patrol_until_target_seen=patrol,
        approach_target_with_world_model=approach,
        release_target_at_storage=release,
        _finish_flow=finish,
        _delivery_event=Mock(),
        DELIVERY_LOG={"on": False},
    )
    with pytest.raises(TypeError) as raised:
        ns["run_target_flow"]()
    assert raised.value is failure
    finish.assert_not_called()


@pytest.mark.parametrize(
    "right_cm,forward_cm,heading_deg,expected",
    [(0, 0, 0, False), (4.9, 0, 9.9, False), (5, 0, 0, True),
     (0, 0, 10, True), (3, 4, 0, True)],
)
def test_observe_motion_requires_five_cm_or_ten_degrees(right_cm, forward_cm, heading_deg, expected):
    ns = isolated("_wrap_deg", "_observe_motion", STATE={"last_observe_pose": [0, 0, 0]})
    ready, _pose, _moved, _turned = ns["_observe_motion"](
        {"rightCm": right_cm, "forwardCm": forward_cm, "headingDeg": heading_deg}
    )
    assert ready is expected


@pytest.mark.parametrize("heading,expected", [(-179, False), (-171, True)])
def test_observe_motion_wraps_heading_at_180_degrees(heading, expected):
    ns = isolated("_wrap_deg", "_observe_motion", STATE={"last_observe_pose": [0, 0, 179]})
    assert ns["_observe_motion"]({"headingDeg": heading})[0] is expected


def test_repeated_stationary_observe_is_rejected_before_query_or_count_increment():
    query = Mock(return_value=[])
    ns = isolated(
        "MissionFailure", "_wrap_deg", "_observe_motion", "counted_observe",
        robot=SimpleNamespace(odometry=lambda: {"tick": 12}, observe=query),
        STATE={"observe_count": 0, "last_observe_pose": None},
    )
    assert ns["counted_observe"]() == []
    with pytest.raises(ns["MissionFailure"], match="observe_motion_violation"):
        ns["counted_observe"]()
    assert ns["STATE"]["observe_count"] == 1
    query.assert_called_once_with(None, 0.0)


def test_observe_budget_failure_does_not_execute_an_extra_query():
    query = Mock()
    ns = isolated(
        "MissionFailure", "counted_observe", robot=SimpleNamespace(observe=query),
        STATE={"observe_count": 92},
    )
    with pytest.raises(ns["MissionFailure"], match="observe_budget_exhausted"):
        ns["counted_observe"]()
    query.assert_not_called()


def test_capped_100_reading_creates_bearing_ray_without_finite_range():
    calibration = Mock(side_effect=AssertionError("100cm is censored, not a finite measurement"))
    ns = isolated("_is_target", "_planning_goal", _wm_target=lambda: None, calibrated_detection=calibration)
    pose = SimpleNamespace(x=0.2, z=0.4, yaw_rad=math.pi / 2)
    result = ns["_planning_goal"](
        pose, [{"category": "target", "distanceCm": 100, "bearingDeg": 30}]
    )
    assert result["source"] == "capped_bearing_only"
    assert "x" not in result and "z" not in result
    assert (result["ray_x"], result["ray_z"]) == (0.2, 0.4)
    assert result["ux"] == pytest.approx(math.sin(2 * math.pi / 3))
    assert result["uz"] == pytest.approx(math.cos(2 * math.pi / 3))
    calibration.assert_not_called()


def test_existing_world_model_goal_is_kept_when_frame_has_capped_detections():
    target = SimpleNamespace(x=0.1, z=0.8, obj_id="selected")
    ns = isolated("_planning_goal", _wm_target=lambda: target)
    result = ns["_planning_goal"](object(), [{"category": "target", "distanceCm": 100}])
    assert result == {"x": 0.1, "z": 0.8, "track_id": "selected", "source": "world_model"}


def test_uncapped_out_of_window_observation_can_plan_but_is_not_a_confirmed_hit():
    detection = SimpleNamespace(x=0.0, z=0.3)
    ns = isolated(
        "_is_target", "_planning_goal", _wm_target=lambda: None,
        robot=SimpleNamespace(odometry=lambda: {"tick": 50}),
        calibrated_detection=Mock(return_value=detection),
    )
    result = ns["_planning_goal"](object(), [{"category": "target", "distanceCm": 20, "bearingDeg": 0}])
    assert result == {"x": 0.0, "z": 0.3, "source": "uncapped_planning_only"}


def test_confirmation_hit_locks_track_and_rejects_another_track_at_new_pose():
    first, other, later = {}, {}, {}
    state = {"accepted_hits": [], "confirmation_track_id": None,
             "frame_track_ids": {id(first): "a", id(other): "b", id(later): "a"}}
    ns = isolated("_record_hit", "_confirm_fail", STATE=state)
    detection = SimpleNamespace(x=0.0, z=1.0)
    pose = lambda z: SimpleNamespace(x=0.0, z=z, yaw_rad=0.0)
    assert ns["_record_hit"](pose(0), first, detection, 65) is True
    assert ns["_record_hit"](pose(0.2), other, detection, 55) is False
    assert ns["_record_hit"](pose(0.4), later, detection, 60) is True
    assert state["confirmation_track_id"] == "a"
    assert [hit["track_id"] for hit in state["accepted_hits"]] == ["a", "a"]


def test_nearest_candidate_stays_with_selected_track_even_when_another_is_closer():
    selected, closer = {}, {}
    wanted = (65, selected, object())
    ns = isolated(
        "_nearest_candidate",
        STATE={"confirmation_track_id": "a", "frame_track_ids": {id(selected): "a", id(closer): "b"}},
        _in_range_candidates=lambda *_args: [(45, closer, object()), wanted],
    )
    assert ns["_nearest_candidate"]([], object(), 1.0) is wanted


@pytest.mark.parametrize("bearing,allowed", [(-30, True), (30, True), (-30.1, False), (30.1, False)])
def test_confirmation_candidates_require_actual_bearing_within_30_degrees(bearing, allowed):
    item = {"category": "target", "distanceCm": 65, "bearingDeg": bearing}
    ns = isolated("_is_target", "_in_range_candidates", calibrated_detection=lambda *_args: object())
    assert bool(ns["_in_range_candidates"]([item], object(), 1.0)) is allowed


@pytest.mark.parametrize(
    "track_ids,positions,last_distance,expected",
    [(["a", "a", "a"], [0, 0.2, 0.4], 0.5, True),
     (["a", "b", "a"], [0, 0.2, 0.4], 0.6, False),
     (["a", "a", "a"], [0, 0.2, 0.4], 0.499, False),
     (["a", "a", "a"], [0, 0.2, 0.0], 0.6, False),
     (["a", "a"], [0, 0.2], 0.6, False)],
)
def test_final_confirmation_requires_three_same_track_separated_hits_and_half_metre(
    track_ids, positions, last_distance, expected
):
    target = SimpleNamespace(obj_id="a")
    hits = [{"track_id": tid, "pose_x": 0, "pose_z": pos, "distanceCm": 65}
            for tid, pos in zip(track_ids, positions)]
    event = Mock()
    ns = isolated(
        "_confirmation_result", "_confirm_fail", _target_confirmed=lambda: target,
        _wm_distance_m=lambda _pose: last_distance, _vp_event=event, STATE={"accepted_hits": hits},
    )
    result = ns["_confirmation_result"](object())
    assert (result is target) is expected
    assert any(call.args[0] == "memory_confirmed" for call in event.call_args_list) is expected


def test_graph_confirmation_exhaustion_is_reported_without_forced_sampling():
    observe = Mock()
    ns = isolated(
        "_try_enter_range_and_confirm", "_confirm_fail",
        robot=SimpleNamespace(odometry=lambda: {"tick": 1}),
        STATE={"accepted_hits": []},
        _planning_goal=lambda *_args: {"x": 0, "z": 0.8, "source": "world_model"},
        _nearest_candidate=lambda *_args: None, _vp_candidates=lambda *_args: [],
        _vp_explore=lambda *_args: False, counted_observe=observe,
    )
    assert ns["_try_enter_range_and_confirm"](object(), []) is None
    observe.assert_not_called()


def test_graph_replan_does_not_observe_at_the_transition_landing():
    selection = {"key": "b@30.0", "roadId": "b", "progressCm": 30, "x": 0, "z": 0.3, "path_cm": 50}
    candidates = Mock(side_effect=[[selection], []])
    observe = Mock()
    ns = isolated(
        "_try_enter_range_and_confirm", "_confirm_fail",
        robot=SimpleNamespace(odometry=lambda: {"tick": 1}), STATE={"accepted_hits": []},
        _planning_goal=lambda *_args: {"x": 0, "z": 1, "source": "world_model"},
        _nearest_candidate=lambda *_args: None, _vp_candidates=candidates,
        _vp_explore=lambda *_args: False, _vp_travel=lambda _candidate: "replan",
        _vp_remember=lambda: (object(), {}), _vp_event=Mock(), counted_observe=observe,
    )
    assert ns["_try_enter_range_and_confirm"](object(), []) is None
    observe.assert_not_called()
    assert candidates.call_count == 2
    assert not candidates.call_args_list[1].args[2]


def test_fused_final_point_below_half_metre_is_not_recorded_as_third_hit():
    selection = {"key": "a@40.0", "roadId": "a", "progressCm": 40, "x": 0, "z": 0.4, "path_cm": 20}
    observed = [{"category": "target", "distanceCm": 45, "bearingDeg": 0}]
    candidate = (45, observed[0], object())
    record = Mock(return_value=True)
    event = Mock()
    ns = isolated(
        "_try_enter_range_and_confirm", "_confirm_fail",
        robot=SimpleNamespace(odometry=lambda: {"tick": 1}),
        STATE={"accepted_hits": [{"track_id": "a"}, {"track_id": "a"}]},
        _planning_goal=lambda *_args: {"x": 0, "z": 1, "source": "world_model"},
        _nearest_candidate=Mock(side_effect=[None, candidate]),
        _vp_candidates=Mock(side_effect=[[selection], []]),
        _vp_explore=lambda *_args: False, _vp_travel=lambda _candidate: "arrived",
        _vp_remember=lambda: (object(), {}), _vp_event=event,
        _viewpoint_actual_constraints=lambda *_args: None, _aim_planning_goal=lambda _goal: True,
        _observe_motion=lambda: (True, None, None, None), counted_observe=lambda *_args, **_kwargs: observed,
        _update_wm=Mock(), _wm_distance_m=lambda _pose: 0.499, _record_candidate_sample=record,
    )
    assert ns["_try_enter_range_and_confirm"](object(), []) is None
    record.assert_not_called()
    assert any(call.args[0] == "viewpoint_failed" and call.kwargs.get("reason") == "fused_final_sample_too_close"
               for call in event.call_args_list)
