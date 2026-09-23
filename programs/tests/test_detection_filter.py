"""Pure filter contract and platform entry tests; no test-set records are read."""
import copy
import unittest

from programs.detection_filter import DetectionFilter, detection_filter_update


def detection(category, confidence, distance=60):
    return {"category": category, "confidence": confidence, "distanceCm": distance}


class DetectionFilterTests(unittest.TestCase):
    def test_top_level_runtime_entry_matches_offline_adapter(self):
        raw = [detection("target", .83), detection("target", .84),
               detection("distractor", .79), detection("distractor", .80),
               detection("obstacle", .1), {}]
        self.assertEqual(detection_filter_update(raw, {"rightCm": 1}, {}, 12),
                         DetectionFilter().update(raw, {"rightCm": 1}, {}, 12))

    def test_per_class_confidence_boundary_is_retained(self):
        raw = [detection("target", .83), detection("target", .84),
               detection("distractor", .79), detection("distractor", .80)]
        result = DetectionFilter().update(raw)
        self.assertEqual(result["kept_indices"], [1, 3])
        self.assertEqual(result["rejected_indices"], [0, 2])

    def test_existing_wm_window_is_half_open(self):
        raw = [detection(category, .1, distance) for category in ("target", "distractor")
               for distance in (39.99, 40, 89.99, 90, 100)]
        result = detection_filter_update(raw)
        self.assertEqual(result["rejected_indices"], [1, 2, 6, 7])
        self.assertEqual(result["kept_indices"], [0, 3, 4, 5, 8, 9])
        self.assertTrue(all(result["decisions"][i]["reason"] == "outside_wm_window_retained"
                            for i in result["kept_indices"]))

    def test_scope_abstention_does_not_claim_confidence_pass(self):
        raw = [detection("target", .1, 20), detection("distractor", .1, 100)]
        result = detection_filter_update(raw)
        self.assertEqual(result["kept_indices"], [0, 1])
        self.assertTrue(all(not row["wm_window_eligible"] for row in result["decisions"]))
        self.assertTrue(all(row["reason"] == "outside_wm_window_retained" for row in result["decisions"]))

    def test_no_raw_mutation_and_complete_ordered_partition(self):
        raw = [detection("target", .83), detection("distractor", .9),
               detection("storage-zone", .1), detection("target", .1, 100)]
        original = copy.deepcopy(raw)
        result = DetectionFilter().update(raw)
        self.assertEqual(raw, original)
        self.assertEqual(sorted(result["kept_indices"] + result["rejected_indices"]), list(range(len(raw))))
        self.assertEqual(len(result["decisions"]), len(raw))

    def test_bearing_pose_road_and_tick_do_not_drive_decision(self):
        instance = DetectionFilter()
        base = [detection("target", .83), detection("distractor", .8)]
        expected = instance.update(base)
        changed = [{**item, "bearingDeg": -35} for item in base]
        actual = instance.update(changed, odometry={"rightCm": 700}, road_state={"roadId": "arbitrary"}, tick=321)
        self.assertEqual(actual, expected)

    def test_unknown_confidence_is_retained(self):
        raw = [detection("target", value) for value in (None, "0.1", float("nan"), float("inf"), True)]
        result = DetectionFilter().update(raw)
        self.assertEqual(result["kept_indices"], list(range(len(raw))))
        self.assertEqual(result["rejected_indices"], [])
        self.assertTrue(all(item["reason"] == "unknown_confidence_retained" for item in result["decisions"]))

    def test_unknown_distance_is_retained(self):
        raw = [detection("target", .1, value) for value in (None, "60", float("nan"), float("inf"), True)]
        result = detection_filter_update(raw)
        self.assertEqual(result["kept_indices"], list(range(len(raw))))
        self.assertEqual(result["rejected_indices"], [])
        self.assertTrue(all(row["reason"] == "unknown_distance_retained" for row in result["decisions"]))

    def test_other_classes_and_empty_frames_are_preserved(self):
        self.assertEqual(DetectionFilter().update([])["kept_indices"], [])
        result = DetectionFilter().update([detection("obstacle", .1), {}])
        self.assertEqual(result["kept_indices"], [0, 1])



if __name__ == "__main__":
    unittest.main()
