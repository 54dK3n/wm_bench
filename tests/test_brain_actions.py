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
                    "holding": {"holding": False}, "road": {"onRoad": True},
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


class RoadMemoryTests(unittest.TestCase):
    def test_attempted_exit_is_not_completed_exploration(self):
        roads = RoadMemory()
        odo = {"rightCm": 0, "forwardCm": 0, "headingDeg": 0}
        roads.update(odo, {"onRoad": True, "atNode": True, "exits": [{"angleDeg": 0}]})
        roads.chosen(odo, 0)
        self.assertEqual(roads.unexplored(), 1)
        roads.update(dict(odo, forwardCm=20), {"onRoad": True, "atNode": False, "exits": []})
        self.assertEqual(roads.unexplored(), 1)
        roads.update(dict(odo, forwardCm=40), {"onRoad": True, "atNode": True, "exits": [{"angleDeg": 180}]})
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
