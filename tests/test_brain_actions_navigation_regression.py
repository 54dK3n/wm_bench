"""Action regressions using only explicit fake observations and odometry.

No simulator, platform data, model request or active-run evidence is used.
These tests intentionally expose defects in the frozen action implementation.
"""

import copy
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions


class FakePerception:
    def __init__(self, objects):
        self.rows = {row["id"]: copy.deepcopy(row) for row in objects}
        self.delivered = []

    def objects(self):
        return list(self.rows.values())

    def get_object(self, object_id):
        return self.rows.get(object_id)

    def confirmed(self, object_id):
        row = self.get_object(object_id)
        return row if row is not None and row["state"] == "CONFIRMED" else None

    def visible(self, object_id):
        return None

    def mark_delivered(self, object_id, *, holding, ball_in_storage, **kwargs):
        if holding or not ball_in_storage or self.rows[object_id]["state"] != "HELD":
            return False
        self.rows[object_id]["state"] = "DELIVERED"
        self.delivered.append(object_id)
        return True

    def mark_release_unverified(self, object_id, **kwargs):
        self.rows[object_id]["state"] = "RELEASED_UNVERIFIED"
        return True


def fake_runtime(objects, *, on_road=True, at_node=False, exits=(), route=(),
                 holding=False, detections=(), actuator=None):
    snapshot = {
        "observation_index": 1, "observation": {"frameId": 1},
        "odometry": {"tick": 0, "rightCm": 0, "forwardCm": 0, "headingDeg": 0},
        "road": {"onRoad": on_road, "atNode": at_node,
                 "headingErrorDeg": 0, "leftClearanceCm": 20, "rightClearanceCm": 20,
                 "exits": [{"angleDeg": value} for value in exits], "frontClearanceCm": 100},
        "holding": {"holding": holding},
        "perception": {"detections": copy.deepcopy(list(detections))},
    }
    motions, selected_exits, motion_log = [], [], []
    runtime = SimpleNamespace(
        snapshot=snapshot, round=1, perception=FakePerception(objects),
        pending_grasp=None, held_object_id=objects[0]["id"] if holding else None,
        bridge=SimpleNamespace(seconds=0, max_seconds=1200),
        roads=SimpleNamespace(route_to=lambda odo, target: list(route),
                              chosen=lambda odo, angle: selected_exits.append(angle)),
        motion_log=SimpleNamespace(write=motion_log.append),
    )

    def observe():
        snapshot["observation_index"] += 1
        snapshot["observation"]["frameId"] += 1
        snapshot["odometry"]["tick"] += 1

    def call(method, params):
        motions.append((method, copy.deepcopy(params)))
        return actuator(runtime, method, params) if actuator else {
            "accepted": True, "distanceCm": 0, "stoppedBy": "front_clearance"}

    runtime.observe, runtime.bridge.call = observe, call
    runtime.motions, runtime.selected_exits = motions, selected_exits
    return runtime


def target(x=0, z=.20, *, object_id="red-1", state="CONFIRMED"):
    return {"id": object_id, "category": "red-ball", "state": state,
            "position_m": {"x": x, "z": z}}


def test_go_to_takes_exit_to_next_recorded_waypoint_before_later_bend():
    # The observed route first goes right, then bends forward. A straight
    # exit also exists, but no recorded route connects that exit to the goal.
    runtime = fake_runtime([target(.2, 1)], at_node=True, exits=(-90, 0),
                           route=((0, 0), (.2, 0), (.2, .4), (.2, .8)))
    Actions(runtime).go_to("red-1")
    # The fake actuator stops at the first selected exit, keeping this test
    # about route selection rather than simulating an entire road traversal.
    assert runtime.motions == [("take_exit", {"angleDeg": -90, "speed": 50})]
    assert runtime.selected_exits == [-90]


def test_go_to_does_not_reverse_when_current_sensor_reports_off_road():
    runtime = fake_runtime([target()], on_road=False)
    result = Actions(runtime).go_to("red-1")
    assert result["success"] is False
    assert runtime.motions == [], "An off-road observation must prevent a standoff reverse command"


def test_go_to_stops_after_standoff_reverse_is_blocked():
    runtime = fake_runtime([target()])
    result = Actions(runtime).go_to("red-1")
    assert result["success"] is False
    assert runtime.motions == [("backward", {"distanceCm": 10, "speed": 30})], (
        "A blocked reverse must return to the decision loop instead of repeating the same motion")


@pytest.mark.parametrize("witness_preexisted", [True, False], ids=["other-known-ball", "new-post-release-track"])
def test_place_cannot_use_another_preexisting_ball_as_its_delivery_witness(witness_preexisted):
    zone = {"category": "storage-zone", "distance_cm": 18, "bearing_deg": 0,
            "bbox": {"x": 100, "y": 200, "w": 100, "h": 60}}
    other = target(0, .8, object_id="red-2")
    witness = {"category": "red-ball", "track_id": "red-2", "position_m": {"x": 0, "z": .8},
               "bbox": {"x": 145, "y": 210, "w": 10, "h": 20}}
    objects = [target(state="HELD")]
    if witness_preexisted:
        objects.append(other)

    def actuator(runtime, method, params):
        assert method in {"release", "backward"}
        if method == "release":
            runtime.snapshot["holding"]["holding"] = False
            runtime.snapshot["perception"]["detections"] = [zone, witness]
            runtime.perception.rows[other["id"]] = copy.deepcopy(other)
        return {"accepted": True, "completed": True}

    runtime = fake_runtime(objects, holding=True,
                           detections=[zone, witness] if witness_preexisted else [zone],
                           actuator=actuator)
    result = Actions(runtime).place()
    assert runtime.motions == [("release", {}), ("backward", {"distanceCm": 25, "speed": 30})]
    if witness_preexisted:
        assert result["success"] is False, "The only in-zone ball was already present before release"
        assert runtime.perception.delivered == []
        assert runtime.perception.rows["red-1"]["state"] != "DELIVERED"
    else:
        # A released object's new track ID remains valid evidence; simply
        # requiring equality with the removed held ID would reject this case.
        assert result["success"] is True
        assert runtime.perception.delivered == ["red-1"]
