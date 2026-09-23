"""Offline synthetic audit counterexamples; never invokes a simulator."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from tools.demo_report import analyse_demo, static_checks


class DemoAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.path = self.folder / "map-03.json"
        program = self.folder / "program.py"
        program.write_text('mission = nav_mission()\nstorage = mission["storage"]\n')
        self.version = {"event": "program_version", "file_sha256": hashlib.sha256(program.read_bytes()).hexdigest()}
        lines = [self.version]
        events = [{"type": "run_started", "seq": 1, "t": 0}]
        count = 0
        for ball in (1, 2):
            track = f"target_{ball}"
            start = (ball - 1) * 200
            lines.append({"event": "ball_start", "ball_index": ball, "track_id": None, "target_source": "new_observations", "tick": start})
            hits = []
            for hit in (1, 2, 3):
                count += 1
                lines += [{"event": "observe", "observe_count": count, "tick": start + 10 * hit,
                           "odo": [ball * 100 + hit * 20, 0, 0], "raw": []},
                          {"event": "wm_associations", "items": [{"track_id": track, "distanceCm": 60}]},
                          {"event": "wm_targets", "tracks": [{"id": track, "hit": hit}]}]
                if hit == 1:
                    lines.append({"event": "ball_selection", "ball_index": ball, "track_id": track, "target_source": "new_observations", "tick": start + 10})
                hits.append({"track_id": track, "distanceCm": 60, "pose_x": ball + hit * .2, "pose_z": 0})
            lines += [{"event": "memory_confirmed", "track_id": track, "hits": hits, "last_sample_wm_distance_m": .6},
                      {"event": "approach_call", "max_steps": 1, "wm_distance_m": .22, "forward_after_last_observe_cm": 40},
                      {"event": "ball_end", "ball_index": ball, "success": True}]
            events += [{"type": "package_grabbed", "accepted": True, "objectRole": "target", "packageId": f"p{ball}", "seq": ball * 10, "t": (start + 60) * 20},
                       {"type": "package_delivered", "objectRole": "target", "packageId": f"p{ball}", "seq": ball * 10 + 1, "t": (start + 100) * 20}]
        lines.append({"event": "flow_end", "success": True})
        events.append({"type": "run_finished", "seq": 99, "t": 7000})
        image = b"\x89PNG\r\n\x1a\nsynthetic-test-only"
        (self.folder / "native.png").write_bytes(image)
        sha = hashlib.sha256(image).hexdigest()
        frame = {"image": "native.png", "sha256": sha, "byteLength": len(image), "frameId": 1, "tick": 0}
        self.vision = {"frames": [frame], "validation": {key: True for key in (
            "allNativeFramesExported", "allNativeQueriesExported", "allObserveFramesBound", "exportedBytesMatchNative", "allNativeFramesHaveExactRenderTruth")}}
        self.frames = {"frames": [{**frame, "event": event} for event in events if event.get("objectRole") == "target"],
            "allScreenshotBytesExported": True, "combinedImageBytes": 30 * 1024 * 1024, "combinedImagesWithinBudget": False}
        self.raw = {"assignedMap": "map-03", "program": str(program), "lines": lines,
            "record": {"events": events, "vision": {"frameCount": 1, "frameBytes": len(image)},
                       "top": {"result": {"durationSeconds": 7, "violationMetrics": {"off_road": {"episodes": 0, "durationMs": 0, "maxSeverity": 0}}}}},
            "fullRecordFile": str(self.folder / "full.record.json"), "visionEvidenceFile": str(self.folder / "native.vision.json"),
            "demoEvidenceFile": str(self.folder / "keyframes.demo.json"), "demoEvidence": {"allSuccessEventsHaveScreenshots": True}}
        (self.folder / "map-03.samples.json").write_text(json.dumps([{"tick": 0, "packages": [{"id": "p1", "role": "target"}, {"id": "p2", "role": "target"}]}]))

    def evaluate(self):
        self.path.write_text(json.dumps(self.raw))
        (self.folder / "full.record.json").write_text(json.dumps({"events": self.raw["record"]["events"]}))
        (self.folder / "native.vision.json").write_text(json.dumps(self.vision))
        (self.folder / "keyframes.demo.json").write_text(json.dumps(self.frames))
        return analyse_demo(self.path)

    def test_complete_demo_passes_combined_bytes_are_information_only(self):
        result = self.evaluate()
        self.assertTrue(result["all_gates_pass"], result["failure_reasons"])

    def test_false_success_counterexamples(self):
        mutations = {
            "same_package_twice": lambda r: r["record"]["events"][4].update(packageId="p1"),
            "missing_grab": lambda r: r["record"]["events"][3].update(type="package_interaction_failed"),
            "program_error": lambda r: r["record"]["events"].append({"type": "program_error", "message": "unexpected"}),
            "timeout": lambda r: r["record"]["top"]["result"].update(durationSeconds=601),
            "offroad": lambda r: r["record"]["top"]["result"]["violationMetrics"]["off_road"].update(episodes=1),
            "no_road_evidence": lambda r: r["record"]["top"]["result"].pop("violationMetrics"),
            "revoke_delivery": lambda r: r["record"]["events"].append({"type": "package_delivery_revoked", "packageId": "p1"}),
            "no_ball_identity": lambda r: next(l for l in r["lines"] if l.get("event") == "ball_selection").update(track_id=None),
            "false_memory_source": lambda r: next(l for l in r["lines"] if l.get("event") == "ball_selection").update(target_source="memory"),
            "approach_too_far": lambda r: next(l for l in r["lines"] if l.get("event") == "approach_call").update(wm_distance_m=.26),
            "memory_too_short": lambda r: next(l for l in r["lines"] if l.get("event") == "approach_call").update(forward_after_last_observe_cm=29),
            "wrong_track": lambda r: next(l for l in r["lines"] if l.get("event") == "memory_confirmed")["hits"][0].update(track_id="other"),
            "repeated_hit": lambda r: next(l for l in r["lines"] if l.get("event") == "memory_confirmed")["hits"][1].update(pose_x=1.2),
            "outside_window": lambda r: next(l for l in r["lines"] if l.get("event") == "memory_confirmed")["hits"][0].update(distanceCm=91),
            "guard_blocked": lambda r: r["lines"].append({"event": "observe_motion_violation"}),
        }
        baseline = copy.deepcopy(self.raw)
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                self.raw = copy.deepcopy(baseline)
                mutate(self.raw)
                self.assertFalse(self.evaluate()["all_gates_pass"])

    def test_missing_screenshot_fails(self):
        self.frames["frames"].pop()
        self.assertFalse(self.evaluate()["gates"]["driver_keyframes_preserved"])

    def test_static_role_access(self):
        cases = [
            ('mission_objects = mission.get("objects", [])\na = [x for x in mission_objects if x.get("role") == "obstacle"]\n', True),
            ('mission_objects = mission.get("objects", [])\na = [x for x in mission_objects if x.get("role") == "target"]\n', False),
            ('mission_objects = mission.get("objects", [])\nfor x in mission_objects:\n    print(x["roadId"])\n', False),
            ('mission_objects = mission.get("objects", [])\nfor x in mission_objects:\n    if x.get("role") in ("obstacle", "distractor"):\n        print(x["roadId"])\n', True),
            ('obstacle_anchors = [item for item in mission.get("objects", []) if isinstance(item, dict) and item.get("role") == "obstacle"]\nfor item in obstacle_anchors:\n    print(item["roadId"], item.get("progressCm"))\n', True),
        ]
        program = self.folder / "check.py"
        for source, expected in cases:
            with self.subTest(source=source):
                program.write_text(source)
                self.assertEqual(static_checks(program, [self.version])["no_target_anchor_access"]["status"] == "pass", expected)

    def test_real_demo_static_checks_keep_legal_obstacle_anchors(self):
        program = Path(__file__).resolve().parents[2] / "programs/world_model_two_target_demo.py"
        self.assertEqual(static_checks(program, [self.version])["no_target_anchor_access"]["status"], "pass")


if __name__ == "__main__":
    unittest.main()
