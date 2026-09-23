"""Pure runtime interface tests; no recorded evaluation data is accessed."""
import copy
import unittest

from programs.detection_filter import DetectionFilter, detection_filter_update


class DetectionFilterTests(unittest.TestCase):
    def test_top_level_runtime_entry_matches_offline_adapter(self):
        raw = [{"category": "target", "confidence": .83}, {"category": "target", "confidence": .84},
               {"category": "distractor", "confidence": .79}, {"category": "distractor", "confidence": .80},
               {"category": "obstacle", "confidence": .1}, {}]
        self.assertEqual(detection_filter_update(raw, {"rightCm": 1}, {}, 12),
                         DetectionFilter().update(raw, {"rightCm": 1}, {}, 12))

    def test_per_class_boundary_is_retained(self):
        raw = [{"category": "target", "confidence": .83}, {"category": "target", "confidence": .84},
               {"category": "distractor", "confidence": .79}, {"category": "distractor", "confidence": .80}]
        result = DetectionFilter().update(raw)
        self.assertEqual(result["kept_indices"], [1, 3])
        self.assertEqual(result["rejected_indices"], [0, 2])

    def test_no_raw_mutation_and_complete_ordered_partition(self):
        raw = [{"category": "target", "confidence": .83, "distanceCm": 100},
               {"category": "distractor", "confidence": .9}, {"category": "storage-zone", "confidence": .1}]
        original = copy.deepcopy(raw)
        result = DetectionFilter().update(raw)
        self.assertEqual(raw, original)
        self.assertEqual(sorted(result["kept_indices"] + result["rejected_indices"]), list(range(len(raw))))
        self.assertEqual(len(result["decisions"]), len(raw))

    def test_distance_bearing_pose_road_and_tick_do_not_drive_decision(self):
        instance = DetectionFilter()
        base = [{"category": "target", "confidence": .83}, {"category": "distractor", "confidence": .8}]
        expected = instance.update(base)
        changed = [{**item, "distanceCm": 100, "bearingDeg": -35} for item in base]
        actual = instance.update(changed, odometry={"rightCm": 700}, road_state={"roadId": "arbitrary"}, tick=321)
        self.assertEqual(actual, expected)

    def test_unknown_confidence_is_retained(self):
        raw = [{"category": "target", "confidence": value} for value in (None, "0.1", float("nan"), float("inf"), True)]
        result = DetectionFilter().update(raw)
        self.assertEqual(result["kept_indices"], list(range(len(raw))))
        self.assertEqual(result["rejected_indices"], [])
        self.assertTrue(all(item["reason"] == "unknown_confidence_retained" for item in result["decisions"]))

    def test_other_classes_and_empty_frames_are_preserved(self):
        self.assertEqual(DetectionFilter().update([])["kept_indices"], [])
        result = DetectionFilter().update([{"category": "obstacle", "confidence": .1}, {}])
        self.assertEqual(result["kept_indices"], [0, 1])


if __name__ == "__main__":
    unittest.main()
