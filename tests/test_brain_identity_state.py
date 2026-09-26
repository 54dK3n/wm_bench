"""Current sensor identity uncertainty must reach the next model decision."""
import copy
from types import SimpleNamespace

from autonomous_brain.run import Runtime, compact_junction_history
from autonomous_brain.task import parse_task


def state_runtime(row):
    runtime = Runtime.__new__(Runtime)
    runtime.config = {"task": "把两个红球送到绿色存放区"}
    runtime.task_spec = parse_task(runtime.config["task"])
    runtime.round, runtime.recent = 1, []
    runtime.held_object_id = runtime.pending_grasp = None
    runtime.bridge = SimpleNamespace(seconds=0)
    runtime.perception = SimpleNamespace(objects=lambda: [row], action_evidence=lambda: [])
    runtime.roads = SimpleNamespace(nodes=[], unexplored=lambda: 0,
        summary=lambda: [], exits=lambda *args: [], frontier_hints=lambda *args, **kwargs: [])
    runtime.snapshot = {"observation_index": 1,
        "odometry": {"rightCm": 0, "forwardCm": 0, "headingDeg": 0},
        "holding": {"holding": False},
        "road": {"onRoad": True, "atJunction": False, "exits": [], "frontClearanceCm": 30}}
    return runtime


def test_identity_competition_reaches_model_without_unapproved_or_unbounded_data():
    row = {"id": "red-current", "category": "red-ball", "state": "CONFIRMED",
        "position_m": {"x": 0, "z": .3}, "confidence": .9,
        "distance_cm": 30, "bearing_deg": 0, "hit_count": 3,
        "identity_ambiguity": {"frame_id": 4, "reason": "competing_identities",
            "candidate_ids": ["red-current", "red-old"],
            "candidate_kinds": {"red-current": "active", "red-old": "delivered"},
            "private_truth": "must-not-cross", "image": "must-not-cross"}}
    original = copy.deepcopy(row)
    result = state_runtime(row).state()["objects"][0]
    assert result["identity_status"] == "ambiguous"
    assert result["identity_ambiguity"] == {
        "frame_id": 4, "reason": "competing_identities", "candidate_count": 2,
        "candidate_ids": ["red-current", "red-old"],
        "candidate_kinds": {"red-current": "active", "red-old": "delivered"}}
    result["identity_ambiguity"]["candidate_ids"].clear()
    assert row == original


def test_fresh_resolution_is_not_permanently_masked_by_prior_state():
    row = {"id": "red-current", "category": "red-ball", "state": "CONFIRMED",
        "position_m": {"x": 0, "z": .3}, "confidence": .9,
        "distance_cm": 30, "bearing_deg": 0, "hit_count": 3,
        "identity_ambiguity": {"frame_id": 4, "candidate_ids": ["old", "new"]}}
    runtime = state_runtime(row)
    before = runtime.state()
    row.pop("identity_ambiguity")
    after = runtime.state()
    assert before["objects"][0]["identity_status"] == "ambiguous"
    assert "identity_status" not in after["objects"][0]
    assert before["objects"][0]["identity_ambiguity"]["candidate_ids"] == ["new", "old"]


def test_model_keeps_every_node_and_pending_state_without_copying_anchor_history():
    rows = [{"id": "junction-1", "status": "unresolved", "position_m": {"x": 0, "z": 0},
             "exits": [{"id": "exit-1", "heading_deg": 90, "state": "blocked", "visits": 2,
                        "completed": False, "blocked": True, "observation_refs": list(range(500)),
                        "completion_traversal_ids": [], "private_map_data": "omit"}]}]
    original = copy.deepcopy(rows)
    result = compact_junction_history(rows)
    exit = result[0]["exits"][0]
    assert result[0]["status"] == "unresolved" and exit["state"] == "blocked"
    assert exit["observation_count"] == 500 and exit["verified_traversal_count"] == 0
    assert "observation_refs" not in exit and "private_map_data" not in exit
    exit["state"] = "verified"
    assert rows == original
