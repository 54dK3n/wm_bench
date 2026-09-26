"""Public observation/motion windows reach routing through the real runtime."""
import copy
import json
from types import SimpleNamespace

import pytest

from autonomous_brain import run
from autonomous_brain.navigation import RoadMemory


def frame(z, travelled, tick, *, exits=(), heading=0, on_road=True):
    return {"odometry": {"rightCm": 0, "forwardCm": z, "headingDeg": heading,
                         "distanceCm": travelled, "tick": tick},
            "road": {"onRoad": on_road, "atNode": bool(exits), "atJunction": len(exits) > 1,
                     "exits": [{"angleDeg": a} for a in exits], "headingErrorDeg": -heading,
                     "frontClearanceCm": 100, "leftClearanceCm": 20,
                     "rightClearanceCm": 20, "tick": tick}}


class PublicBridge:
    def __init__(self, initial, movements):
        self.current = initial
        self.movements = list(movements)
        self.frame_index = 0
        self.max_seconds = 1200
        self.log = SimpleNamespace(close=lambda: None)

    @property
    def seconds(self):
        return self.current["odometry"]["tick"] * .02

    def call(self, method, params=None):
        if method == "camera_parameters":
            return {}
        if method == "holding":
            return {"holding": False}
        if method in {"odometry", "local_road"}:
            return copy.deepcopy(self.current["odometry" if method == "odometry" else "road"])
        if method == "observe":
            self.frame_index += 1
            return {"frameId": self.frame_index, "tick": self.current["odometry"]["tick"],
                    "detections": []}
        expected, following, result = self.movements.pop(0)
        assert method == expected
        self.current = copy.deepcopy(following)
        return copy.deepcopy(result)


def runtime(monkeypatch, tmp_path, movements, *, exits=(0,)):
    bridge = PublicBridge(frame(0, 0, 0, exits=exits), movements)
    monkeypatch.setattr(run, "RobotBridge", lambda *args: bridge)
    monkeypatch.setattr(run, "Perception", lambda *args: SimpleNamespace(
        update=lambda *args, **kwargs: {"detections": []}, objects=lambda: [], action_evidence=lambda: []))
    result = run.Runtime({"task": "把两个红球送到绿色存放区"}, tmp_path)
    result.round = 1
    result.observe()
    return result


def records(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_actual_motion_outcome_rejects_collision_before_arrival_acceptance(monkeypatch, tmp_path):
    r = runtime(monkeypatch, tmp_path, [("take_exit", frame(25, 25, 10, exits=(180, 90)),
        {"accepted": True, "stoppedBy": "collision"})])
    r.actions.take_observed_exit(0)
    assert r.roads.nodes[0]["exits"][0]["completed"] is True  # Legacy bookkeeping unchanged.
    assert r.roads.traversal_records() == []
    event = r.snapshot["road_traversal_events"][-1]
    assert event["reason"] == "motion_not_observed_accepted"
    logged = records(tmp_path / "motions.jsonl")
    assert len(logged) == 1 and logged[0]["actuator_result"]["stoppedBy"] == "collision"
    assert (logged[0]["before_observation"], logged[0]["after_observation"]) == (1, 2)


def test_complete_window_survives_round_boundaries_stationary_frames_and_turns(monkeypatch, tmp_path):
    r = runtime(monkeypatch, tmp_path, [
        ("take_exit", frame(25, 25, 10), {"accepted": True, "stoppedBy": "entered_road"}),
        ("turn", frame(25, 25, 11, heading=45), {"completed": True}),
        ("follow_road", frame(65, 65, 30, heading=45, exits=(135, 45)),
         {"accepted": True, "stoppedBy": "junction"})])
    r.actions.take_observed_exit(0)
    r.observe()  # Post-action, same tick.
    r.round = 2
    r.observe()  # Next decision, same tick.
    r.actions.move("turn", {"angleDeg": 45})
    r.observe()  # Intermediate look observation.
    r.actions.move("follow_road", {"distanceCm": 40})
    trips = r.roads.traversal_records()
    assert len(trips) == 1
    trip = trips[0]
    assert [p["observation_index"] for p in trip["observed_path"]] == list(range(1, 8))
    assert trip["travelled_cm"] == 65
    logged = records(tmp_path / "motions.jsonl")
    assert trip["motions"] == [{key: value for key, value in row.items()
                                if key != "motion_verification"} for row in logged]
    assert all("motion_verification" in row for row in logged)
    assert [m["method"] for m in trip["motions"]] == ["take_exit", "turn", "follow_road"]
    assert r.snapshot["road_traversal_events"][-1]["recorded"] is True


def test_short_exit_still_at_origin_is_not_discarded(monkeypatch, tmp_path):
    r = runtime(monkeypatch, tmp_path, [
        ("take_exit", frame(5, 5, 5, exits=(0,)), {"accepted": True}),
        ("follow_road", frame(25, 25, 15, exits=(180, 90)), {"accepted": True})])
    r.actions.take_observed_exit(0)
    assert r.roads.traversal_records() == []
    r.observe()
    r.actions.move("follow_road", {"distanceCm": 20})
    assert len(r.roads.traversal_records()) == 1
    assert r.roads.traversal_records()[0]["travelled_cm"] == 25


@pytest.mark.parametrize("method", ["forward", "backward"])
def test_primitive_completed_field_can_finish_a_valid_window(monkeypatch, tmp_path, method):
    r = runtime(monkeypatch, tmp_path, [
        ("take_exit", frame(20, 20, 10), {"accepted": True}),
        (method, frame(25, 25, 15, exits=(180, 90)), {"completed": True})])
    r.actions.take_observed_exit(0)
    r.actions.move(method, {"distanceCm": 5})
    assert len(r.roads.traversal_records()) == 1


@pytest.mark.parametrize("failure", ["collision", "front_clearance", "off_road", "wrong_way"])
def test_blocked_motion_then_arrival_cannot_reuse_departure(monkeypatch, tmp_path, failure):
    r = runtime(monkeypatch, tmp_path, [
        ("take_exit", frame(20, 20, 10), {"accepted": True, "stoppedBy": failure}),
        ("follow_road", frame(25, 25, 15, exits=(180, 90)), {"accepted": True})])
    r.actions.take_observed_exit(0)
    r.actions.move("follow_road", {"distanceCm": 5})
    assert r.roads.traversal_records() == []


def test_unaccounted_movement_cancels_window(monkeypatch, tmp_path):
    r = runtime(monkeypatch, tmp_path, [
        ("take_exit", frame(20, 20, 10), {"accepted": True}),
        ("follow_road", frame(25, 25, 15, exits=(180, 90)), {"accepted": True})])
    r.actions.take_observed_exit(0)
    r.bridge.current = frame(21, 21, 11)
    r.observe()
    assert r.snapshot["road_traversal_events"][-1]["reason"] == "unaccounted_motion_between_observations"
    r.actions.move("follow_road", {"distanceCm": 4})
    assert r.roads.traversal_records() == []


def test_current_hint_is_compact_and_does_not_clear_unexplored(monkeypatch, tmp_path):
    r = runtime(monkeypatch, tmp_path, [], exits=(0, 90))
    before = copy.deepcopy(r.roads.summary())
    state = r.state()
    hints = state["exploration_hints"]
    assert [h["next_exit_angle_deg"] for h in hints] == [0, 90]
    assert all(h["kind"] == "current_fresh_unexplored" for h in hints)
    assert not any("target_observation_anchor" in h for h in hints)
    assert r.roads.summary() == before and state["unexplored_exit_count"] == 2
    hints[0]["traversal_ids"].append("not real")
    assert r.state()["exploration_hints"][0]["traversal_ids"] == []


def test_legacy_completed_flags_without_motion_windows_cannot_make_routes():
    memory = RoadMemory()
    a, b = frame(0, 0, 0, exits=(0,)), frame(25, 25, 10, exits=(180, 90))
    memory.update(a["odometry"], a["road"], observation_index=1)
    memory.chosen(a["odometry"], 0, observation_index=1)
    memory.update(b["odometry"], b["road"], observation_index=2)
    assert memory.nodes[0]["exits"][0]["completed"] is True
    assert memory.traversal_records() == []
