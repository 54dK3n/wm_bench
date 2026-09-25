"""Sensor-only Guangyang observations and WorldModel memory.

Dependency: official WorldModel main, fef0ba9b754ce9652836fdb720d1162dcadbc5ef.
The entry point supplies that dependency on sys.path; this module never loads a
map, mission, platform scene, evaluation file, or ground-truth coordinate.
"""
from __future__ import annotations

import copy
import math
from dataclasses import asdict
from typing import Any, Mapping

from world_model.association import associate, build_cost_matrix
from world_model.calibration import CameraCalibration
from world_model.providers.guangyang import (
    guangyang_static_world_model,
    observation_to_detection,
    odometry_to_pose,
)
from world_model.types import Detection, FrameQuality, ObjectState


VERSION = "autonomous-brain-perception/v4"
RANGE_CAL = {"L_cm": 5.1557, "a_cm": 1.6239, "k": 1.0187, "p": 1.0,
             "fit": "M5-calib-range-20260923"}
PUBLIC_TO_WM = {"red-ball": "target", "blue-ball": "distractor",
                "obstacle": "obstacle", "storage-zone": "storage-zone"}
WM_TO_PUBLIC = {value: key for key, value in PUBLIC_TO_WM.items()}
# Frozen detector class specifications, not a layout or an object position.
# vision-pixel-core.js labels its scene units "Meters"; the sensor uses eight
# scene units per metre and displayDistanceCm multiplies by 12.5.
DETECTOR_WIDTH_CM = {"red-ball": 0.44 * 12.5, "blue-ball": 0.44 * 12.5,
                     "obstacle": 0.46 * 12.5}


def _number(value: Any, name: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number


def _wrap_deg(value: float) -> float:
    return (value + 180.0) % 360.0 - 180.0


def calibrate_reading(distance_cm: float, bearing_deg: float) -> tuple[float, float]:
    """Unchanged M5 formula from artifacts/inloop/demo/program.py."""
    beta = math.radians(float(bearing_deg))
    rho = RANGE_CAL["a_cm"] + RANGE_CAL["k"] * float(distance_cm) / (
        math.cos(beta) ** RANGE_CAL["p"])
    forward = RANGE_CAL["L_cm"] + rho * math.cos(beta)
    right = rho * math.sin(beta)
    return math.hypot(forward, right), math.degrees(math.atan2(right, forward))


class Perception:
    """One update per observed frame, with auditable independent-view hits.

    Public categories are red-ball/blue-ball/obstacle/storage-zone. Internal WM
    category names remain target/distractor so the unmodified static profile's
    class-specific decay applies. Distances in objects() are robot-centred;
    bearing_deg is positive to the right. HeadingDeg is positive to the left.
    """

    def __init__(self, camera_parameters: Mapping[str, Any]):
        self.camera = copy.deepcopy(dict(camera_parameters))
        mount = self.camera["mount"]
        self.ground_camera = CameraCalibration(
            image_width=int(self.camera["width"]), image_height=int(self.camera["height"]),
            fx=_number(self.camera["fx"], "fx"), fy=_number(self.camera["fy"], "fy"),
            cx=_number(self.camera["cx"], "cx"), cy=_number(self.camera["cy"], "cy"),
            camera_height_m=_number(mount["upCm"], "mount.upCm") / 100.0,
            camera_x_m=_number(mount["rightCm"], "mount.rightCm") / 100.0,
            camera_z_m=_number(mount["forwardCm"], "mount.forwardCm") / 100.0,
            pitch_rad=-math.radians(_number(mount["pitchDeg"], "mount.pitchDeg")),
            min_ground_range_m=0.0, max_ground_range_m=20.0,
            name="guangyang-bridge-camera", source="camera_parameters",
            is_real_calibration=True,
        )
        # Required explicit range. Do not change the upstream profile or gates.
        self.wm = guangyang_static_world_model(max_range_m=0.9)
        self.pose = self.wm.pose
        self.last_evidence: dict[str, Any] | None = None
        self._history: dict[str, dict[str, Any]] = {}
        self._lifecycle: dict[str, str] = {}
        self._times: dict[str, dict[str, Any]] = {}
        self._accepted_poses: dict[str, list[dict[str, Any]]] = {}
        self._action_evidence: list[dict[str, Any]] = []
        self._delivered_positions: dict[str, dict[str, Any]] = {}
        self._last_timestamp: float | None = None
        self._last_frame: str | None = None

    def _bbox(self, item: Mapping[str, Any]) -> tuple[float, float, float, float]:
        box = item["bbox"]
        x, y, w, h = (_number(box[key], f"bbox.{key}") for key in ("x", "y", "w", "h"))
        if w <= 0 or h <= 0 or x < 0 or y < 0:
            raise ValueError("bbox must have positive extent inside the source frame")
        if x + w > self.camera["width"] or y + h > self.camera["height"]:
            raise ValueError("bbox extends outside the source frame")
        return x, y, w, h

    def _convert(self, item: Mapping[str, Any], frame_id: str,
                 timestamp: float) -> tuple[Detection | None, dict[str, Any]]:
        category = str(item["category"])
        if category not in PUBLIC_TO_WM:
            raise ValueError(f"unsupported category {category!r}")
        source = str(item["source"])
        confidence = _number(item["confidence"], "confidence")
        if not 0 <= confidence <= 1:
            raise ValueError("confidence outside [0,1]")
        x, y, w, h = self._bbox(item)
        evidence: dict[str, Any] = {
            "category": category, "source": source, "confidence": confidence,
            "bbox": {"x": x, "y": y, "w": w, "h": h}, "frame_id": frame_id,
            "fed_to_world_model": False, "track_id": None,
        }
        if category == "storage-zone":
            if source != "storage-ground-pixels":
                raise ValueError("storage-zone must come from ground-region pixels")
            # The midpoint is an observed point of the visible region's bounds,
            # not a claim about the physical zone centre or its complete shape.
            u, v = x + w / 2, y + h / 2
            try:
                local_x, local_z = self.ground_camera.project_pixel_to_ground(u, v)
            except ValueError as exc:
                evidence.update(reason="ground_projection_invalid", detail=str(exc))
                return None, evidence
            distance_cm = math.hypot(local_x, local_z) * 100
            bearing_deg = math.degrees(math.atan2(local_x, local_z))
            world_x, world_z = self.pose.to_world(local_x, local_z)
            det = Detection(class_name="storage-zone", x=world_x, z=world_z,
                            confidence=confidence, source=source, timestamp=timestamp,
                            frame_id=frame_id, bbox=(x, y, x + w, y + h),
                            frame_quality=FrameQuality(frame_id=frame_id,
                                                       calibration_trusted=True))
            evidence.update(method="visible-ground-region-bbox-centre",
                            distance_cm=distance_cm, bearing_deg=bearing_deg,
                            position_m={"x": world_x, "z": world_z},
                            fed_to_world_model=True)
            return det, evidence

        if source != "virtual-cv":
            # YOLO has a different range model; never silently pretend it is CV.
            raise ValueError(f"no calibrated range adapter for {source!r}")
        width = w
        method = "virtual-cv-published-width-formula+M5"
        if category == "obstacle":
            # A stripe becomes a 1.44-wide box, rounded and sometimes clipped.
            # Undo the scale for an approximate location; exact stripe geometry
            # is not recoverable from the bridge's rectangle alone.
            width /= 1.44
            method = "virtual-cv-expanded-obstacle-width-approximation+M5"
        beta = math.atan2(x + w / 2 - self.camera["cx"], self.camera["fx"])
        optical_cm = DETECTOR_WIDTH_CM[category] * self.camera["fy"] / max(1.0, width)
        estimated_cm = min(100.0, max(0.625, optical_cm / max(0.35, math.cos(beta))
                                      + self.camera["mount"]["forwardCm"]))
        # Restore the old *public sensor* reading before M5, not platform truth.
        raw_distance_cm = math.floor(estimated_cm + 0.5)
        raw_bearing_deg = float(f"{math.degrees(beta):.2f}")
        distance_cm, bearing_deg = calibrate_reading(raw_distance_cm, raw_bearing_deg)
        det = observation_to_detection(
            {"category": PUBLIC_TO_WM[category], "confidence": confidence,
             "distanceCm": distance_cm, "bearingDeg": bearing_deg, "frameId": frame_id},
            self.pose, timestamp=timestamp, source=source)
        det.bbox = (x, y, x + w, y + h)
        # Profile confirmation uses the demo's raw 40–90 cm memory window.
        # Near observations remain usable by the action's visual servo, but
        # cannot create additional independent confirmation evidence.
        eligible = 40.0 <= raw_distance_cm < 90.0 and abs(raw_bearing_deg) <= 35.0
        evidence.update(method=method, raw_distance_cm=raw_distance_cm,
                        raw_bearing_deg=raw_bearing_deg, distance_cm=distance_cm,
                        bearing_deg=bearing_deg, position_m={"x": det.x, "z": det.z},
                        fed_to_world_model=eligible,
                        reason=None if eligible else "outside_demo_memory_window")
        return det, evidence

    def update(self, observation: Mapping[str, Any], odometry: Mapping[str, Any], *,
               simulation_time_s: float, round_index: int | None = None) -> dict[str, Any]:
        """Consume only a bridge observation and odometry at its same tick."""
        timestamp = _number(simulation_time_s, "simulation_time_s")
        if self._last_timestamp is not None and timestamp < self._last_timestamp:
            raise ValueError("simulation clock moved backwards")
        if observation["tick"] != odometry["tick"]:
            raise ValueError("observation and odometry must use the same simulation tick")
        if (observation["width"], observation["height"]) != (
                self.camera["width"], self.camera["height"]):
            raise ValueError("observation size differs from camera calibration")
        frame_id = str(observation["frameId"])
        if frame_id == self._last_frame:
            raise ValueError("a camera frame may update WorldModel only once")
        self.pose = odometry_to_pose(odometry)
        converted = [self._convert(item, frame_id, timestamp)
                     for item in observation["detections"]]
        delivered_candidates = []
        for detection_index, (det, item) in enumerate(converted):
            if det is not None:
                for oid, placed in self._delivered_positions.items():
                    if placed["category"] == item["category"]:
                        gap = math.hypot(det.x - placed["position_m"]["x"],
                                         det.z - placed["position_m"]["z"])
                        if gap <= 0.15:
                            delivered_candidates.append((gap, detection_index, oid))
        matched_detections, matched_deliveries = set(), set()
        for gap, detection_index, delivered_id in sorted(delivered_candidates):
            if detection_index in matched_detections or delivered_id in matched_deliveries:
                continue
            matched_detections.add(detection_index)
            matched_deliveries.add(delivered_id)
            # One detection per verified identity per frame. A nearby second
            # object must remain available for normal perception and tracking.
            # A storage rectangle alone never provides exclusion evidence.
            converted[detection_index][1].update(
                known_delivered_object_id=delivered_id, delivered_match_distance_m=gap,
                fed_to_world_model=False, reason="matches_verified_placement",
                track_id=delivered_id)
        detections = [det for det, item in converted if det is not None and item["fed_to_world_model"]]
        evidence_items = [item for det, item in converted if det is not None and item["fed_to_world_model"]]
        old_tracks = self.wm.get_scene()
        old_hits = {track.obj_id: track.hit_count for track in old_tracks}
        assignments = associate(old_tracks, detections, self.wm.aliases,
                                self.wm.assoc_cfg, now=timestamp)
        # A current near-field detection is positive visibility evidence even
        # though its extrapolated range cannot add a confirmation sample. Only
        # an already CONFIRMED identity with an unambiguous match is refreshed.
        # Compare against every active identity, including tentative neighbours.
        near = [(det, item) for det, item in converted
                if det is not None and not item["fed_to_world_model"]
                and not item.get("known_delivered_object_id")
                and item.get("raw_distance_cm", math.inf) < 40
                and abs(item.get("raw_bearing_deg", math.inf)) <= 35]
        if old_tracks and near:
            costs = build_cost_matrix(old_tracks, [det for det, _ in near], self.wm.aliases,
                                      self.wm.assoc_cfg, now=timestamp)
            eligible_matches = {track_index for track_index, _ in assignments.matches}
            for track_index, track in enumerate(old_tracks):
                if track.state != ObjectState.CONFIRMED or track_index in eligible_matches:
                    continue
                candidates = [index for index, cost in enumerate(costs[track_index])
                              if math.isfinite(cost)]
                if len(candidates) != 1:
                    continue
                detection_index = candidates[0]
                possible_tracks = [index for index, row in enumerate(costs)
                                   if math.isfinite(row[detection_index])]
                if possible_tracks != [track_index]:
                    continue
                det, item = near[detection_index]
                # No position/size/confidence/state/hits are changed. Giving the
                # observed track this frame's timestamp prevents apply_decay()
                # from counting this genuine near sighting as a missed frame.
                track.last_seen = timestamp
                track.last_updated = timestamp
                track.last_bbox = det.bbox
                track.last_frame_id = det.frame_id
                track.last_frame_quality = det.frame_quality
                track.source = det.source
                item.update(track_id=track.obj_id, visibility_refresh_only=True,
                            reason="near_field_visibility_for_existing_confirmation")
        self.wm.update(detections, self.pose, now=timestamp)
        for track_idx, det_idx in assignments.matches:
            evidence_items[det_idx]["track_id"] = old_tracks[track_idx].obj_id
        new_tracks = [track for track in self.wm.get_scene() if track.obj_id not in old_hits]
        for det_idx, track in zip(assignments.unmatched_detections, new_tracks):
            evidence_items[det_idx]["track_id"] = track.obj_id

        # Match near/out-of-window observations to already known tracks without
        # feeding them into WM or incrementing its hit count.
        already_assigned = {item["track_id"] for _, item in converted if item["track_id"] is not None}
        available = [track for track in self.wm.get_scene()
                     if track.obj_id not in already_assigned]
        unfed = [(det, item) for det, item in converted
                 if det is not None and not item["fed_to_world_model"]
                 and not item.get("known_delivered_object_id")
                 and not item.get("visibility_refresh_only")]
        if available and unfed:
            near_matches = associate(available, [det for det, _ in unfed], self.wm.aliases,
                                     self.wm.assoc_cfg, now=timestamp)
            for track_idx, det_idx in near_matches.matches:
                unfed[det_idx][1]["track_id"] = available[track_idx].obj_id

        newly_confirmed = []
        for track in self.wm.get_scene():
            oid = track.obj_id
            times = self._times.setdefault(oid, {"object_id": oid,
                "category": WM_TO_PUBLIC.get(track.name, track.name),
                "first_seen_s": track.first_seen, "first_seen_round": round_index,
                "confirmed_s": None, "picked_s": None, "delivered_s": None})
            if track.hit_count > old_hits.get(oid, 0):
                self._accepted_poses.setdefault(oid, []).append({
                    "frame_id": frame_id, "simulation_time_s": timestamp,
                    "x_m": self.pose.x, "z_m": self.pose.z,
                    "heading_deg": -math.degrees(self.pose.yaw_rad)})
            if track.state == ObjectState.CONFIRMED and times["confirmed_s"] is None:
                times["confirmed_s"] = timestamp
                times["confirmed_round"] = round_index
                newly_confirmed.append(oid)
            self._history[oid] = self._row(track)
        self._last_timestamp, self._last_frame = timestamp, frame_id
        self.last_evidence = {
            "version": VERSION, "frame_id": frame_id, "tick": observation["tick"],
            "simulation_time_s": timestamp, "round": round_index,
            "world_model_pose": asdict(self.pose),
            "coordinate_convention": "x right, z forward in initial odometry frame; yaw/bearing right positive",
            "raw_observation": copy.deepcopy(dict(observation)),
            "odometry": copy.deepcopy(dict(odometry)),
            "detections": [item for _, item in converted],
            "newly_confirmed": newly_confirmed,
        }
        return copy.deepcopy(self.last_evidence)

    def _row(self, track: Any) -> dict[str, Any]:
        local_x, local_z = self.pose.to_local(track.x, track.z)
        return {"id": track.obj_id, "category": WM_TO_PUBLIC.get(track.name, track.name),
                "position_m": {"x": track.x, "z": track.z},
                "confidence": track.confidence,
                "state": self._lifecycle.get(track.obj_id, track.state.value.upper()),
                "distance_cm": math.hypot(local_x, local_z) * 100.0,
                "bearing_deg": _wrap_deg(math.degrees(math.atan2(local_x, local_z))),
                "hit_count": track.hit_count, "source": track.source,
                "last_seen_s": track.last_seen,
                "hit_poses": copy.deepcopy(self._accepted_poses.get(track.obj_id, []))}

    def objects(self) -> list[dict[str, Any]]:
        """Include lost/action-removed history, so forgetting cannot mean done."""
        rows = []
        for oid in self._history:
            track = self.wm.get_object(oid, include_lost=True)
            if track is not None:
                rows.append(self._row(track))
        return rows

    def get_object(self, object_id: str) -> dict[str, Any] | None:
        return next((row for row in self.objects() if row["id"] == object_id), None)

    def confirmed(self, object_id: str) -> dict[str, Any] | None:
        row = self.get_object(object_id)
        return row if row is not None and row["state"] == "CONFIRMED" else None

    def visible(self, object_id: str) -> dict[str, Any] | None:
        if self.last_evidence is None:
            return None
        return next((copy.deepcopy(item) for item in self.last_evidence["detections"]
                     if item["track_id"] == object_id), None)

    def mark_picked(self, object_id: str, *, holding: bool, original_position_absent: bool,
                    simulation_time_s: float, evidence: Mapping[str, Any]) -> bool:
        if not holding or not original_position_absent or not evidence:
            return False
        row = self.get_object(object_id)
        if row is None or self._times[object_id]["confirmed_s"] is None:
            return False
        if self._lifecycle.get(object_id) in ("HELD", "DELIVERED", "RELEASED_UNVERIFIED"):
            return False
        timestamp = _number(simulation_time_s, "simulation_time_s")
        if not self.wm.mark_removed(object_id, now=timestamp):
            return False
        self._lifecycle[object_id] = "HELD"
        self._times[object_id]["picked_s"] = timestamp
        self._times[object_id]["original_position_m"] = copy.deepcopy(row["position_m"])
        self._action_evidence.append({"action": "pick", "object_id": object_id,
            "simulation_time_s": timestamp, "holding": True,
            "original_position_absent": True, "evidence": copy.deepcopy(dict(evidence))})
        return True

    def mark_delivered(self, object_id: str, *, holding: bool, ball_in_storage: bool,
                       simulation_time_s: float, evidence: Mapping[str, Any]) -> bool:
        if holding or not ball_in_storage or not evidence:
            return False
        if self._lifecycle.get(object_id) != "HELD":
            return False
        placement = evidence.get("placement")
        if not isinstance(placement, Mapping) or not placement.get("frame_id"):
            return False
        if not all(key in placement for key in ("ball_position_m", "ball_bbox", "storage_bbox")):
            return False
        position = {key: _number(placement["ball_position_m"][key], f"ball_position_m.{key}")
                    for key in ("x", "z")}
        self._bbox({"bbox": placement["ball_bbox"]})
        self._bbox({"bbox": placement["storage_bbox"]})
        timestamp = _number(simulation_time_s, "simulation_time_s")
        self.wm.mark_removed(object_id, now=timestamp)
        track = self.wm.get_object(object_id, include_lost=True)
        # The archived identity moves only with verified action/visual evidence.
        # Its original observation position and confirmation views stay logged.
        track.x, track.z = position["x"], position["z"]
        track.last_bbox = tuple(placement["ball_bbox"][key] for key in ("x", "y")) + (
            placement["ball_bbox"]["x"] + placement["ball_bbox"]["w"],
            placement["ball_bbox"]["y"] + placement["ball_bbox"]["h"])
        track.last_frame_id = str(placement["frame_id"])
        track.last_seen = timestamp
        self._delivered_positions[object_id] = {
            "category": WM_TO_PUBLIC.get(track.name, track.name),
            "position_m": position, "frame_id": str(placement["frame_id"])}
        self._lifecycle[object_id] = "DELIVERED"
        self._times[object_id]["delivered_s"] = timestamp
        self._times[object_id]["delivered_position_m"] = copy.deepcopy(position)
        self._action_evidence.append({"action": "place", "object_id": object_id,
            "simulation_time_s": timestamp, "holding": False,
            "ball_in_storage": True, "evidence": copy.deepcopy(dict(evidence))})
        return True

    def mark_release_unverified(self, object_id: str, *, simulation_time_s: float,
                                evidence: Mapping[str, Any]) -> bool:
        """Empty gripper without containment evidence is not a delivery."""
        if evidence.get("holding") is not False or self._lifecycle.get(object_id) != "HELD":
            return False
        timestamp = _number(simulation_time_s, "simulation_time_s")
        self.wm.mark_removed(object_id, now=timestamp)
        self._lifecycle[object_id] = "RELEASED_UNVERIFIED"
        self._times[object_id]["released_unverified_s"] = timestamp
        self._action_evidence.append({"action": "release_unverified", "object_id": object_id,
            "simulation_time_s": timestamp, "holding": False,
            "evidence": copy.deepcopy(dict(evidence))})
        return True

    def timeline(self) -> list[dict[str, Any]]:
        return [dict(copy.deepcopy(value),
                     accepted_hit_poses=copy.deepcopy(self._accepted_poses.get(oid, [])))
                for oid, value in self._times.items()]

    def action_evidence(self) -> list[dict[str, Any]]:
        return copy.deepcopy(self._action_evidence)
