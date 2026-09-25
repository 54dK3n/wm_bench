"""Offline checks that observed action results reach the next model state."""

import copy
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from autonomous_brain import run


def failed_go_to():
    return {"success": False, "reason": "fresh_detection_does_not_verify_standoff",
            "evidence": {"object_id": "red-1", "holding": False,
                         "frame_id": "camera-2", "before_observation": 1,
                         "after_observation": 2, "final_observation": 2,
                         "detection": {"track_id": "red-1", "category": "red-ball",
                                       "source": "virtual-cv", "frame_id": "camera-2",
                                       "distance_cm": 24.4818, "bearing_deg": 1.410,
                                       "raw_distance_cm": 30.5}}}


class CompactActionResultTests(unittest.TestCase):
    def compact(self, result, action=None):
        return run.compact_action_result(3, action or {"action": "go_to", "params": {"object_id": "red-1"}},
                                         result, 8)

    def test_fresh_camera_geometry_and_observation_provenance_are_preserved(self):
        source = failed_go_to()
        summary = self.compact(source)
        self.assertEqual(summary["round"], 3)
        self.assertFalse(summary["success"])
        self.assertEqual(summary["reason"], source["reason"])
        self.assertEqual(summary["after_observation"], 8)
        self.assertEqual(summary["evidence"], source["evidence"])
        self.assertEqual(summary["evidence"]["detection"]["distance_cm"], 24.4818)
        self.assertEqual(summary["evidence"]["detection"]["bearing_deg"], 1.410)

    def test_nested_evidence_is_copied_and_input_is_never_mutated(self):
        source = failed_go_to()
        action = {"action": "go_to", "params": {"object_id": "red-1"}}
        original, original_action = copy.deepcopy(source), copy.deepcopy(action)
        summary = self.compact(source, action)
        summary["evidence"]["detection"]["distance_cm"] = 99
        summary["action"]["params"]["object_id"] = "changed"
        self.assertEqual(source, original)
        self.assertEqual(action, original_action)

    def test_only_whitelisted_optional_fields_cross_the_state_boundary(self):
        source = failed_go_to()
        source["evidence"].update({"image": "oversized-image", "api_key": "synthetic-key",
                                   "platform_layout": {"private": True},
                                   "actuator_result": {"stoppedBy": "front_clearance",
                                                       "private_geometry": {"x": 9}}})
        source["evidence"]["detection"].update({"position_m": {"x": 99, "z": 99},
                                                "image": "oversized-image", "private_id": "hidden"})
        evidence = self.compact(source)["evidence"]
        self.assertEqual(evidence["actuator_result"], {"stoppedBy": "front_clearance"})
        self.assertEqual(set(evidence["detection"]), {
            "track_id", "category", "source", "frame_id", "distance_cm", "bearing_deg", "raw_distance_cm"})
        encoded = json.dumps(evidence, allow_nan=False)
        for forbidden in ("oversized-image", "synthetic-key", "platform_layout", "private_geometry", "position_m", "private_id"):
            self.assertNotIn(forbidden, encoded)

    def test_grab_attempts_retain_observed_alignment_and_old_match_count(self):
        source = failed_go_to()
        source["evidence"].update({"old_position_detections": [{"opaque": 1}, {"opaque": 2}],
                                   "attempts": [{"attempt": i, "before_observation": i * 2,
                                                 "after_observation": i * 2 + 1, "holding": False,
                                                 "alignment": {"mode": "camera_bearing+confirmed_position_odometry",
                                                               "remembered_distance_cm": 22 - i * 6,
                                                               "bearing_deg": 1.410,
                                                               "detection": source["evidence"]["detection"],
                                                               "image": "discard"}, "private": "discard"}
                                                for i in range(1, 4)]})
        evidence = self.compact(source)["evidence"]
        self.assertEqual(evidence["old_position_matches"], 2)
        self.assertEqual([attempt["attempt"] for attempt in evidence["attempts"]], [1, 2, 3])
        self.assertEqual([attempt["alignment"]["remembered_distance_cm"] for attempt in evidence["attempts"]], [16, 10, 4])
        self.assertEqual(evidence["attempts"][-1]["alignment"]["detection"]["distance_cm"], 24.4818)
        self.assertNotIn("discard", json.dumps(evidence))
        self.assertNotIn("old_position_detections", evidence)

    def test_placement_keeps_small_pixel_witness_but_no_world_geometry(self):
        source = {"success": True, "reason": "ball_observed_in_storage", "evidence": {
            "object_id": "red-1", "holding": False, "candidate_witnesses": 1,
            "placement": {"ball_bbox": {"x": 310, "y": 330, "w": 15, "h": 15, "image": "discard"},
                          "storage_bbox": {"x": 290, "y": 300, "w": 90, "h": 70},
                          "frame_id": "placed-3", "ball_position_m": {"x": 2, "z": 9}, "private": "discard"}}}
        evidence = self.compact(source)["evidence"]
        self.assertEqual(evidence["candidate_witnesses"], 1)
        self.assertEqual(evidence["placement"], {
            "frame_id": "placed-3", "ball_bbox": {"x": 310, "y": 330, "w": 15, "h": 15},
            "storage_bbox": {"x": 290, "y": 300, "w": 90, "h": 70}})

    def test_null_detection_and_missing_evidence_are_supported(self):
        source = {"success": False, "reason": "target_lost", "evidence": {"detection": None, "placement": None}}
        self.assertEqual(self.compact(source)["evidence"], {"detection": None, "placement": None})
        self.assertEqual(self.compact({"success": False, "reason": "no_evidence"})["evidence"], {})

    def test_nonfinite_or_nonjson_optional_values_are_omitted_and_size_is_bounded(self):
        source = failed_go_to()
        source["evidence"].update({"remembered_distance_cm": float("inf"), "frame_id": "x" * 5000,
                                   "holding": object(), "attempts": [{"attempt": index} for index in range(200)]})
        source["evidence"]["detection"].update(distance_cm=float("nan"), source=object())
        summary = self.compact(source)
        self.assertNotIn("remembered_distance_cm", summary["evidence"])
        self.assertNotIn("holding", summary["evidence"])
        self.assertNotIn("distance_cm", summary["evidence"]["detection"])
        self.assertNotIn("source", summary["evidence"]["detection"])
        self.assertLessEqual(len(summary["evidence"]["frame_id"]), 256)
        self.assertLessEqual(len(summary["evidence"]["attempts"]), 3)
        self.assertLess(len(json.dumps(summary, allow_nan=False)), 4096)


class NextModelStateTests(unittest.TestCase):
    def run_offline(self, max_rounds):
        states, runtimes, results = [], [], []
        row = {"id": "red-1", "category": "red-ball", "position_m": {"x": 0.0, "z": .32},
               "confidence": .9, "state": "CONFIRMED", "distance_cm": 32.0,
               "bearing_deg": 0.0, "hit_count": 3}
        original_row = copy.deepcopy(row)

        class FakeRuntime(run.Runtime):
            def __init__(self, config, out):
                runtimes.append(self)
                self.config, self.out, self.round = config, Path(out), 0
                self.observation_count, self.recent = 0, []
                self.held_object_id = self.pending_grasp = None
                self.bridge = SimpleNamespace(seconds=0, max_seconds=1200, log=mock.Mock())
                self.observation_log = self.motion_log = mock.Mock()
                self.perception = SimpleNamespace(objects=lambda: [row], timeline=lambda: [], action_evidence=lambda: [])
                self.roads = SimpleNamespace(nodes=[], exits=lambda *args: [], summary=lambda: [], unexplored=lambda: 0)
                self.actions = SimpleNamespace(execute=self.execute, grab_attempts={})
                self.snapshot = None

            def observe(self):
                self.observation_count += 1
                self.snapshot = {"observation_index": self.observation_count,
                                 "odometry": {"rightCm": 0, "forwardCm": 0, "headingDeg": 0},
                                 "holding": {"holding": False},
                                 "road": {"onRoad": True, "atJunction": False, "exits": [], "frontClearanceCm": 80}}
                return self.snapshot

            def execute(self, action):
                before = self.observation_count
                self.observe()
                result = failed_go_to()
                result["evidence"].update(before_observation=before, after_observation=self.observation_count,
                                            final_observation=self.observation_count)
                results.append(copy.deepcopy(result))
                return result

        class FakeClient:
            def __init__(self, **kwargs):
                self.call_count, self.total_elapsed_s, self.last_record = 0, 0, {}

            def decide(self, state):
                states.append(copy.deepcopy(state))
                self.call_count += 1
                return {"action": "go_to", "params": {"object_id": "red-1"}}

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as temporary, \
                mock.patch.object(run, "read_config", return_value={"task": "Move observed red balls", "max_rounds": max_rounds}), \
                mock.patch.object(run, "Runtime", FakeRuntime), mock.patch.object(run, "LLMClient", FakeClient), \
                mock.patch("urllib.request.urlopen", side_effect=AssertionError("offline fixture must not network")), \
                mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(run.main(["--out", temporary]), 1)
            summary = json.loads(Path(temporary, "summary.json").read_text())
            logged_rounds = [json.loads(line) for line in Path(temporary, "rounds.jsonl").read_text().splitlines()]
        self.assertEqual(row, original_row)
        return states, runtimes[0], results, summary, logged_rounds

    def test_next_model_receives_failed_observed_basis_without_rewriting_wm_geometry(self):
        states, runtime, results, summary, logged_rounds = self.run_offline(2)
        recent = states[1]["recent_actions"][-1]
        self.assertFalse(recent["success"])
        self.assertEqual(recent["reason"], "fresh_detection_does_not_verify_standoff")
        self.assertIn("evidence", recent)
        self.assertEqual(recent["evidence"]["detection"]["distance_cm"], 24.4818)
        self.assertEqual(recent["evidence"]["detection"]["bearing_deg"], 1.410)
        self.assertEqual(states[1]["objects"][0]["distance_cm"], 32.0)
        self.assertEqual(states[1]["objects"][0]["position_m"], {"x": 0.0, "z": .32})
        self.assertEqual(recent["after_observation"], 2)
        self.assertEqual(recent["evidence"]["final_observation"], 2)
        self.assertEqual(logged_rounds[0]["result"], results[0])
        self.assertEqual(summary["runtime_version"], "autonomous-brain-runtime/v2")

    def test_main_retains_five_recent_results_and_state_does_not_alias_runtime(self):
        states, runtime, _, _, _ = self.run_offline(8)
        self.assertEqual([entry["round"] for entry in states[-1]["recent_actions"]], [3, 4, 5, 6, 7])
        self.assertEqual([entry["round"] for entry in runtime.recent], [4, 5, 6, 7, 8])
        snapshot = runtime.state()
        self.assertTrue(all("evidence" in entry for entry in snapshot["recent_actions"]))
        snapshot["recent_actions"][-1]["evidence"]["detection"]["distance_cm"] = 99
        self.assertEqual(runtime.recent[-1]["evidence"]["detection"]["distance_cm"], 24.4818)


if __name__ == "__main__":
    unittest.main()
