"""Pure synthetic offline tests; never open either development or held-out records."""
import copy
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import detection_evaluation as ev


def observation(category="target", distance=60.0, bearing=0.0, confidence=0.9):
    return {"category": category, "distanceCm": distance, "bearingDeg": bearing, "confidence": confidence}


def package_at_distance(distance, camera_bearing=0.0, role="target", identity="red"):
    beta = math.radians(camera_bearing)
    length = ev.CAMERA_FORWARD_CM
    rho = -length * math.cos(beta) + math.sqrt(distance * distance - length * length * math.sin(beta) ** 2)
    return {"id": identity, "role": role, "x": rho * math.sin(beta) * .08,
            "z": -(length + rho * math.cos(beta)) * .08}


def sample(tick=10, packages=None, heading=0, x=0):
    return {"tick": tick, "seq": tick, "x": x, "z": 0, "heading": heading, "holding": None,
            "packages": packages or []}


def truth(*packages):
    return ev.legacy_truth({"tick": 10}, [sample(packages=list(packages))])


class LabelTests(unittest.TestCase):
    def test_unique_true_both_colors(self):
        distance = ev.m5_distance_cm(60, 0)
        for category in ev.COLORS:
            labeled = ev.label_detection(observation(category), truth(package_at_distance(distance, role=category)))
            self.assertEqual(labeled["label"], "true")
            self.assertAlmostEqual(labeled["geometry"][0]["distance_residual_cm"], 0)

    def test_one_dimensional_not_2d_position_error(self):
        distance = ev.m5_distance_cm(1000, 0)
        item = package_at_distance(distance, camera_bearing=2.9)
        self.assertGreater(abs(item["x"]) / .08, 30)
        self.assertEqual(ev.label_detection(observation(distance=1000), truth(item))["label"], "true")

    def test_inclusive_both_boundaries(self):
        distance = ev.m5_distance_cm(60, 0)
        self.assertEqual(ev.label_detection(observation(), truth(package_at_distance(distance + 30, 3)))["label"], "true")
        self.assertEqual(ev.label_detection(observation(), truth(package_at_distance(distance + 30.001, 3)))["label"], "false")
        self.assertEqual(ev.label_detection(observation(), truth(package_at_distance(distance, 3.001)))["label"], "false")

    def test_raw_100_mechanically_labeled_without_exclusion(self):
        labeled = ev.label_detection(observation(distance=100), truth(package_at_distance(ev.m5_distance_cm(100, 0))))
        self.assertEqual(labeled["label"], "true")
        self.assertTrue(labeled["capped"])
        self.assertEqual(ev.label_detection(observation(distance=100), truth())["label"], "false")

    def test_multiple_same_color_is_ambiguity(self):
        distance = ev.m5_distance_cm(60, 0)
        labeled = ev.label_detection(observation(), truth(package_at_distance(distance), package_at_distance(distance + 10, identity="red2")))
        self.assertEqual(labeled["label"], "ambiguity")
        self.assertEqual(len(labeled["same_color_matches"]), 2)

    def test_wrong_class_is_false_separately_counted(self):
        distance = ev.m5_distance_cm(60, 0)
        labeled = ev.label_detection(observation(), truth(package_at_distance(distance, role="distractor")))
        self.assertEqual(labeled["label"], "false")
        self.assertTrue(labeled["wrong_class"])

    def test_correct_class_present_not_wrong_class(self):
        distance = ev.m5_distance_cm(60, 0)
        labeled = ev.label_detection(observation(), truth(package_at_distance(distance), package_at_distance(distance, role="distractor", identity="blue")))
        self.assertEqual(labeled["label"], "true")
        self.assertFalse(labeled["wrong_class"])

    def test_held_ball_excluded(self):
        value = truth(package_at_distance(ev.m5_distance_cm(60, 0)))
        value["objectState"]["holding"] = "red"
        self.assertEqual(ev.label_detection(observation(), value)["label"], "false")

    def test_invalid_and_missing_truth_unknown(self):
        self.assertEqual(ev.label_detection(observation(), None)["label"], "unknown")
        self.assertEqual(ev.label_detection(observation(distance=math.nan), truth())["reason"], "invalid_raw_measurement")
        self.assertEqual(ev.label_detection(observation(bearing=120), truth())["reason"], "invalid_M5_measurement")


class BindingTests(unittest.TestCase):
    def test_neighbor_tick_never_used_for_normal_observe(self):
        self.assertFalse(ev.legacy_truth({"event": "observe", "tick": 10}, [sample(tick=9), sample(tick=11)])["exact_pose"])

    def test_stationary_calibration_bracket_is_explicit(self):
        line = {"event": "calib_obs", "tick": 10, "tickAfter": 10, "odo": [0, 0, 0], "odoAfter": [0, 0, 0]}
        value = ev.legacy_truth(line, [sample(tick=9), sample(tick=11)])
        self.assertEqual(value["binding"], "legacy_static_calibration_bracket")
        self.assertEqual(value["sample_ticks"], [9, 11])
        self.assertIsNone(value["frame_id"])
        self.assertFalse(value["native_png_available"])

    def test_moving_calibration_bracket_rejected(self):
        line = {"event": "calib_obs", "tick": 10, "tickAfter": 10, "odo": [0, 0, 0], "odoAfter": [0, 0, 0]}
        self.assertFalse(ev.legacy_truth(line, [sample(tick=9), sample(tick=11, heading=.1)])["exact_pose"])
        line["tickAfter"] = 11
        self.assertFalse(ev.legacy_truth(line, [sample()])["exact_pose"])

    def test_conflicting_same_tick_samples_rejected(self):
        self.assertEqual(ev.legacy_truth({"tick": 10}, [sample(), sample(x=.2)])["reason"], "conflicting_states_at_same_tick")

    def test_exact_native_binding_and_no_frame_reuse(self):
        line = {"tick": 10, "raw": [observation()]}
        q = {"seq": 3, "method": "observe", "tick": 10, "frameId": 1, "evidenceId": "v1", "result": [observation()]}
        f = {"seq": 2, "tick": 10, "frameId": 1, "evidenceId": "v1", "sha256": "hash", "stateRevision": 0}
        t = {**truth(), "runId": "mock", "exactRenderState": True, "evidenceId": "v1", "frameId": 1,
             "evidenceSeq": 2, "imageSha256": "hash", "captureTick": 10, "captureStateRevision": 0,
             "evidenceTick": 10, "evidenceStateRevision": 0, "sameTickAndRevision": True}
        vision = {"runId": "mock", "queries": [q], "frames": [f], "renderTruth": {"frames": [t]}}
        consumed = set()
        self.assertEqual(ev.native_truth(line, vision, consumed, "mock")["binding"], "native_exact_render")
        self.assertFalse(ev.native_truth(line, vision, consumed, "mock")["exact_pose"])
        bad = copy.deepcopy(vision)
        bad["renderTruth"]["frames"][0]["captureTick"] = 9
        self.assertFalse(ev.native_truth(line, bad, set(), "mock")["exact_pose"])
        for field, value in (("sameTickAndRevision", False), ("evidenceTick", 9), ("evidenceStateRevision", 1)):
            bad = copy.deepcopy(vision)
            bad["renderTruth"]["frames"][0][field] = value
            self.assertFalse(ev.native_truth(line, bad, set(), "mock")["exact_pose"], field)
        self.assertEqual(ev.native_truth(line, vision, set(), "another-run")["reason"], "native_vision_run_id_mismatch")

    def test_ten_distinct_layouts_required(self):
        inventory = [{"raw_file": str(ev.TEST_ROOT / f"map-{i:02d}.json"), "map": f"map-{i:02d}"} for i in range(1, 11)]
        self.assertTrue(ev.test_inventory_complete(inventory))
        self.assertFalse(ev.test_inventory_complete(inventory[:-1]))
        self.assertFalse(ev.test_inventory_complete(inventory[:-1] + [inventory[0]]))
        wrong_layout = copy.deepcopy(inventory)
        wrong_layout[0]["map"] = "map-02"
        self.assertFalse(ev.test_inventory_complete(wrong_layout))

    def test_test_guard_fails_before_any_test_discovery(self):
        with self.assertRaises(ValueError):
            ev.freeze_verified(None, None)
        with patch.object(ev, "read", side_effect=AssertionError("must not read forbidden raw")):
            with self.assertRaises(ValueError):
                ev.dataset([ev.TEST_ROOT / "map-01.json"], "dev")


class MetricTests(unittest.TestCase):
    def setUp(self):
        self.rows = [{"row_id": str(i), "category": "target" if i % 2 else "distractor", "label": label,
                      "wrong_class": i == 3, "reason": "unknown_fixture"}
                     for i, label in enumerate(("true", "true", "false", "false", "ambiguity", "unknown"))]

    def test_counts_unknown_and_ambiguity_not_false(self):
        metrics = ev.metric_counts(self.rows, ["1", "2", "4", "5"])
        self.assertEqual(metrics["true_filtered"], 1)
        self.assertEqual(metrics["false_filtered"], 1)
        self.assertEqual(metrics["all_raw_filtered"], 4)
        self.assertEqual(metrics["filter_precision"], .5)
        self.assertEqual(metrics["false_kill_rate"], .5)
        self.assertEqual(metrics["evaluable_total"], 4)

    def test_keep_all_and_reject_all_invariants(self):
        for checks in ev.self_checks(self.rows).values():
            self.assertTrue(all(checks.values()))
        self.assertIsNone(ev.metric_counts(self.rows, [])["filter_precision"])

    def test_undefined_precision_never_passes(self):
        gates = ev.performance_gates(ev.summarize(self.rows, []), True, "test")
        self.assertFalse(gates["all_gates_pass"])
        self.assertFalse(gates["gates"]["red_filter_precision_at_least_95pct"])

    def test_rate_gate_and_test_coverage(self):
        rows = [{"row_id": f"{color}-{i}", "category": color, "label": "true" if i < 100 else "false"}
                for color in ev.COLORS for i in range(120)]
        rejected = [r["row_id"] for r in rows if r["label"] == "false"]
        metrics = ev.summarize(rows, rejected)
        self.assertTrue(ev.performance_gates(metrics, True, "test")["all_gates_pass"])
        self.assertFalse(ev.performance_gates(metrics, False, "test")["all_gates_pass"])
        dev = ev.performance_gates(metrics, False, "dev")
        self.assertTrue(dev["candidate_rates_pass"])
        self.assertFalse(dev["all_gates_pass"])

    def test_adapter_passes_only_public_runtime_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "filter.py"
            path.write_text('''class DetectionFilter:
 def __init__(self): self.n=0
 def update(self, observations, odometry=None, road_state=None, tick=None):
  assert set(observations[0])=={"category","distanceCm","bearingDeg","confidence"}
  assert odometry is None and road_state is None
  self.n+=1
  return {"kept_indices":[] if self.n==2 else [0],"rejected_indices":[0] if self.n==2 else [],"diagnostics":[]}
''')
            frames = [{"run_id": "one", "frame_id": str(i), "tick": i, "observations": [observation()], "odometry": None, "road_state": None} for i in range(2)]
            frames.append({**frames[0], "run_id": "two", "frame_id": "2"})
            rejected, _ = ev.replay_filter(frames, path)
            self.assertEqual(rejected, ["1:det-0"])

    def test_adapter_rejects_mutation_or_nonpartition(self):
        frame = {"run_id": "one", "frame_id": "1", "tick": 1, "observations": [observation()], "odometry": None, "road_state": None}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "filter.py"
            path.write_text('''class DetectionFilter:
 def update(self, observations, **kwargs):
  observations[0]["distanceCm"]=123
  return {"kept_indices":[0],"rejected_indices":[]}
''')
            with self.assertRaisesRegex(ValueError, "mutated"):
                ev.replay_filter([frame], path)


if __name__ == "__main__":
    unittest.main()
