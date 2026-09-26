"""Sensor conversion, independent-view confirmation, and action evidence tests."""
import copy
import math
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(os.environ.get("WORLD_MODEL_ROOT", ROOT / "vendor/wm_kit_opt2"))))
sys.path.insert(0, str(ROOT))

from autonomous_brain.perception import Perception, calibrate_reading


CAMERA = {"width": 640, "height": 480, "fx": 240 / math.tan(math.pi / 6),
          "fy": 240 / math.tan(math.pi / 6), "cx": 320, "cy": 240,
          "verticalFovDeg": 60,
          "mount": {"forwardCm": 5.375, "rightCm": 0, "upCm": 8.0625, "pitchDeg": -8}}


def ball(reading=80, category="red-ball", bearing=0):
    """Construct a public bbox for a specified frozen detector sensor reading."""
    beta = math.radians(bearing)
    width = 5.5 * CAMERA["fy"] / ((reading - 5.375) * math.cos(beta))
    cx = CAMERA["cx"] + CAMERA["fx"] * math.tan(beta)
    return {"category": category, "source": "virtual-cv", "confidence": .92,
            "bbox": {"x": cx - width / 2, "y": 245, "w": width, "h": width}}


def observe(perception, frame, forward=0, *, items=None, heading=0, right=0, time=None):
    observation = {"frameId": str(frame), "tick": frame, "width": 640, "height": 480,
                   "detections": items if items is not None else [ball(80 - forward)]}
    odometry = {"tick": frame, "forwardCm": forward, "rightCm": right,
                "headingDeg": heading, "distanceCm": math.hypot(forward, right)}
    return perception.update(observation, odometry,
                             simulation_time_s=frame / 10 if time is None else time,
                             round_index=frame)


def placement_evidence(perception, object_id):
    """Make a fresh release witness through the public sensor conversion path."""
    preexisting = [row["id"] for row in perception.objects()
                   if row["category"] == "red-ball" and row["id"] != object_id]
    zone = {"category": "storage-zone", "source": "storage-ground-pixels", "confidence": 1,
            "bbox": {"x": 240, "y": 230, "w": 160, "h": 100}}
    observed = observe(perception, 4, time=2, items=[ball(60), zone])
    witness, storage = observed["detections"]
    return {"holding": False, "candidate_witnesses": 1,
            "release_observation": {"frame_id": "4", "simulation_time_s": 2,
                                    "preexisting_ball_ids": preexisting},
            "placement": {"ball_track_id": witness["track_id"], "ball_category": witness["category"],
                          "ball_position_m": copy.deepcopy(witness["position_m"]), "frame_id": "4",
                          "ball_bbox": copy.deepcopy(witness["bbox"]),
                          "storage_bbox": copy.deepcopy(storage["bbox"])}}


def grasp_evidence(perception, object_id, *, time=None):
    """Build the old-position absence witness from an actual empty sensor frame."""
    if time is not None:
        odo = perception.last_evidence["odometry"]
        observe(perception, "pick-proof-" + str(perception.last_evidence["frame_id"]),
                odo["forwardCm"], right=odo["rightCm"], heading=odo["headingDeg"],
                time=time, items=[])
    row = perception.get_object(object_id)
    original = (row["position_m"]["x"], row["position_m"]["z"])
    return {"holding": True, "frame_id": perception.last_evidence["frame_id"],
            "original_position_observation": perception.original_position_evidence(original, row["category"])}


class PerceptionTests(unittest.TestCase):
    def setUp(self):
        self.perception = Perception(CAMERA)

    def confirm_red(self):
        for frame, forward in enumerate((0, 16, 32), 1):
            observe(self.perception, frame, forward)
        return self.perception.objects()[0]["id"]

    def test_static_main_profile_and_required_range(self):
        wm = self.perception.wm
        self.assertEqual(wm.fov_cfg.max_range_m, .9)
        self.assertEqual(wm.assoc_cfg.min_hit_pose_gap_m, .15)
        self.assertEqual(wm.decay_cfg.confirm_hits, 3)
        self.assertTrue(wm.assoc_cfg.static_equal_weight)
        self.assertEqual(wm.assoc_cfg.max_gate_distance_m, .3)

    def test_same_position_rotations_do_not_confirm(self):
        for frame in range(1, 6):
            # A changed direction and correspondingly shifted image describe
            # one static object, but the robot has not translated.
            heading = frame * 2
            observe(self.perception, frame, heading=heading,
                    items=[ball(80, bearing=heading)])
        rows = self.perception.objects()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["state"], "TENTATIVE")
        self.assertEqual(rows[0]["hit_count"], 1)
        self.assertEqual(len(rows[0]["hit_poses"]), 1)

    def test_three_separated_views_confirm_same_track(self):
        object_id = self.confirm_red()
        row = self.perception.confirmed(object_id)
        self.assertIsNotNone(row)
        self.assertEqual(row["hit_count"], 3)
        self.assertEqual(row["category"], "red-ball")
        self.assertEqual(row["source"], "virtual-cv")
        positions = row["hit_poses"]
        for a in positions:
            for b in positions:
                if a is not b:
                    self.assertGreaterEqual(math.hypot(a["x_m"]-b["x_m"], a["z_m"]-b["z_m"]), .15)
        timeline = self.perception.timeline()[0]
        self.assertEqual(timeline["first_seen_s"], .1)
        self.assertEqual(timeline["confirmed_s"], .3)

    def test_near_views_cannot_create_or_confirm_tracks(self):
        observe(self.perception, 1)
        for frame, forward in ((2, 45), (3, 61)):
            evidence = observe(self.perception, frame, forward)
            self.assertFalse(evidence["detections"][0]["fed_to_world_model"])
        row = self.perception.objects()[0]
        self.assertEqual(row["hit_count"], 1)
        self.assertIsNone(self.perception.confirmed(row["id"]))
        self.assertEqual(self.perception.visible(row["id"])["raw_distance_cm"], 19)

    def test_range_and_bearing_reconstruction_and_m5(self):
        evidence = observe(self.perception, 1, items=[ball(60, bearing=20)])
        item = evidence["detections"][0]
        self.assertEqual(item["raw_distance_cm"], 60)
        self.assertEqual(item["raw_bearing_deg"], 20)
        # Published M5: forward = 5.1557 + 1.6239 cos(beta) + 1.0187 d.
        beta = math.radians(20)
        expected_z = (5.1557 + 1.6239 * math.cos(beta) + 1.0187 * 60) / 100
        expected_x = (1.6239 + 1.0187 * 60 / math.cos(beta)) * math.sin(beta) / 100
        self.assertAlmostEqual(item["position_m"]["x"], expected_x)
        self.assertAlmostEqual(item["position_m"]["z"], expected_z)
        self.assertEqual(item["source"], "virtual-cv")

    def test_heading_sign_is_converted_once(self):
        evidence = observe(self.perception, 1, heading=90, right=100, forward=200,
                           items=[ball(80)])
        position = evidence["detections"][0]["position_m"]
        corrected_cm, _ = calibrate_reading(80, 0)
        self.assertAlmostEqual(position["x"], 1 - corrected_cm / 100)
        self.assertAlmostEqual(position["z"], 2)
        self.assertAlmostEqual(self.perception.objects()[0]["bearing_deg"], 0)

    def test_ground_storage_uses_camera_projection_not_sign_width(self):
        item = {"category": "storage-zone", "source": "storage-ground-pixels",
                "confidence": 1, "bbox": {"x": 295, "y": 300, "w": 50, "h": 40}}
        evidence = observe(self.perception, 1, items=[item])["detections"][0]
        expected_x, expected_z = self.perception.ground_camera.project_pixel_to_ground(320, 320)
        self.assertEqual(evidence["method"], "visible-ground-region-bbox-centre")
        self.assertEqual(evidence["position_m"], {"x": expected_x, "z": expected_z})
        self.assertNotIn("raw_distance_cm", evidence)

    def test_confirmation_class_identity_and_no_hidden_distance_consumption(self):
        red = ball()
        red.update(distanceCm=999999, bearingDeg=-170, truth={"x": 99999})
        evidence = observe(self.perception, 1, items=[red, ball(60, "blue-ball", 20)])
        self.assertEqual(evidence["detections"][0]["raw_distance_cm"], 80)
        self.assertEqual(evidence["detections"][0]["raw_bearing_deg"], 0)
        self.assertEqual({x["category"] for x in self.perception.objects()}, {"red-ball", "blue-ball"})

    def test_unknown_detector_is_not_relabeled_or_silently_accepted(self):
        item = ball()
        item["source"] = "yolo"
        with self.assertRaisesRegex(ValueError, "no calibrated range adapter"):
            observe(self.perception, 1, items=[item])

    def test_tick_mismatch_and_reused_frame_rejected(self):
        observation = {"frameId": "1", "tick": 10, "width": 640, "height": 480, "detections": []}
        with self.assertRaisesRegex(ValueError, "same simulation tick"):
            self.perception.update(observation, {"tick": 11}, simulation_time_s=1)
        observe(self.perception, 1)
        with self.assertRaisesRegex(ValueError, "only once"):
            observe(self.perception, 1)

    def test_pick_and_place_require_separate_post_observation_evidence(self):
        oid = self.confirm_red()
        for holding, absent in ((False, True), (True, False)):
            self.assertFalse(self.perception.mark_picked(oid, holding=holding,
                original_position_absent=absent, simulation_time_s=1, evidence={"frame_id": "post"}))
        self.assertFalse(self.perception.mark_picked(oid, holding=True,
            original_position_absent=True, simulation_time_s=1, evidence={}))
        self.assertTrue(self.perception.mark_picked(oid, holding=True,
            original_position_absent=True, simulation_time_s=1,
            evidence=grasp_evidence(self.perception, oid, time=1)))
        self.assertEqual(self.perception.get_object(oid)["state"], "HELD")
        self.assertIsNone(self.perception.confirmed(oid))
        for holding, inside in ((True, True), (False, False)):
            self.assertFalse(self.perception.mark_delivered(oid, holding=holding,
                ball_in_storage=inside, simulation_time_s=2, evidence={"frame_id": "placed"}))
        self.assertTrue(self.perception.mark_delivered(oid, holding=False,
            ball_in_storage=True, simulation_time_s=2, evidence=placement_evidence(self.perception, oid)))
        self.assertEqual(self.perception.get_object(oid)["state"], "DELIVERED")
        self.assertEqual(self.perception.timeline()[0]["picked_s"], 1)
        self.assertEqual(self.perception.timeline()[0]["delivered_s"], 2)
        self.assertEqual(len(self.perception.action_evidence()), 2)

    def test_verified_placement_moves_archive_and_only_excludes_same_nearby_class(self):
        oid = self.confirm_red()
        original = self.perception.get_object(oid)["position_m"]
        self.perception.mark_picked(oid, holding=True, original_position_absent=True,
                                   simulation_time_s=1, evidence=grasp_evidence(self.perception, oid, time=1))
        placed = {"x": 0.0, "z": calibrate_reading(60, 0)[0] / 100}
        self.assertFalse(self.perception.mark_delivered(oid, holding=False, ball_in_storage=True,
            simulation_time_s=2, evidence={"holding": False, "placement": {"frame_id": "incomplete"}}))
        self.assertTrue(self.perception.mark_delivered(oid, holding=False, ball_in_storage=True,
            simulation_time_s=2, evidence=placement_evidence(self.perception, oid)))
        self.assertEqual(self.perception.get_object(oid)["position_m"], placed)
        timeline = self.perception.timeline()[0]
        self.assertEqual(timeline["original_position_m"], original)
        self.assertEqual(timeline["delivered_position_m"], placed)
        evidence = observe(self.perception, 5, right=14, time=3,
                           items=[ball(60), ball(60, "blue-ball")])
        red, blue = evidence["detections"]
        self.assertEqual(red["known_delivered_object_id"], oid)
        self.assertFalse(red["fed_to_world_model"])
        self.assertEqual(red["track_id"], oid)
        self.assertNotIn("known_delivered_object_id", blue)
        self.assertTrue(blue["fed_to_world_model"])
        evidence = observe(self.perception, 6, right=16, time=3.1, items=[ball(60)])
        self.assertNotIn("known_delivered_object_id", evidence["detections"][0])
        self.assertTrue(evidence["detections"][0]["fed_to_world_model"])
        self.assertEqual(len([row for row in self.perception.objects()
                              if row["category"] in {"red-ball", "blue-ball"}]), 3)
        self.assertEqual(self.perception.get_object(oid)["state"], "DELIVERED")

    def test_unverified_release_never_claims_delivery_or_suppresses_reobservation(self):
        oid = self.confirm_red()
        self.perception.mark_picked(oid, holding=True, original_position_absent=True,
                                   simulation_time_s=1, evidence=grasp_evidence(self.perception, oid, time=1))
        for evidence in ({}, {"holding": True}, {"holding": 0}):
            self.assertFalse(self.perception.mark_release_unverified(
                oid, simulation_time_s=2, evidence=evidence))
        self.assertTrue(self.perception.mark_release_unverified(oid, simulation_time_s=2,
            evidence={"holding": False, "frame_id": "released", "strict_pixel_inside": False}))
        self.assertEqual(self.perception.get_object(oid)["state"], "RELEASED_UNVERIFIED")
        self.assertIsNone(self.perception.timeline()[0]["delivered_s"])
        self.assertEqual(self.perception.timeline()[0]["released_unverified_s"], 2)
        evidence = observe(self.perception, 4, time=3, items=[ball(80)])
        self.assertTrue(evidence["detections"][0]["fed_to_world_model"])
        self.assertNotIn("known_delivered_object_id", evidence["detections"][0])
        self.assertNotEqual(evidence["detections"][0]["track_id"], oid)

    def test_one_delivery_cannot_suppress_two_nearby_balls_in_one_frame(self):
        oid = self.confirm_red()
        self.perception.mark_picked(oid, holding=True, original_position_absent=True,
                                   simulation_time_s=1, evidence=grasp_evidence(self.perception, oid, time=1))
        placed = {"x": 0.0, "z": calibrate_reading(60, 0)[0] / 100}
        self.assertTrue(self.perception.mark_delivered(oid, holding=False, ball_in_storage=True,
            simulation_time_s=2, evidence=placement_evidence(self.perception, oid)))
        # Both detections lie within 15 cm of the known delivered ball. The
        # closer one is second in input order, but proximity cannot resolve
        # which physical ball produced either observation.
        evidence = observe(self.perception, 5, time=3,
                           items=[ball(60, bearing=5), ball(60)])
        unplaced, delivered = evidence["detections"]
        self.assertNotIn("known_delivered_object_id", unplaced)
        self.assertTrue(unplaced["fed_to_world_model"])
        self.assertIsNotNone(unplaced["track_id"])
        self.assertNotEqual(unplaced["track_id"], oid)
        self.assertNotIn("known_delivered_object_id", delivered)
        self.assertTrue(delivered["fed_to_world_model"])
        self.assertTrue(all(oid in d["identity_ambiguity"]["candidate_ids"]
                            for d in (unplaced, delivered)))
        self.assertEqual(len([row for row in self.perception.objects() if row["category"] == "red-ball"]), 3)

    def test_near_visibility_preserves_existing_confirmation_without_new_hits_or_geometry(self):
        oid = self.confirm_red()
        original = self.perception.get_object(oid)
        for frame, time, forward in ((4, 3, 60), (5, 6, 62), (6, 9, 64)):
            evidence = observe(self.perception, frame, forward, time=time)
            detection = evidence["detections"][0]
            self.assertTrue(detection["visibility_refresh_only"])
            self.assertFalse(detection["fed_to_world_model"])
            self.assertEqual(detection["track_id"], oid)
            current = self.perception.get_object(oid)
            self.assertEqual(current["state"], "CONFIRMED")
            self.assertEqual(current["confidence"], original["confidence"])
            self.assertEqual(current["position_m"], original["position_m"])
            self.assertEqual(current["hit_count"], 3)
            self.assertEqual(current["hit_poses"], original["hit_poses"])
            self.assertEqual(current["last_seen_s"], time)

    def test_tentative_and_stale_tracks_cannot_be_confirmed_by_near_visibility(self):
        observe(self.perception, 1)
        oid = self.perception.objects()[0]["id"]
        evidence = observe(self.perception, 2, 60, time=3)
        self.assertNotIn("visibility_refresh_only", evidence["detections"][0])
        self.assertIsNone(self.perception.confirmed(oid))
        self.assertEqual(self.perception.get_object(oid)["hit_count"], 1)
        self.perception = Perception(CAMERA)
        oid = self.confirm_red()
        observe(self.perception, 4, 60, time=2, items=[])
        self.assertEqual(self.perception.get_object(oid)["state"], "STALE")
        evidence = observe(self.perception, 5, 60, time=2.1)
        self.assertNotIn("visibility_refresh_only", evidence["detections"][0])
        self.assertEqual(self.perception.get_object(oid)["state"], "STALE")

    def test_multiple_near_detections_do_not_refresh_one_ambiguous_track(self):
        oid = self.confirm_red()
        evidence = observe(self.perception, 4, 60, time=3,
                           items=[ball(20, bearing=-3), ball(20, bearing=3)])
        self.assertTrue(all(not item.get("visibility_refresh_only") for item in evidence["detections"]))
        self.assertNotEqual(self.perception.get_object(oid)["state"], "CONFIRMED")
        self.assertEqual(self.perception.get_object(oid)["last_seen_s"], .3)

    def test_one_near_detection_does_not_refresh_multiple_plausible_tracks(self):
        first = self.confirm_red()
        for frame, forward in ((4, 0), (5, 16), (6, 32)):
            observe(self.perception, frame, forward, right=50)
        tracks = self.perception.objects()
        self.assertEqual(len(tracks), 2)
        self.assertTrue(all(row["state"] == "CONFIRMED" for row in tracks))
        before = {row["id"]: row for row in tracks}
        evidence = observe(self.perception, 7, 60, right=25, time=4)
        self.assertNotIn("visibility_refresh_only", evidence["detections"][0])
        for row in self.perception.objects():
            self.assertLess(row["confidence"], before[row["id"]]["confidence"])
            self.assertEqual(row["last_seen_s"], before[row["id"]]["last_seen_s"])

    def test_unseen_and_far_out_of_window_observations_still_decay(self):
        oid = self.confirm_red()
        evidence = observe(self.perception, 4, 60, time=3, items=[ball(95)])
        self.assertNotIn("visibility_refresh_only", evidence["detections"][0])
        self.assertNotEqual(self.perception.get_object(oid)["state"], "CONFIRMED")
        self.assertEqual(self.perception.get_object(oid)["last_seen_s"], .3)

    def test_lost_history_is_retained_for_decision_making(self):
        observe(self.perception, 1)
        observe(self.perception, 2, items=[], time=20)
        self.assertEqual(len(self.perception.objects()), 1)
        self.assertEqual(self.perception.objects()[0]["state"], "LOST")


if __name__ == "__main__":
    unittest.main()
