import copy
from types import SimpleNamespace
import unittest

from autonomous_brain.actions import Actions, ball_inside_region
from autonomous_brain.navigation import RoadMemory, heading_to


class ActionEvidenceTests(unittest.TestCase):
    def runtime(self, target=None, detected=None):
        target = target or {"id": "red-1", "category": "red-ball", "state": "CONFIRMED",
                            "position_m": {"x": 0, "z": .30}}
        snapshot = {"observation_index": 1, "observation": {"frameId": 1},
                    "odometry": {"tick": 0, "rightCm": 0, "forwardCm": 0, "headingDeg": 0},
                    "holding": {"holding": False},
                    "road": {"onRoad": True, "frontClearanceCm": 100},
                    "perception": {"detections": []}}
        runtime = SimpleNamespace(snapshot=snapshot, pending_grasp=None,
            perception=SimpleNamespace(confirmed=lambda oid: target, get_object=lambda oid: target,
                                       visible=lambda oid: detected, objects=lambda: []),
            bridge=SimpleNamespace(seconds=0, max_seconds=1200),
            roads=SimpleNamespace(nodes=[{}], unexplored=lambda: 0))
        def observe():
            runtime.snapshot["observation_index"] += 1
            runtime.snapshot["observation"]["frameId"] += 1
        runtime.observe = observe
        return runtime

    def test_standoff_requires_current_camera_distance_not_memory(self):
        runtime = self.runtime(detected={"distance_cm": 60, "bearing_deg": 0})
        outcome = Actions(runtime).go_to("red-1")
        self.assertFalse(outcome["success"])
        self.assertEqual(outcome["evidence"]["detection"]["distance_cm"], 60)

    def test_standoff_requires_current_bearing(self):
        runtime = self.runtime(detected={"distance_cm": 32, "bearing_deg": 24})
        self.assertFalse(Actions(runtime).go_to("red-1")["success"])

    def test_done_uses_final_observation(self):
        runtime = self.runtime()
        def observe():
            runtime.snapshot["observation_index"] = 2
            runtime.perception.objects = lambda: [{"id": "new-red", "category": "red-ball", "state": "TENTATIVE"}]
        runtime.observe = observe
        outcome = Actions(runtime).execute({"action": "done", "params": {}})
        self.assertFalse(outcome["success"])
        self.assertEqual(outcome["evidence"]["pending_objects"], ["new-red"])

    def test_servo_exhaustion_does_not_blindly_grab(self):
        runtime = self.runtime(detected={"distance_cm": 30, "bearing_deg": 0})
        actions = Actions(runtime)
        moves = []
        def move(method, params):
            moves.append((method, params))
            return {}
        actions.move = move
        result = actions.pick("red-1")
        self.assertFalse(result["success"])
        self.assertNotIn("grab", [method for method, _ in moves])

    def test_near_field_occlusion_uses_odometry_and_stops_after_three_grabs(self):
        runtime = self.runtime(detected=None)
        actions = Actions(runtime)
        moves = []
        def move(method, params):
            moves.append((method, params))
            if method == "forward":
                runtime.snapshot["odometry"]["forwardCm"] += params["distanceCm"]
            runtime.observe()
            return {}
        actions.move = move
        result = actions.pick("red-1")
        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "three_grab_attempts_failed")
        self.assertEqual([m for m, _ in moves].count("grab"), 3)
        distances = [a["alignment"]["remembered_distance_cm"] for a in result["evidence"]["attempts"]]
        for actual, expected in zip(distances, [22, 16, 10]):
            self.assertAlmostEqual(actual, expected)
        self.assertEqual(moves[-1][0], "grab")

    def test_invisible_distant_target_cannot_start_memory_only_grab(self):
        target = {"id": "red-1", "category": "red-ball", "state": "CONFIRMED",
                  "position_m": {"x": 0, "z": .60}}
        actions = Actions(self.runtime(target=target, detected=None))
        moves = []
        actions.move = lambda method, params: moves.append((method, params))
        result = actions.pick("red-1")
        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "target_lost_before_close_approach")
        self.assertEqual(moves, [])

    def test_pick_does_not_send_subminimum_distance_at_standoff(self):
        target = {"id": "red-1", "category": "red-ball", "state": "CONFIRMED",
                  "position_m": {"x": 0, "z": .2205}}
        runtime = self.runtime(target=target, detected=None)
        actions = Actions(runtime)
        moves = []
        def move(method, params):
            moves.append((method, params))
            if method == "forward":
                self.assertGreaterEqual(params["distanceCm"], 0.1)
                runtime.snapshot["odometry"]["forwardCm"] += params["distanceCm"]
            runtime.observe()
            return {}
        actions.move = move
        self.assertEqual(actions.pick("red-1")["reason"], "three_grab_attempts_failed")
        self.assertEqual(moves[0][0], "grab")

    def test_region_witness_rejects_corners_and_clipped_regions(self):
        zone = {"x": 100, "y": 200, "w": 100, "h": 50}
        self.assertTrue(ball_inside_region({"x": 145, "y": 210, "w": 10, "h": 15}, zone))
        self.assertFalse(ball_inside_region({"x": 101, "y": 201, "w": 4, "h": 4}, zone))
        self.assertFalse(ball_inside_region({"x": 145, "y": 210, "w": 10, "h": 15}, dict(zone, x=0)))


class ScriptedActionCase(unittest.TestCase):
    def scripted_runtime(self, steps, *, on_road=True, pose=None, task="", objects=None,
                         detections=None, holding=False, road=None):
        snapshot = {"observation_index": 1, "observation": {"frameId": 1},
                    "odometry": {"tick": 0, "rightCm": 0, "forwardCm": 0, "headingDeg": 0,
                                 **(pose or {})},
                    "holding": {"holding": holding},
                    "road": {"onRoad": on_road, "atNode": False, "exits": [],
                             "headingErrorDeg": 0, "frontClearanceCm": 100, **(road or {})},
                    "objects": copy.deepcopy(objects or []),
                    "perception": {"detections": copy.deepcopy(detections or [])}}
        for detection in snapshot["perception"]["detections"]:
            detection.setdefault("frame_id", "1")
        moves, remaining, pending = [], copy.deepcopy(steps), []
        roads = RoadMemory()
        roads.update(snapshot["odometry"], snapshot["road"])
        runtime = SimpleNamespace(snapshot=snapshot, round=1, roads=roads, config={"task": task},
            perception=SimpleNamespace(objects=lambda: snapshot["objects"]),
            bridge=SimpleNamespace(seconds=0, max_seconds=1200),
            motion_log=SimpleNamespace(write=lambda row: None))

        def call(method, params):
            self.assertTrue(remaining, f"unexpected motion: {method}")
            step = remaining.pop(0)
            self.assertEqual(method, step["method"])
            if "params" in step:
                self.assertEqual(params, step["params"])
            moves.append((method, params))
            pending.append(step)
            return step.get("result", {})

        def observe():
            if pending:
                step = pending.pop(0)
                snapshot["odometry"].update(step.get("odometry", {}))
                snapshot["road"].update(step.get("road", {}))
                snapshot["objects"] = step.get("objects", snapshot["objects"])
                snapshot["perception"]["detections"] = step.get("detections", [])
            snapshot["observation_index"] += 1
            snapshot["observation"]["frameId"] += 1
            snapshot["odometry"]["tick"] += 1
            for detection in snapshot["perception"]["detections"]:
                detection.setdefault("frame_id", str(snapshot["observation"]["frameId"]))
            roads.update(snapshot["odometry"], snapshot["road"])

        runtime.bridge.call, runtime.observe = call, observe
        return runtime, moves, remaining


class ExploreRecoveryTests(ScriptedActionCase):
    def test_near_junction_ends_exploration_before_second_motion(self):
        for stopped_by in ("junction", "max_distance"):
            with self.subTest(stopped_by=stopped_by):
                runtime, moves, remaining = self.scripted_runtime([{
                    "method": "follow_road",
                    "result": {"accepted": True, "stoppedBy": stopped_by, "distanceCm": 6.4},
                    "odometry": {"forwardCm": 6.4},
                    "road": {"atNode": True, "exits": [{"angleDeg": 180}, {"angleDeg": 90}]},
                }])
                result = Actions(runtime).explore()
                self.assertTrue(result["success"])
                self.assertEqual(result["reason"], "next_junction_observed")
                self.assertEqual(len(moves), 1)
                self.assertEqual(remaining, [])
                self.assertEqual(runtime.roads.blocked, [])

    def test_zero_distance_junction_is_not_a_blockage(self):
        for at_node in (False, True):
            with self.subTest(at_node=at_node):
                runtime, moves, _ = self.scripted_runtime([{
                    "method": "follow_road",
                    "result": {"accepted": True, "stoppedBy": "junction", "distanceCm": 0},
                    "road": {"atNode": at_node},
                }])
                result = Actions(runtime).explore()
                self.assertTrue(result["success"])
                self.assertEqual(result["reason"], "next_junction_observed")
                self.assertEqual(len(moves), 1)
                self.assertEqual(runtime.roads.blocked, [])

    def test_blocked_curved_road_turns_and_follows_road_to_junction(self):
        runtime, moves, remaining = self.scripted_runtime([
            {"method": "follow_road",
             "result": {"accepted": True, "stoppedBy": "front_clearance", "distanceCm": 2.8},
             "odometry": {"rightCm": -154}},
            {"method": "turn", "params": {"angleDeg": -180, "speed": 50},
             "odometry": {"headingDeg": 90}},
            {"method": "follow_road", "params": {"distanceCm": 20, "speed": 30},
             "result": {"accepted": True, "stoppedBy": "max_distance", "distanceCm": 20},
             "odometry": {"rightCm": -173, "forwardCm": -19, "headingDeg": 65}},
            {"method": "follow_road", "params": {"distanceCm": 20, "speed": 30},
             "result": {"accepted": True, "stoppedBy": "junction", "distanceCm": 15},
             "odometry": {"rightCm": -184, "forwardCm": -9, "headingDeg": 40},
             "road": {"atNode": True, "exits": [{"angleDeg": 180}, {"angleDeg": 0}]}},
        ], pose={"rightCm": -156.8, "forwardCm": -22.4, "headingDeg": -90})
        result = Actions(runtime).explore()
        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "road_blocked_returned_to_junction")
        self.assertEqual(result["evidence"]["actuator_result"]["stoppedBy"], "front_clearance")
        self.assertEqual(result["evidence"]["recovery_steps"], 2)
        self.assertEqual([method for method, _ in moves], ["follow_road", "turn", "follow_road", "follow_road"])
        self.assertEqual(runtime.snapshot["observation_index"], 5)
        self.assertTrue(runtime.snapshot["road"]["onRoad"])
        self.assertTrue(runtime.snapshot["road"]["atNode"])
        self.assertEqual(remaining, [])

    def test_already_off_road_does_not_move(self):
        runtime, moves, _ = self.scripted_runtime([], on_road=False)
        result = Actions(runtime).execute({"action": "explore", "params": {}})
        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "not_on_observed_road")
        self.assertEqual(moves, [])
        self.assertEqual(runtime.snapshot["observation_index"], 2)

    def test_off_road_motion_result_cannot_trigger_blind_recovery(self):
        for on_road in (False, True):
            with self.subTest(on_road=on_road):
                runtime, moves, _ = self.scripted_runtime([{
                    "method": "follow_road",
                    "result": {"accepted": False, "stoppedBy": "off_road", "distanceCm": 0},
                    "road": {"onRoad": on_road},
                }])
                result = Actions(runtime).explore()
                self.assertFalse(result["success"])
                self.assertEqual(result["reason"], "not_on_observed_road")
                self.assertEqual(len(moves), 1)

    def test_recovery_stops_immediately_if_road_is_lost(self):
        runtime, moves, remaining = self.scripted_runtime([
            {"method": "follow_road",
             "result": {"accepted": True, "stoppedBy": "front_clearance", "distanceCm": 0}},
            {"method": "turn", "odometry": {"headingDeg": 180}},
            {"method": "follow_road",
             "result": {"accepted": True, "stoppedBy": "max_distance", "distanceCm": 20},
             "odometry": {"forwardCm": -20}, "road": {"onRoad": False}},
        ])
        result = Actions(runtime).explore()
        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "blocked_road_return_left_road")
        self.assertEqual([method for method, _ in moves], ["follow_road", "turn", "follow_road"])
        self.assertEqual(remaining, [])


class CandidateReobservationTests(ScriptedActionCase):
    def candidate(self, category="red-ball", state="TENTATIVE"):
        return ({"id": "candidate-1", "category": category, "state": state, "hit_count": 1},
                {"track_id": "candidate-1", "category": category, "fed_to_world_model": True,
                 "bearing_deg": .4})

    def scan_steps(self, target, detection, *, road=None, return_to_candidate=False):
        steps = []
        for index, heading in enumerate((-156.8, -111.8, -66.8, -21.8, 23.2, 68.2, 113.2, 158.2)):
            step = {"method": "turn", "params": {"angleDeg": 45, "speed": 50},
                    "odometry": {"headingDeg": heading},
                    "road": {"headingErrorDeg": 0 if (index + 1) % 4 == 0 else 45 if index % 2 == 0 else 90}}
            if index == 3:
                step.update(objects=[target], detections=[detection])
                step["road"].update(road or {})
            steps.append(step)
        if return_to_candidate:
            steps.append({"method": "turn", "params": {"angleDeg": -180, "speed": 50},
                          "odometry": {"headingDeg": -21.8}, "detections": [detection]})
        return steps

    def test_complete_scan_returns_to_observed_target_road_direction(self):
        for task in ("把红球送到存放区", "Collect the RED balls"):
            with self.subTest(task=task):
                target, detection = self.candidate()
                runtime, moves, remaining = self.scripted_runtime(
                    self.scan_steps(target, detection, return_to_candidate=True),
                    task=task, pose={"headingDeg": 158.2})
                result = Actions(runtime).look_around()
                self.assertEqual([p["angleDeg"] for _, p in moves], [45] * 8 + [-180])
                self.assertAlmostEqual(runtime.snapshot["odometry"]["headingDeg"], -21.8)
                candidate = result["evidence"]["reobservation_candidate"]
                self.assertEqual(candidate["object_id"], "candidate-1")
                self.assertEqual(candidate["observation_index"], 5)
                self.assertAlmostEqual(candidate["heading_deg"], -21.8)
                self.assertEqual(runtime.snapshot["observation_index"], 10)
                self.assertEqual(runtime.snapshot["objects"][0]["hit_count"], 1)
                self.assertEqual(remaining, [])

    def test_sideways_or_blocked_candidate_does_not_change_final_direction(self):
        for road in ({"headingErrorDeg": 90}, {"frontClearanceCm": 3}, {"onRoad": False},
                     {"headingErrorDeg": None}, {"frontClearanceCm": None},
                     {"headingErrorDeg": float("nan")}, {"frontClearanceCm": float("inf")}):
            with self.subTest(road=road):
                target, detection = self.candidate()
                runtime, moves, _ = self.scripted_runtime(self.scan_steps(target, detection, road=road),
                    task="红球", pose={"headingDeg": 158.2})
                result = Actions(runtime).look_around()
                self.assertEqual(len(moves), 8)
                self.assertIsNone(result["evidence"]["reobservation_candidate"])
                self.assertEqual(runtime.snapshot["odometry"]["headingDeg"], 158.2)

    def test_unrelated_blue_or_unspecified_task_does_not_reverse(self):
        for category, task in (("blue-ball", "收集红球"), ("red-ball", "收集球"),
                               ("red-ball", "Move stored objects")):
            with self.subTest(category=category, task=task):
                target, detection = self.candidate(category)
                runtime, moves, _ = self.scripted_runtime(self.scan_steps(target, detection),
                    task=task, pose={"headingDeg": 158.2})
                result = Actions(runtime).look_around()
                self.assertEqual(len(moves), 8)
                self.assertIsNone(result["evidence"]["reobservation_candidate"])

    def test_blue_task_can_return_to_blue_candidate(self):
        for task in ("收集蓝球", "Collect blue balls"):
            with self.subTest(task=task):
                target, detection = self.candidate("blue-ball")
                runtime, moves, _ = self.scripted_runtime(
                    self.scan_steps(target, detection, return_to_candidate=True),
                    task=task, pose={"headingDeg": 158.2})
                result = Actions(runtime).look_around()
                self.assertEqual(len(moves), 9)
                self.assertEqual(result["evidence"]["reobservation_candidate"]["category"], "blue-ball")

    def test_candidate_requires_current_eligible_tentative_track(self):
        for change in ({"fed_to_world_model": False}, {"frame_id": "old"}, {"track_id": "unknown"}):
            with self.subTest(change=change):
                target, detection = self.candidate()
                detection.update(change)
                runtime, moves, _ = self.scripted_runtime(self.scan_steps(target, detection),
                    task="red", pose={"headingDeg": 158.2})
                result = Actions(runtime).look_around()
                self.assertEqual(len(moves), 8)
                self.assertIsNone(result["evidence"]["reobservation_candidate"])
        target, detection = self.candidate(state="CONFIRMED")
        runtime, moves, _ = self.scripted_runtime(self.scan_steps(target, detection),
            task="red", pose={"headingDeg": 158.2})
        self.assertIsNone(Actions(runtime).look_around()["evidence"]["reobservation_candidate"])
        self.assertEqual(len(moves), 8)

    def test_held_object_prioritizes_observed_storage_over_task_ball(self):
        target, detection = self.candidate()
        zone = {"id": "zone-1", "category": "storage-zone", "state": "TENTATIVE"}
        zone_detection = {"track_id": "zone-1", "category": "storage-zone",
                          "fed_to_world_model": True, "bearing_deg": 10}
        steps = self.scan_steps(target, detection)
        steps[-1].update(objects=[target, zone], detections=[zone_detection])
        runtime, moves, _ = self.scripted_runtime(steps, task="red", holding=True,
                                                 pose={"headingDeg": 158.2})
        result = Actions(runtime).look_around()
        self.assertEqual(result["evidence"]["reobservation_candidate"]["object_id"], "zone-1")
        self.assertEqual(len(moves), 8)

    def test_explore_uses_sixteen_cm_views_and_stops_at_new_confirmation(self):
        for category in ("red-ball", "blue-ball", "storage-zone"):
            with self.subTest(category=category):
                target, detection = self.candidate(category)
                steps = [{"method": "follow_road", "params": {"distanceCm": 16, "speed": 50},
                          "result": {"stoppedBy": "max_distance", "distanceCm": 16},
                          "odometry": {"forwardCm": 16 * hit},
                          "objects": [dict(target, hit_count=hit + 1,
                                           state="CONFIRMED" if hit == 2 else "TENTATIVE")],
                          "detections": [detection]} for hit in (1, 2)]
                runtime, moves, remaining = self.scripted_runtime(steps, objects=[target], detections=[detection])
                result = Actions(runtime).explore()
                self.assertEqual(result["reason"], "new_objects_confirmed")
                self.assertEqual(result["evidence"]["newly_confirmed_object_ids"], ["candidate-1"])
                self.assertEqual([p["distanceCm"] for _, p in moves], [16, 16])
                self.assertEqual(remaining, [])

    def test_memory_only_tentative_or_preexisting_confirmation_keeps_twenty_cm(self):
        for state in ("TENTATIVE", "CONFIRMED"):
            with self.subTest(state=state):
                target, detection = self.candidate(state=state)
                detection["fed_to_world_model"] = False
                runtime, moves, _ = self.scripted_runtime([{
                    "method": "follow_road", "params": {"distanceCm": 20, "speed": 50},
                    "result": {"stoppedBy": "junction", "distanceCm": 20},
                    "odometry": {"forwardCm": 20}, "road": {"atNode": True},
                }], objects=[target], detections=[detection])
                result = Actions(runtime).explore()
                self.assertEqual(result["reason"], "next_junction_observed")
                self.assertEqual(len(moves), 1)


class RoadMemoryTests(unittest.TestCase):
    def test_attempted_exit_is_not_completed_exploration(self):
        roads = RoadMemory()
        odo = {"rightCm": 0, "forwardCm": 0, "headingDeg": 0}
        roads.update(odo, {"onRoad": True, "atNode": True, "headingErrorDeg": 0,
                           "exits": [{"angleDeg": 0}]})
        roads.chosen(odo, 0)
        self.assertEqual(roads.unexplored(), 1)
        roads.update(dict(odo, forwardCm=20), {"onRoad": True, "atNode": False,
                                             "headingErrorDeg": 0, "exits": []})
        self.assertEqual(roads.unexplored(), 1)
        roads.update(dict(odo, forwardCm=40), {"onRoad": True, "atNode": True,
                                             "headingErrorDeg": 0, "exits": [{"angleDeg": 180}]})
        self.assertEqual(roads.unexplored(), 0)

    def test_direction_and_paths_are_odometry_based(self):
        self.assertEqual(heading_to((0, 0), (1, 0)), -90)
        self.assertEqual(heading_to((0, 0), (-1, 0)), 90)
        roads = RoadMemory()
        for forward in (0, 20, 40):
            roads.update({"rightCm": 0, "forwardCm": forward, "headingDeg": 0},
                         {"onRoad": True, "atNode": False, "exits": []})
        path = roads.route_to({"rightCm": 0, "forwardCm": 40}, (0, 0))
        self.assertEqual(path, [(0, .4), (0, .2), (0, 0)])


if __name__ == "__main__":
    unittest.main()
