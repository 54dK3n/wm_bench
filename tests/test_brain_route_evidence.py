"""R4/R5 fixed sensor fixtures; these tests are not formal simulator runs."""
import copy
from types import SimpleNamespace

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import RoadMemory, distance, heading_to, position, wrap
from test_brain_navigation_reposition import reposition_runtime, sensor, register


def test_unreached_candidate_reconsidered_when_real_route_evidence_changes():
    runtime, _ = reposition_runtime()
    actions = Actions(runtime)
    candidate = {"position_m": [.3, .3], "path": [[0, 0], [0, .3], [.3, .3]],
                 "segments": [], "route_version": "first-observed-route"}
    runtime.roads.approach_candidates = lambda odo, goal, excluded=(), **kwargs: (
        [] if candidate["position_m"] in excluded else [copy.deepcopy(candidate)])
    called = []
    def fail(route, budget):
        called.append(route["route_version"])
        return False, "reposition_exit_correspondence_unavailable", []
    actions._follow_approach_path = fail
    actions._road_reposition("red", actions.result(False, "requires_reposition"), [45])
    assert called == ["first-observed-route"]
    # This replaces the actual route evidence, not merely an observation/frame
    # identifier. The candidate location itself has not been reached or tested.
    candidate.update(path=[[0, 0], [.3, 0], [.3, .3]], route_version="new-observed-route")
    actions._road_reposition("red", actions.result(False, "requires_reposition"), [45])
    assert called == ["first-observed-route", "new-observed-route"]
    record = actions._navigation_record("red")
    assert record["tried_approach_positions"] == []
    assert all(a["status"] == "route_not_reached" and not a["candidate_reached"]
               for a in record["approach_attempts"])


def test_same_route_same_conditions_remain_blocked_after_new_frame():
    runtime, _ = reposition_runtime()
    actions = Actions(runtime)
    candidate = {"position_m": [.3, .3], "path": [[0, 0], [0, .3], [.3, .3]],
                 "segments": [], "route_version": "same-observed-route"}
    runtime.roads.approach_candidates = lambda odo, goal, excluded=(), **kwargs: (
        [] if candidate["position_m"] in excluded else [copy.deepcopy(candidate)])
    called = []
    actions._follow_approach_path = lambda route, budget: (
        called.append(route["route_version"]) or False, "reposition_exit_correspondence_unavailable", [])
    actions._road_reposition("red", actions.result(False, "requires_reposition"), [45])
    runtime.observe()
    outcome = actions._road_reposition("red", actions.result(False, "requires_reposition"), [45])
    assert called == ["same-observed-route"]
    assert not outcome["success"]


def test_recorded_curve_direction_not_its_endpoint_chord_selects_exit():
    runtime, _ = reposition_runtime()
    actions = Actions(runtime)
    runtime.snapshot["odometry"].update(rightCm=0, forwardCm=0, headingDeg=90)
    runtime.snapshot["road"].update(atNode=True, exits=[{"angleDeg": -90}, {"angleDeg": 0}], onRoad=True)
    # The curved route initially leaves north, although its endpoint lies east.
    # Its historical exit and terminal tangent are explicit observation facts.
    candidate = {"position_m": [.3, 0], "path": [[0, 0], [.3, 0]],
        "route_version": "curve", "segments": [{
            "segment_id": "segment-1-2", "before_observation": 1, "after_observation": 2,
            "direction": "forward", "direction_status": "observed_forward",
            "departure": {"position_m": [0, 0], "travel_heading_deg": 0,
                          "exit_heading_deg": 0, "exit_correspondence": "unique_observed_exit"},
            "arrival": {"position_m": [.3, 0], "travel_heading_deg": -90},
            "travelled_cm": 47.1, "measured_cm": 30}]}
    selected = []
    def take(angle):
        selected.append(angle)
        runtime.snapshot["odometry"].update(rightCm=30, forwardCm=0, headingDeg=-90,
                                            distanceCm=runtime.snapshot["odometry"]["distanceCm"] + 47.1)
        runtime.snapshot["road"].update(atNode=False, headingErrorDeg=0, exits=[])
        runtime.observe = lambda **kw: None
        runtime.snapshot["observation_index"] += 1
        runtime.snapshot["odometry"]["tick"] += 1
        runtime.snapshot["observation"]["frameId"] = "fresh-curve"
        runtime.snapshot["observation"]["tick"] = runtime.snapshot["odometry"]["tick"]
        return {"accepted": True}
    actions.take_observed_exit = take
    reached, reason, _ = actions._follow_approach_path(candidate, [5])
    assert reached, reason
    assert selected == [-90]


def curve_runtime():
    """A fixed public-sensor curve; live actions take three sampled road steps."""
    a, middle, b = (0, 0), (.1, .173), (.3, .2)
    roads = RoadMemory()
    snapshots = [sensor(1, a, heading=0), sensor(2, middle, heading=-45, travelled=22),
        sensor(3, b, heading=-90, travelled=42.2), sensor(4, b, heading=90, travelled=42.2),
        sensor(5, middle, heading=135, travelled=62.4), sensor(6, a, heading=-180, travelled=84.4),
        sensor(7, a, heading=0, travelled=84.4)]
    for row in snapshots:
        if position(row["odometry"]) == a:
            heading = row["odometry"]["headingDeg"]
            row["road"].update(atNode=True, exits=[{"angleDeg": wrap(h - heading)} for h in (0, -90)])
    for i, row in enumerate(snapshots):
        previous = snapshots[i - 1] if i in (1, 2, 4, 5) else None
        register(roads, row, previous)
    current, camera, calls = snapshots[-1], {}, []
    target = {"id": "red", "category": "red-ball", "state": "CONFIRMED",
              "position_m": {"x": .6, "z": .2}}
    runtime = SimpleNamespace(snapshot=current, round=1, roads=roads,
        perception=SimpleNamespace(objects=lambda: [target], get_object=lambda oid: target,
            confirmed=lambda oid: target, visible=lambda oid: camera),
        bridge=SimpleNamespace(seconds=0, max_seconds=1200),
        motion_log=SimpleNamespace(write=lambda row: None))
    travel_steps = [((.04, .115), -30, 12.5), (middle, -45, 9.5), (b, -90, 20.2)]
    tangent = [0]
    def refresh():
        odo = current["odometry"]
        p, heading = position(odo), odo["headingDeg"]
        current["road"].update(atNode=p == a,
            exits=[{"angleDeg": wrap(h - heading)} for h in (0, -90)] if p == a else [],
            headingErrorDeg=wrap(tangent[0] - heading),
            leftClearanceCm=.1 if p == a else 20, rightClearanceCm=.1 if p == a else 20)
        camera.update(category="red-ball", track_id="red", frame_id=current["observation"]["frameId"],
            distance_cm=distance(p, (.6, .2)) * 100,
            bearing_deg=-wrap(heading_to(p, (.6, .2)) - heading))
        current["perception"]["detections"] = [camera]
    def call(method, params):
        calls.append((method, copy.deepcopy(params)))
        odo = current["odometry"]
        if method == "turn":
            odo["headingDeg"] = wrap(odo["headingDeg"] + params["angleDeg"])
        elif method in {"take_exit", "follow_road"}:
            p, heading, length = travel_steps.pop(0)
            tangent[0] = heading
            odo.update(rightCm=p[0] * 100, forwardCm=p[1] * 100, headingDeg=heading,
                       distanceCm=odo["distanceCm"] + length)
        else:
            raise AssertionError("This fixed curve needs road traversal before its visual gate")
        return {"accepted": True, "completed": True}
    def observe(*, motion=None):
        current["observation_index"] += 1
        current["odometry"]["tick"] += 1
        current["observation"] = {"frameId": str(current["observation_index"]),
                                  "tick": current["odometry"]["tick"]}
        refresh()
        roads.update(current["odometry"], current["road"], current["observation_index"])
        roads.observe_traversal(current, dict(motion, after_observation=current["observation_index"])
                                if motion else None)
    runtime.bridge.call, runtime.observe = call, observe
    refresh()
    return runtime, calls


def test_complete_curved_road_reposition_then_fresh_visual_standoff():
    runtime, calls = curve_runtime()
    result = Actions(runtime).execute({"action": "go_to", "params": {"object_id": "red"}})
    assert result["success"], result
    evidence = result["evidence"]["road_reposition"]
    assert evidence["status"] == "reposition_and_visual_standoff_verified"
    attempt = evidence["attempts"][0]
    assert attempt["reached"] and len(attempt["steps"]) == 3
    assert attempt["steps"][0]["after_position_m"] != attempt["candidate"]["path"][1]
    assert [name for name, _ in calls if name != "turn"] == ["take_exit", "follow_road", "follow_road"]
    assert attempt["approach_observation"] > attempt["steps"][-1]["after_observation"]
    assert attempt["progress"]["status"] == "standoff_verified"
    assert 25 <= result["evidence"]["detection"]["distance_cm"] <= 40


def test_new_frames_do_not_change_route_version_or_claim_reverse_completion():
    runtime, _ = curve_runtime()
    goal = (.6, .2)
    before = runtime.roads.approach_candidates(runtime.snapshot["odometry"], goal)[0]
    records = runtime.roads.road_segment_records()
    runtime.observe()
    after = runtime.roads.approach_candidates(runtime.snapshot["odometry"], goal)[0]
    assert before["route_version"] == after["route_version"]
    assert runtime.roads.road_segment_records() == records


def test_reverse_candidate_is_not_a_recorded_reverse_motion():
    roads = RoadMemory()
    a = sensor(1, (0, 0), heading=0)
    b = sensor(2, (.3, .2), heading=-90, travelled=47.1)
    register(roads, a)
    register(roads, b, a)
    candidate = roads.approach_candidates(b["odometry"], (-.3, 0))[0]
    segment = candidate["segments"][0]
    assert segment["direction"] == "reverse_attempt"
    assert segment["direction_status"] == "reverse_not_yet_observed"
    assert segment["departure"]["travel_heading_deg"] == 90
    assert segment["arrival"]["travel_heading_deg"] == -180
    assert len(roads.road_segment_records()) == 1


def test_coordinate_only_route_cannot_authorize_an_exit():
    runtime, calls = reposition_runtime()
    candidate = {"position_m": [.3, .3], "path": [[0, 0], [.3, .3]], "segments": [{}]}
    reached, reason, _ = Actions(runtime)._follow_approach_path(candidate, [5])
    assert not reached and reason == "reposition_directional_evidence_unavailable" and not calls


def test_unseen_intermediate_junction_does_not_guess_an_exit_from_goal_vector():
    runtime, _ = curve_runtime()
    actions = Actions(runtime)
    candidate = runtime.roads.approach_candidates(runtime.snapshot["odometry"], (.6, .2))[0]
    # A newly observed node in the middle of an old coarse motion has no saved
    # exit correspondence. The next chord is insufficient to pick a branch.
    real_move = actions.move
    def move(method, params):
        result = real_move(method, params)
        if method == "take_exit":
            runtime.snapshot["road"].update(atNode=True, exits=[{"angleDeg": 0}, {"angleDeg": 90}])
        return result
    actions.move = move
    reached, reason, _ = actions._follow_approach_path(candidate, [5])
    assert not reached
    assert reason in {"reposition_unrecorded_junction_inside_segment", "reposition_exit_correspondence_unavailable",
                      "reposition_junction_context_changed", "reposition_recorded_exit_not_observed"}


def test_longer_new_observed_route_is_not_hidden_by_the_failed_shortest_route():
    roads = RoadMemory()
    a, b, detour = (0, 0), (.3, 0), (0, .3)
    frames = [sensor(1, a, heading=-90), sensor(2, b, heading=-90, travelled=30),
        sensor(3, b, heading=90, travelled=30), sensor(4, a, heading=90, travelled=60)]
    for i, frame in enumerate(frames):
        register(roads, frame, frames[i - 1] if i in (1, 3) else None)
    original = roads.approach_candidates(frames[-1]["odometry"], (.6, 0))[0]
    failed = {"candidate_position_m": original["position_m"], "route_path": original["path"],
              "route_version": original["route_version"]}
    extra = [sensor(5, a, heading=0, travelled=60), sensor(6, detour, heading=0, travelled=90),
        sensor(7, detour, heading=-135, travelled=90), sensor(8, b, heading=-135, travelled=132.4),
        sensor(9, b, heading=90, travelled=132.4), sensor(10, a, heading=90, travelled=162.4)]
    for i, frame in enumerate(extra):
        register(roads, frame, extra[i - 1] if i in (1, 3, 5) else None)
    candidates = roads.approach_candidates(extra[-1]["odometry"], (.6, 0),
        alternative_routes=[failed], excluded=[original["position_m"]])
    same_candidate = [c for c in candidates if c["position_m"] == original["position_m"]]
    assert len(same_candidate) == 2
    assert same_candidate[0]["route_version"] == original["route_version"]
    assert same_candidate[1]["travelled_cm"] > same_candidate[0]["travelled_cm"]
    assert same_candidate[1]["path"] == [[0, 0], [0, .3], [.3, 0]]
    assert same_candidate[1]["route_version"] != original["route_version"]


def test_overshot_samples_require_ordered_arc_evidence_and_no_skipped_junction():
    runtime, calls = reposition_runtime()
    current = runtime.snapshot
    current["odometry"].update(rightCm=0, forwardCm=0, headingDeg=0, distanceCm=0)
    current["road"].update(atNode=True, exits=[{"angleDeg": 0}], headingErrorDeg=0)
    def leg(name, a, b, *, departure_node=False):
        return {"segment_id": name, "direction": "forward", "travelled_cm": 20,
            "departure": {"position_m": a, "travel_heading_deg": 0, "at_node": departure_node,
                "exit_correspondence": "unique_observed_exit", "exit_heading_deg": 0,
                "fresh_exit_headings_deg": [0] if departure_node else []},
            "arrival": {"position_m": b, "travel_heading_deg": 0, "at_node": False}}
    segments = [leg("first", [0, 0], [0, .2], departure_node=True),
                leg("second", [0, .2], [0, .4])]
    candidate = {"position_m": [0, .4], "path": [[0, 0], [0, .2], [0, .4]], "segments": segments}
    actions = Actions(runtime)
    def move(angle):
        calls.append(("take_exit", {"angleDeg": angle}))
        current["odometry"].update(forwardCm=40, distanceCm=40, headingDeg=0)
        current["road"].update(atNode=False, exits=[])
        current["observation_index"] += 1
        current["odometry"]["tick"] += 1
        current["observation"] = {"frameId": str(current["observation_index"]),
                                  "tick": current["odometry"]["tick"]}
        return {"accepted": True}
    actions.take_observed_exit = move
    reached, _, steps = actions._follow_approach_path(candidate, [1])
    assert reached
    assert steps[0]["completed_segment_ids"] == ["first", "second"]
    assert steps[0]["historical_arc_retraced"] is True
    # The same endpoint does not authorize bypassing an unobserved exit choice.
    current["odometry"].update(forwardCm=0, distanceCm=0)
    current["road"].update(atNode=True, exits=[{"angleDeg": 0}])
    segments[0]["arrival"]["at_node"] = True
    reached, _, steps = actions._follow_approach_path(candidate, [1])
    assert not reached and "completed_segment_ids" not in steps[0]


def test_strict_45_degree_tangent_gate_is_not_relaxed():
    runtime, calls = reposition_runtime()
    runtime.snapshot["odometry"]["headingDeg"] = 0
    runtime.snapshot["road"].update(atNode=False, headingErrorDeg=45.37, exits=[])
    candidate = {"position_m": [0, .3], "path": [[0, 0], [0, .3]], "segments": [{
        "departure": {"position_m": [0, 0], "travel_heading_deg": 0, "at_node": False},
        "arrival": {"position_m": [0, .3], "travel_heading_deg": 0, "at_node": False},
        "travelled_cm": 30}]}
    reached, reason, _ = Actions(runtime)._follow_approach_path(candidate, [1])
    assert not reached and reason == "reposition_recorded_direction_not_on_local_road" and not calls


def test_conflicting_registered_index_cannot_supply_route_evidence():
    roads = RoadMemory()
    a, b = sensor(1, (0, 0)), sensor(2, (0, .3), travelled=30)
    register(roads, a)
    register(roads, b, a)
    assert roads.approach_candidates(b["odometry"], (0, -.3))
    conflicting = copy.deepcopy(b)
    conflicting["road"]["headingErrorDeg"] = 40
    register(roads, conflicting)
    assert roads.approach_candidates(b["odometry"], (0, -.3)) == []


def test_repeated_sensor_frame_cannot_verify_reposition_arrival():
    runtime, _ = curve_runtime()
    actions = Actions(runtime)
    candidate = runtime.roads.approach_candidates(runtime.snapshot["odometry"], (.6, .2))[0]
    before_frame = copy.deepcopy(runtime.snapshot["observation"])
    real_move = actions.move
    def repeat_frame(method, params):
        result = real_move(method, params)
        runtime.snapshot["observation"] = copy.deepcopy(before_frame)
        return result
    actions.move = repeat_frame
    reached, reason, steps = actions._follow_approach_path(candidate, [5])
    assert not reached and reason == "reposition_motion_not_verified"
    assert steps[0]["after_observation"] > steps[0]["before_observation"]
    assert steps[0]["before_frame_id"] == steps[0]["after_frame_id"]
    assert "completed_segment_ids" not in steps[0]
