"""Independent P3 oracle guards: full public paths, truth association, exact timing."""
import copy
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from p3_offline_choice import _all_pairs, _enumerate_routes, evaluate_first_choice


def fixture(selected="b"):
    edges = [{"roadId": "first", "fromNodeId": "s", "toNodeId": "a", "lengthCm": 100},
             {"roadId": "second", "fromNodeId": "a", "toNodeId": "b", "lengthCm": 100},
             {"roadId": "third", "fromNodeId": "b", "toNodeId": "end", "lengthCm": 100}]
    roads = [{"id": "first", "points": [[0, 0], [0, -8]]},
             {"id": "second", "points": [[0, -8], [8, -8]]},
             {"id": "third", "points": [[8, -8], [8, 0]]}]
    odo = {"rightCm": 0, "forwardCm": 0, "headingDeg": 0, "tick": 10, "distanceCm": 0}
    snapshot = {"event": "target_selection", "ball_index": 1, "tick": 10,
                "graph": {"edges": edges}, "road_state": {"onRoad": True, "roadId": "first", "roadProgressCm": 0},
                "odometry": odo, "selection": {"k_cm_per_deg": .1}, "selected_track_id": selected,
                "wm_candidates": [{"obj_id": "a", "x": 1, "z": 0}, {"obj_id": "b", "x": 0, "z": .9}]}
    record = {"simulationDefinition": {"initialPose": {"x": 0, "z": 0, "heading": 0}},
              "interactionDefinition": {"packages": [{"id": "a", "role": "target", "x": 8, "z": 0},
                                                       {"id": "b", "role": "target", "x": 0, "z": -7.2}]},
              "taskDefinition": {"placementGeometry": {"roads": roads}},
              "inputs": [{"type": "navigation_query", "method": "odometry", "tick": 10, "result": copy.deepcopy(odo)},
                         {"type": "navigation_query", "method": "road_state", "tick": 10, "result": copy.deepcopy(snapshot['road_state'])},
                         {"type": "navigation_query", "method": "map_graph", "tick": 0, "result": copy.deepcopy(snapshot['graph'])}]}
    return {"lines": [snapshot]}, record


def test_independent_full_path_oracle_finds_correct_target():
    raw, record = fixture()
    result = evaluate_first_choice(raw, record)
    assert result["evaluated"] and result["match"]
    assert result["optimal_package_ids"] == ["b"]
    assert {item["package_id"]: item["best"]["cost_cm"] for item in result["candidates"]} == {"a": 309.0, "b": 90.0}


def test_suboptimal_choice_is_counted_even_if_it_might_later_be_grabbed():
    raw, record = fixture("a")
    result = evaluate_first_choice(raw, record)
    assert result["evaluated"] and not result["match"]
    assert result["selected_package_id"] == "a"


def test_selection_truth_association_requires_thirty_cm_not_nearest_alone():
    raw, record = fixture()
    raw["lines"][0]["wm_candidates"][1]["x"] = 2
    result = evaluate_first_choice(raw, record)
    assert result["evaluated"] and not result["match"]
    assert result["selected_package_id"] is None
    assert result["reason"] == "selected_track_unmatched_over_30cm"


def test_snapshot_must_match_exact_native_tick_and_odometry():
    raw, record = fixture()
    raw["lines"][0]["odometry"]["forwardCm"] = 5
    result = evaluate_first_choice(raw, record)
    assert not result["evaluated"] and not result["match"]
    assert result["reason"] == "selection_odometry_not_bound_to_exact_native_query"


def test_missing_selection_is_failure_not_removed_from_denominator():
    result = evaluate_first_choice({"lines": []}, {})
    assert not result["evaluated"] and not result["match"]


def test_runtime_road_state_cannot_be_replaced_by_unbound_progress():
    raw, record = fixture()
    raw['lines'][0]['road_state']['roadProgressCm'] = 50
    result = evaluate_first_choice(raw, record)
    assert not result['evaluated'] and result['reason'] == 'selection_road_state_not_bound_to_exact_native_query'


def test_partial_graph_cannot_pose_as_full_public_topology():
    raw, record = fixture()
    raw['lines'][0]['graph']['edges'].pop()
    result = evaluate_first_choice(raw, record)
    assert not result['evaluated'] and result['reason'] == 'selection_graph_not_bound_to_complete_native_query'


def test_units_and_complete_native_road_geometry_are_checked():
    raw, record = fixture()
    record['taskDefinition']['placementGeometry']['roads'][0]['points'][1][1] = -16
    result = evaluate_first_choice(raw, record)
    assert not result['evaluated'] and result['reason'] == 'native_geometry_and_public_length_units_disagree'


def test_directed_partial_edges_require_full_cycle_to_reach_behind():
    edges = {"one": {"roadId": "one", "fromNodeId": "a", "toNodeId": "b", "lengthCm": 100, "oneWay": True},
             "back": {"roadId": "back", "fromNodeId": "b", "toNodeId": "a", "lengthCm": 150, "oneWay": True}}
    options = _enumerate_routes({"roadId": "one", "roadProgressCm": 70},
                                 {"roadId": "one", "progress_cm": 20}, edges, _all_pairs(edges))
    assert min(item["distance_cm"] for item in options) == 200
