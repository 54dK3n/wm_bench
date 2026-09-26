"""Observed synthetic roads only; no layout or evaluator truth is imported."""
import copy
from types import SimpleNamespace

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import RoadMemory, distance, heading_to, position, wrap
from test_brain_visual_standoff import visual_runtime


def sensor(index, p, *, heading=0, travelled=0, on_road=True):
    return {"observation_index": index,
            "observation": {"frameId": str(index), "tick": index},
            "odometry": {"rightCm": p[0] * 100, "forwardCm": p[1] * 100,
                         "headingDeg": heading, "distanceCm": travelled, "tick": index},
            "road": {"onRoad": on_road, "atNode": False, "exits": [],
                     "headingErrorDeg": 0, "frontClearanceCm": 100,
                     "leftClearanceCm": 20, "rightClearanceCm": 20},
            "holding": {"holding": False}, "perception": {"detections": []}}


def register(roads, row, previous=None, *, method="follow_road", accepted=True):
    roads.update(row["odometry"], row["road"], observation_index=row["observation_index"])
    motion = None if previous is None else {
        "before_observation": previous["observation_index"], "after_observation": row["observation_index"],
        "method": method, "params": {"distanceCm": 30},
        "actuator_result": {"accepted": accepted, "completed": accepted}}
    roads.observe_traversal(row, motion)


def test_only_actual_observed_segments_connect_approach_candidates():
    roads = RoadMemory()
    a, b, c = sensor(1, (.3, .3)), sensor(2, (0, .3), travelled=30), sensor(3, (0, 0), travelled=60)
    register(roads, a)
    register(roads, b, a)
    register(roads, c, b)
    candidate = roads.approach_candidates(c["odometry"], (.5, 0))[0]
    assert candidate["path"] == [[0, 0], [0, .3], [.3, .3]]
    assert candidate["source"] == "observed_on_road_motion_endpoints"
    assert len(candidate["segments"]) == 2
    assert roads.approach_candidates(dict(c["odometry"], rightCm=1), (.5, 0)) == []
    assert len(roads.approach_candidates(c["odometry"], (.5, 0), limit=100)) <= 3


def test_stationary_completed_and_unaccounted_motion_do_not_create_connections():
    roads = RoadMemory()
    a, b = sensor(1, (0, 0)), sensor(2, (0, 0), travelled=0)
    register(roads, a)
    register(roads, b, a)
    c = sensor(3, (.3, .3), travelled=50)
    register(roads, c)  # Pose changed without a recorded motion.
    assert roads.approach_candidates(c["odometry"], (0, .3)) == []
    d = sensor(4, (.3, 0), travelled=50)  # Actuator claims travel, odometer disagrees.
    register(roads, d, c)
    assert roads.approach_candidates(d["odometry"], (.3, .4)) == []


def test_off_road_gap_does_not_connect_nearby_branches():
    roads = RoadMemory()
    a = sensor(1, (0, 0))
    b = sensor(2, (0, .3), travelled=30, on_road=False)
    c = sensor(3, (.01, 0), travelled=61)
    register(roads, a)
    register(roads, b, a)
    register(roads, c, b)
    assert roads.approach_candidates(c["odometry"], (0, .4)) == []


def test_quantized_short_visual_step_keeps_its_actual_connection():
    # Public Run22 odometry from the final 0.17284 cm command rounds each axis
    # to 0.1 cm. The displacement bearing differs by 12 degrees, while its
    # along/across residuals stay inside the existing 0.2 cm motion tolerance.
    roads = RoadMemory()
    start = sensor(1, (.139, 1.921), heading=129, travelled=4700)
    before = sensor(2, (-.038, 1.777), heading=129, travelled=4735.8)
    after = sensor(3, (-.04, 1.776), heading=129, travelled=4736)
    register(roads, start)
    register(roads, before, start)
    roads.update(after["odometry"], after["road"], after["observation_index"])
    roads.observe_traversal(after, {"before_observation": 2, "after_observation": 3,
        "method": "forward", "params": {"distanceCm": .1728400468565192},
        "actuator_result": {"completed": True}})
    candidates = roads.approach_candidates(after["odometry"], (-.2, 1.8))
    assert len(candidates) == 1
    assert candidates[0]["path"] == [[-.04, 1.776], [-.038, 1.777], [.139, 1.921]]
    assert candidates[0]["segments"][0]["before_observation"] == 2


def reposition_runtime(*, route=True, no_motion=False):
    roads = RoadMemory()
    prior = [sensor(1, (.3, .3), heading=90), sensor(2, (0, .3), heading=90, travelled=30),
             sensor(3, (0, 0), heading=-180, travelled=60),
             sensor(4, (0, 0), heading=-90, travelled=60)]
    # Public anchor headings describe the actual west-then-south traversal.
    # The final stationary look east is not part of its arrival direction.
    prior[0]["road"].update(atNode=True, exits=[{"angleDeg": 0}])
    prior[1]["road"].update(atNode=True, headingErrorDeg=90,
                          exits=[{"angleDeg": -180}, {"angleDeg": 90}])
    prior[2]["road"].update(atNode=True, exits=[{"angleDeg": -180}])
    prior[3]["road"].update(atNode=True, headingErrorDeg=90, exits=[{"angleDeg": 90}])
    for i, row in enumerate(prior):
        register(roads, row, prior[i - 1] if route and 0 < i < 3 else None)
    current = prior[-1]
    target = {"id": "red", "category": "red-ball", "state": "CONFIRMED",
              "position_m": {"x": .5, "z": 0}}
    camera = {}
    moves = []
    runtime = SimpleNamespace(snapshot=current, round=1, roads=roads,
        perception=SimpleNamespace(confirmed=lambda oid: target if oid == "red" else None,
                                   get_object=lambda oid: target if oid == "red" else None,
                                   objects=lambda: [target], visible=lambda oid: camera),
        bridge=SimpleNamespace(seconds=0, max_seconds=1200),
        motion_log=SimpleNamespace(write=lambda row: None))

    def refresh():
        odo = current["odometry"]
        p, heading = position(odo), odo["headingDeg"]
        neighbours = {(0, 0): [(0, .3)], (0, .3): [(0, 0), (.3, .3)], (.3, .3): [(0, .3)]}
        tangent = 0 if p == (0, 0) else -90
        current["road"].update(atNode=True, headingErrorDeg=wrap(tangent - heading),
            exits=[{"angleDeg": wrap(heading_to(p, q) - heading)} for q in neighbours[p]],
            rightClearanceCm=.1 if p == (0, 0) else 20)
        camera.update(category="red-ball", track_id="red", frame_id=current["observation"]["frameId"],
            distance_cm=distance(p, (.5, 0)) * 100,
            bearing_deg=-wrap(heading_to(p, (.5, 0)) - heading))
        current["perception"]["detections"] = [camera]

    def call(method, params):
        moves.append((method, copy.deepcopy(params)))
        odo = current["odometry"]
        if method == "turn":
            odo["headingDeg"] = wrap(odo["headingDeg"] + params["angleDeg"])
        elif method == "take_exit":
            if not no_motion:
                p = position(odo)
                q = (0, .3) if p == (0, 0) else (.3, .3)
                odo.update(rightCm=q[0] * 100, forwardCm=q[1] * 100,
                           distanceCm=odo["distanceCm"] + distance(p, q) * 100)
        else:
            raise AssertionError("A blocked direct approach must use the recorded L-shaped road")
        return {"accepted": True, "completed": True}

    def observe(*, motion=None):
        current["observation_index"] += 1
        current["odometry"]["tick"] += 1
        current["observation"] = {"frameId": str(current["observation_index"]),
                                  "tick": current["odometry"]["tick"]}
        refresh()
        roads.update(current["odometry"], current["road"], current["observation_index"])
        roads.observe_traversal(current, dict(motion, after_observation=current["observation_index"])
                                if motion is not None else None)

    runtime.observe, runtime.bridge.call = observe, call
    refresh()
    return runtime, moves


def test_blocked_direct_approach_repositions_on_recorded_road_then_observes_success():
    runtime, moves = reposition_runtime()
    outcome = Actions(runtime).execute({"action": "go_to", "params": {"object_id": "red"}})
    assert outcome["success"]
    assert [m for m, _ in moves].count("take_exit") == 2
    assert "forward" not in [m for m, _ in moves]
    evidence = outcome["evidence"]["road_reposition"]
    assert evidence["status"] == "reposition_and_visual_standoff_verified"
    assert all(step["direction"] == "reverse_attempt"
               and step["reverse_execution"] == "endpoint_and_heading_observed"
               and step["historical_arc_retraced"]
               for step in evidence["attempts"][0]["steps"])
    assert evidence["attempts"][0]["approach_observation"] > evidence["attempts"][0]["steps"][-1]["after_observation"]
    assert outcome["evidence"]["navigation_subgoal"]["operation_ready"]
    assert runtime.perception.get_object("red")["position_m"] == {"x": .5, "z": 0}


def test_no_observed_route_reports_need_to_explore_and_does_not_invent_an_edge():
    runtime, moves = reposition_runtime(route=False)
    outcome = Actions(runtime).go_to("red")
    assert not outcome["success"] and not moves
    assert outcome["evidence"]["road_reposition"]["status"] == "no_verified_route_needs_exploration"
    assert "explore_observed_exits" in outcome["evidence"]["recovery_options"]


def test_reposition_actuator_completed_without_displacement_is_not_success():
    runtime, moves = reposition_runtime(no_motion=True)
    outcome = Actions(runtime).go_to("red")
    assert not outcome["success"]
    assert [m for m, _ in moves].count("take_exit") == 1
    assert outcome["evidence"]["road_reposition"]["status"] == "reposition_motion_not_verified"


def test_repeated_failure_is_rejected_across_rounds_and_new_frame_ids():
    runtime, moves, _ = visual_runtime(45, blocked=True)
    first = Actions(runtime).execute({"action": "go_to", "params": {"object_id": "zone"}})
    assert not first["success"] and len(moves) == 1
    for _ in range(3):
        runtime.round += 1
        runtime.observe()
        outcome = Actions(runtime).execute({"action": "go_to", "params": {"object_id": "zone"}})
        assert outcome["reason"] == "navigation_repeat_without_new_evidence"
        assert outcome["evidence"]["previous_failure"] == "basic_motion_not_verified"
    assert len(moves) == 1
    assert Actions(runtime).navigation_state()[0]["repeat_blocked"]


def test_new_material_road_evidence_permits_retry_but_frame_churn_does_not():
    runtime, moves, _ = visual_runtime(45, blocked=True)
    actions = Actions(runtime)
    action = {"action": "go_to", "params": {"object_id": "zone"}}
    actions.execute(action)
    runtime.snapshot["road"]["frontClearanceCm"] += 5
    outcome = actions.execute(action)
    assert outcome["reason"] == "basic_motion_not_verified"
    assert len(moves) == 2


def test_achieved_standoff_persists_and_current_readiness_keeps_camera_separate_from_memory():
    runtime, moves, camera = visual_runtime(32, 2)
    actions = Actions(runtime)
    assert actions.go_to("zone")["success"]
    runtime.observe()
    outcome = actions.go_to("zone")
    assert outcome["reason"] == "navigation_subgoal_already_satisfied" and not moves
    row = actions.navigation_state()[0]
    assert row["current_subgoal"]["operation"] == "place"
    assert row["current_subgoal"]["operation_ready"]
    assert row["current_subgoal"]["memory_source"] == "world_model_geometric_history"
    camera["distance_cm"] = 50
    assert not actions.navigation_state()[0]["current_subgoal"]["standoff_ready"]
    assert actions.navigation_state()[0]["last_achieved_subgoal"]["standoff_ready"]


def test_pick_repeat_is_rejected_but_still_observes_after_rejection():
    runtime, _, _ = visual_runtime(32)
    runtime.snapshot["holding"]["holding"] = False
    actions, calls = Actions(runtime), []
    def fail_pick(object_id):
        calls.append(object_id)
        return actions.result(False, "pick_observed_blocked")
    actions.pick = fail_pick
    action = {"action": "pick", "params": {"object_id": "zone"}}
    assert actions.execute(action)["reason"] == "pick_observed_blocked"
    before = runtime.snapshot["observation_index"]
    rejected = actions.execute(action)
    assert rejected["reason"] == "action_repeat_without_new_evidence"
    assert runtime.snapshot["observation_index"] > before and calls == ["zone"]
    runtime.snapshot["odometry"]["forwardCm"] += 3
    assert actions.execute(action)["reason"] == "pick_observed_blocked"
    assert calls == ["zone", "zone"]


def test_unverified_release_guard_uses_new_ball_and_region_pixels_not_old_track_visibility():
    runtime, _, camera = visual_runtime(32)
    target = {"id": "released", "category": "red-ball", "state": "RELEASED_UNVERIFIED",
              "position_m": {"x": 0, "z": .32}}
    runtime.held_object_id = runtime.pending_grasp = None
    runtime.snapshot["holding"]["holding"] = False
    runtime.perception = SimpleNamespace(objects=lambda: [target],
        confirmed=lambda oid: None, get_object=lambda oid: target if oid == "released" else None,
        visible=lambda oid: None)
    # No current view of the historical held identity is required. A new post-
    # release candidate and region geometry are relevant recovery evidence.
    camera.update(track_id="zone", bbox={"x": 100, "y": 100, "w": 80, "h": 60})
    actions, calls = Actions(runtime), []
    def fail_place():
        calls.append("place")
        return actions.result(False, "released_ball_not_verified_in_storage")
    actions.place = fail_place
    action = {"action": "place", "params": {}}
    actions.execute(action)
    assert actions.execute(action)["reason"] == "action_repeat_without_new_evidence"
    runtime.snapshot["perception"]["detections"].append({
        "category": "red-ball", "track_id": "fresh-candidate", "distance_cm": 32,
        "bearing_deg": 0, "bbox": {"x": 130, "y": 115, "w": 8, "h": 8}})
    assert actions.execute(action)["reason"] == "released_ball_not_verified_in_storage"
    assert len(calls) == 2
    assert actions.execute(action)["reason"] == "action_repeat_without_new_evidence"
    camera["bbox"]["w"] += 5
    assert actions.execute(action)["reason"] == "released_ball_not_verified_in_storage"
    assert len(calls) == 3
