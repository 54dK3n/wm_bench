"""Sensor-scripted place reobservation, without a scene or model connection.

The bridge applies each requested primitive to public odometry.  A new visual
witness appears only after a full road viewpoint and a turn back to the same
observed green position; changing a frame number alone cannot reveal it.
"""
import copy
import math
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions


def wrap(angle):
    return (angle + 180) % 360 - 180


def reobservation_runtime(*, first="old", later="old", reveal_at=16,
                          green_position=True, road_error=True,
                          road_fault=None, movement_fault=None, green_components=None):
    objects = {
        "held": {"id": "held", "category": "red-ball", "state": "HELD",
                 "position_m": {"x": 0, "z": .18}},
        "old": {"id": "old", "category": "red-ball", "state": "DELIVERED",
                "position_m": {"x": .01, "z": .18}},
        "other": {"id": "other", "category": "red-ball", "state": "CONFIRMED",
                  "position_m": {"x": .04, "z": .18}},
    }
    snapshot = {"observation_index": 1, "observation": {"frameId": 1},
                "odometry": {"rightCm": 0., "forwardCm": 0., "headingDeg": 0., "tick": 0},
                "holding": {"holding": True}, "road": {}, "perception": {"detections": []}}
    motions, logs, marks, unresolved, views = [], [], [], [], []
    state = {"released": False, "retreated": False, "road_cm": 0.,
             "forward_attempts": 0, "off_road": False}
    bridge = SimpleNamespace(seconds=0., max_seconds=1200)

    def visual(mode):
        frame = str(snapshot["observation"]["frameId"])
        zone = {"category": "storage-zone", "track_id": "green", "distance_cm": 18.,
                "bearing_deg": 0., "frame_id": frame,
                "bbox": {"x": 200., "y": 200., "w": 200., "h": 100.}}
        if green_position:
            zone["position_m"] = (copy.deepcopy(green_position) if isinstance(green_position, dict)
                                  else {"x": 0., "z": .18})
        zones = [zone]
        if green_components == "fragments":
            zones.extend({**copy.deepcopy(zone), "track_id": f"fragment-{i}",
                          "bbox": {"x": 420. + i * 5, "y": 310., "w": 2., "h": 1.}}
                         for i in range(9))
        elif green_components == "tied" and state["retreated"]:
            # This fixture tests ambiguous *post-release* aiming. The initial
            # release still has a unique complete region and calibrated aim.
            zones.append({**copy.deepcopy(zone), "track_id": "equal-area-green",
                          "bbox": {"x": 410., "y": 200., "w": 200., "h": 100.}})
        if mode == "empty":
            return zones
        ball = {"category": "red-ball", "track_id": "old" if mode == "old" else "fresh",
                "frame_id": frame, "position_m": {"x": 0., "z": .18},
                "bbox": {"x": 290., "y": 215., "w": 20., "h": 35.}}
        if mode == "old":
            ball["known_delivered_object_id"] = "old"
        if mode == "preexisting":
            ball["track_id"] = "other"
        if mode == "clipped":
            zone["bbox"]["x"] = 0.
        if mode == "outside":
            ball["bbox"]["x"] = 201.
        result = zones + [ball]
        if mode == "two_balls":
            result.append({**copy.deepcopy(ball), "track_id": "fresh-2"})
        if mode == "repeated_ball":
            result.append(copy.deepcopy(ball))
        if mode == "two_zones":
            result.append({**copy.deepcopy(zone), "track_id": "green-2"})
        if state["road_cm"] > 0 and mode not in {"old", "unmatched_only"}:
            # The old ball remains separately visible. A sole unmatched blob
            # cannot establish that changing view revealed an additional ball.
            result.append({**copy.deepcopy(ball), "track_id": "old",
                           "known_delivered_object_id": "old",
                           "bbox": {"x": 230., "y": 215., "w": 20., "h": 25.},
                           "position_m": {"x": .01, "z": .18}})
        return result

    def refresh():
        odo = snapshot["odometry"]
        on_road = not state["off_road"]
        if road_fault == "return_blocked" and state["retreated"]:
            on_road = False
        front = 0. if road_fault == "return_blocked" and state["retreated"] else 100.
        if road_fault == "front_blocked" and state["retreated"]:
            front = 0.
        if road_fault == "front_after_step" and state["forward_attempts"]:
            front = 0.
        snapshot["road"] = {"onRoad": on_road, "atNode": False, "exits": [],
                            "headingErrorDeg": wrap(30 - odo["headingDeg"]) if road_error else None,
                            "frontClearanceCm": front, "leftClearanceCm": 100.,
                            "rightClearanceCm": 100.}
        if road_fault == "ambiguous_junction" and state["retreated"]:
            snapshot["road"].update(atNode=True, exits=[
                {"angleDeg": wrap(28 - odo["headingDeg"])},
                {"angleDeg": wrap(32 - odo["headingDeg"])},
            ])
        if road_fault == "exit_disappears" and state["retreated"]:
            snapshot["road"].update(atNode=True, exits=(
                [] if abs(wrap(odo["headingDeg"] - 30)) < 1
                else [{"angleDeg": wrap(30 - odo["headingDeg"])}]))
        mode = "empty" if not state["retreated"] else first
        dx, dz = -odo["rightCm"], 18 - odo["forwardCm"]
        green_heading = math.degrees(math.atan2(-dx, dz))
        if (state["retreated"] and state["road_cm"] >= reveal_at - 1e-6
                and abs(wrap(green_heading - odo["headingDeg"])) <= 1):
            mode = later
            views.append({"frame": snapshot["observation"]["frameId"],
                          "mode": mode, "road_cm": state["road_cm"]})
        snapshot["perception"]["detections"] = visual(mode)
        if mode in {"new", "unmatched_only", "two_balls", "repeated_ball", "two_zones", "clipped", "outside"}:
            # This identity was not known before release; a later objects()
            # query must not retroactively put it into the release boundary.
            objects.setdefault("fresh", {"id": "fresh", "category": "red-ball",
                                         "state": "TENTATIVE", "position_m": {"x": 0, "z": .18}})

    def observe():
        snapshot["observation_index"] += 1
        snapshot["observation"]["frameId"] += 1
        snapshot["odometry"]["tick"] += 1
        bridge.seconds += .1
        refresh()

    def call(method, params):
        assert method in {"release", "backward", "forward", "turn"}, method
        row = {"method": method, "params": dict(params),
               "before_frame": snapshot["observation"]["frameId"],
               "before": copy.deepcopy(snapshot["odometry"]),
               "supplementary": state["retreated"]}
        motions.append(row)
        odo = snapshot["odometry"]
        if method == "release":
            assert not state["released"], "a reobservation must never release twice"
            state["released"] = True
            snapshot["holding"]["holding"] = False
        elif method == "turn":
            odo["headingDeg"] = wrap(odo["headingDeg"] + params["angleDeg"])
        else:
            amount = params["distanceCm"]
            if method == "forward" and state["retreated"]:
                state["forward_attempts"] += 1
                if movement_fault == "stationary":
                    amount = 0.
                elif movement_fault == "overshoot":
                    amount += 1.
                elif movement_fault == "lateral":
                    odo["rightCm"] += 1.
                state["road_cm"] += amount
                if road_fault == "off_road":
                    state["off_road"] = True
            signed = amount if method == "forward" else -amount
            theta = math.radians(odo["headingDeg"])
            odo["rightCm"] -= math.sin(theta) * signed
            odo["forwardCm"] += math.cos(theta) * signed
            if method == "backward" and not state["retreated"]:
                assert amount == 25
                state["retreated"] = True
            elif method == "backward" and state["off_road"]:
                state["off_road"] = False
        row["after"] = copy.deepcopy(odo)
        return {"accepted": True, "completed": True}

    def mark_delivered(oid, *, holding, ball_in_storage, evidence, **kwargs):
        marks.append(copy.deepcopy(evidence))
        if holding or not ball_in_storage:
            return False
        assert evidence["placement"]["frame_id"] == snapshot["observation"]["frameId"]
        assert evidence["post_observation"] == snapshot["observation_index"]
        objects[oid]["state"] = "DELIVERED"
        return True

    def mark_unverified(oid, *, evidence, **kwargs):
        unresolved.append(copy.deepcopy(evidence))
        objects[oid]["state"] = "RELEASED_UNVERIFIED"

    bridge.call = call
    runtime = SimpleNamespace(snapshot=snapshot, round=1, pending_grasp=None, held_object_id="held",
        bridge=bridge, observe=observe, motion_log=SimpleNamespace(write=logs.append),
        perception=SimpleNamespace(objects=lambda: copy.deepcopy(list(objects.values())),
            get_object=lambda oid: copy.deepcopy(objects[oid]), mark_delivered=mark_delivered,
            mark_release_unverified=mark_unverified,
            ground_camera=SimpleNamespace(project_pixel_to_ground=lambda u, v: (0., .18))))
    refresh()
    return SimpleNamespace(runtime=runtime, motions=motions, logs=logs, marks=marks,
                           unresolved=unresolved, objects=objects, views=views, state=state)


def supplementary_forwards(fixture):
    return [m for m in fixture.motions if m["supplementary"] and m["method"] == "forward"]


def assert_original_release(fixture):
    expected = {"frame_id": 2, "simulation_time_s": .1,
                "preexisting_ball_ids": ["old", "other"]}
    assert fixture.marks or fixture.unresolved
    for evidence in fixture.marks + fixture.unresolved:
        assert evidence["release_observation"] == expected
    assert sum(m["method"] == "release" for m in fixture.motions) == 1
    assert fixture.objects["old"]["state"] == "DELIVERED"
    assert fixture.objects["other"]["state"] == "CONFIRMED"


def test_initial_unique_witness_needs_no_supplementary_motion():
    f = reobservation_runtime(first="new")
    result = Actions(f.runtime).place()
    assert result["success"] is True
    assert [m["method"] for m in f.motions] == ["release", "backward"]
    assert result["evidence"]["post_observation"] == 3
    assert result["evidence"]["placement"]["frame_id"] == 3
    assert_original_release(f)


@pytest.mark.parametrize("reveal_at", [16, 32])
def test_new_unique_ball_from_later_road_view_keeps_original_release(reveal_at):
    f = reobservation_runtime(later="new", reveal_at=reveal_at)
    result = Actions(f.runtime).place()
    assert result["success"] is True
    assert f.objects["held"]["state"] == "DELIVERED"
    assert f.runtime.held_object_id is None
    placement = result["evidence"]["placement"]
    assert placement["ball_track_id"] == "fresh"
    assert placement["frame_id"] > 3
    assert placement["frame_id"] in [view["frame"] for view in f.views if view["mode"] == "new"]
    moves = supplementary_forwards(f)
    assert len(moves) == reveal_at // 4
    assert sum(m["params"]["distanceCm"] for m in moves) == pytest.approx(reveal_at)
    assert all(0 < m["params"]["distanceCm"] <= 4 for m in moves)
    assert all(abs(wrap(m["before"]["headingDeg"] - 30)) < 1 for m in moves)
    assert not f.unresolved
    assert_original_release(f)


def test_old_ball_only_exhausts_two_road_views_without_claiming_delivery():
    f = reobservation_runtime()
    result = Actions(f.runtime).place()
    assert result["success"] is False
    assert f.objects["held"]["state"] == "RELEASED_UNVERIFIED"
    moves = supplementary_forwards(f)
    assert len(moves) == 8
    assert all(0 < m["params"]["distanceCm"] <= 4 for m in moves)
    assert sum(m["params"]["distanceCm"] for m in moves) == pytest.approx(32)
    assert len({round(v["road_cm"], 6) for v in f.views}) == 2
    assert all(e.get("placement") is None for e in f.marks + f.unresolved)
    assert_original_release(f)


def test_one_unmatched_blob_without_old_ball_reobservation_does_not_prove_another_ball():
    f = reobservation_runtime(later="unmatched_only")
    result = Actions(f.runtime).place()
    assert f.views
    assert result["success"] is False
    assert f.objects["held"]["state"] == "RELEASED_UNVERIFIED"
    assert result["evidence"]["candidate_witnesses"] == 1
    assert result["evidence"]["reobservation"]["required_delivered_ids"] == ["old"]
    assert result["evidence"]["reobservation"]["old_objects_reobserved"] is False
    assert sum(m["params"]["distanceCm"] for m in supplementary_forwards(f)) == pytest.approx(32)
    assert_original_release(f)


def test_disconnected_green_fragments_allow_unique_largest_component_for_aiming():
    f = reobservation_runtime(later="new", green_components="fragments")
    result = Actions(f.runtime).place()
    assert result["success"] is True
    assert result["evidence"]["reobservation"]["aiming_region"]["track_id"] == "green"
    assert result["evidence"]["candidate_witnesses"] == 1
    assert len(supplementary_forwards(f)) == 4
    assert_original_release(f)


def test_equal_largest_green_components_do_not_choose_an_arbitrary_aim():
    f = reobservation_runtime(later="new", green_components="tied")
    result = Actions(f.runtime).place()
    assert result["success"] is False
    assert supplementary_forwards(f) == []
    assert result["evidence"]["reobservation"]["aiming_region"] is None
    assert_original_release(f)


@pytest.mark.parametrize("later", ["preexisting", "clipped", "outside", "two_balls", "repeated_ball", "two_zones"])
def test_illegal_or_nonunique_later_witness_never_delivers(later):
    f = reobservation_runtime(later=later)
    result = Actions(f.runtime).place()
    assert f.views, "the invalid view must actually be observed"
    assert result["success"] is False
    assert f.objects["held"]["state"] == "RELEASED_UNVERIFIED"
    assert sum(m["params"]["distanceCm"] for m in supplementary_forwards(f)) <= 32
    assert all(e.get("placement") is None for e in f.marks + f.unresolved)
    assert_original_release(f)


@pytest.mark.parametrize("first", ["empty", "preexisting", "two_balls"])
def test_retry_trigger_requires_nonempty_exclusively_known_delivered_detections(first):
    f = reobservation_runtime(first=first, later="new")
    result = Actions(f.runtime).place()
    assert result["success"] is False
    assert supplementary_forwards(f) == []
    assert [m["method"] for m in f.motions] == ["release", "backward"]


@pytest.mark.parametrize("kwargs", [
    {"green_position": False}, {"road_error": False},
    {"green_position": {"x": math.nan, "z": .18}},
    {"green_position": {"x": 0, "z": math.inf}},
    {"green_position": {"x": False, "z": .18}},
    {"road_fault": "return_blocked"}, {"road_fault": "front_blocked"},
    {"road_fault": "ambiguous_junction"},
])
def test_missing_road_or_green_evidence_never_drives_to_invent_a_view(kwargs):
    f = reobservation_runtime(later="new", **kwargs)
    result = Actions(f.runtime).place()
    assert result["success"] is False
    assert supplementary_forwards(f) == []
    assert f.objects["held"]["state"] == "RELEASED_UNVERIFIED"
    assert_original_release(f)


@pytest.mark.parametrize("road_fault", ["front_after_step", "off_road"])
def test_each_road_step_observes_again_and_stops_at_new_hazard(road_fault):
    f = reobservation_runtime(later="new", road_fault=road_fault)
    result = Actions(f.runtime).place()
    assert result["success"] is False
    assert len(supplementary_forwards(f)) == 1
    assert not f.views
    assert f.objects["held"]["state"] == "RELEASED_UNVERIFIED"
    assert_original_release(f)


def test_exit_that_disappears_after_alignment_cannot_authorize_forward_motion():
    f = reobservation_runtime(later="new", road_fault="exit_disappears")
    result = Actions(f.runtime).place()
    assert result["success"] is False
    assert [m["method"] for m in f.motions] == ["release", "backward", "turn"]
    assert supplementary_forwards(f) == []
    assert f.objects["held"]["state"] == "RELEASED_UNVERIFIED"
    assert_original_release(f)


@pytest.mark.parametrize("movement_fault", ["stationary", "overshoot", "lateral"])
def test_actuator_completed_cannot_override_inconsistent_measured_motion(movement_fault):
    f = reobservation_runtime(later="new", movement_fault=movement_fault)
    result = Actions(f.runtime).place()
    assert result["success"] is False
    assert len(supplementary_forwards(f)) == 1
    assert not f.views
    assert f.objects["held"]["state"] == "RELEASED_UNVERIFIED"
    assert_original_release(f)
