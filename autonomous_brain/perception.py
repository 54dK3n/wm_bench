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

from world_model.association import associate, build_cost_matrix, gate_for
from world_model.calibration import CameraCalibration
from world_model.providers.guangyang import (
    guangyang_static_world_model,
    observation_to_detection,
    odometry_to_pose,
)
from world_model.types import Detection, FrameQuality, ObjectState

from .actions import ball_inside_region


VERSION = "autonomous-brain-perception/v8"
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
        self._delivery_aliases: dict[str, str] = {}
        self._unverified_releases: dict[str, dict[str, Any]] = {}
        self._reacquisitions: dict[str, dict[str, Any]] = {}
        self._observed_frames: dict[str, dict[str, Any]] = {}
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
        # The frozen upstream provider's registry is in scene-unit widths
        # labelled metres. Correct only this adapter's physical size contract;
        # do not mutate its association profile or the upstream source.
        det.radius_cm = DETECTOR_WIDTH_CM[category] / 2
        evidence["physical_size"] = {"diameter_cm": DETECTOR_WIDTH_CM[category],
                                     "radius_cm": det.radius_cm,
                                     "source": "virtual-cv-scene-unit-adapter/v1"}
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
        if frame_id in self._observed_frames:
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
                "first_seen_frame_id": frame_id,
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
        self._bind_reacquisitions(converted, frame_id, timestamp)
        self._last_timestamp, self._last_frame = timestamp, frame_id
        self._observed_frames[frame_id] = {"index": len(self._observed_frames),
                                          "simulation_time_s": timestamp}
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

    def _bind_reacquisitions(self, converted, frame_id: str, timestamp: float) -> None:
        """Link independent confirmations without reviving or merging WM tracks.

        The official static profile archives LOST IDs permanently. A new track
        must acquire its own confirmation before it can explain an old identity.
        Use the unchanged association gate over a complete competing snapshot;
        even a tentative neighbour prevents a supposedly unique binding. This
        is a data-association hypothesis, not proof of physical identity.
        """
        seen = {item["track_id"] for _, item in converted
                if item["fed_to_world_model"] and item["track_id"] is not None}
        # An already bound ancestor belongs to its successor's hypothesis chain.
        # All other history, including never-confirmed archives and manipulated
        # objects, remains in the competition graph (but cannot be a source).
        tracks = [track for oid in self._history if oid not in self._reacquisitions
                  and oid not in self._delivery_aliases
                  if (track := self.wm.get_object(oid, include_lost=True)) is not None]
        detections = [Detection(class_name=track.name, x=track.x, z=track.z,
                                confidence=track.confidence, timestamp=timestamp,
                                frame_id=frame_id, source=track.source)
                      for track in tracks]
        costs = build_cost_matrix(tracks, detections, self.wm.aliases,
                                  self.wm.assoc_cfg, now=timestamp)
        # Determine every candidate against this one frozen snapshot. Do not
        # remove a competitor after accepting an earlier pair in the batch.
        neighbours = {track.obj_id: [other.obj_id for j, other in enumerate(tracks)
                                    if j != i and math.isfinite(costs[i][j])]
                      for i, track in enumerate(tracks)}
        existing_successors = {binding["current_object_id"]
                               for binding in self._reacquisitions.values()}
        planned = []
        for old in tracks:
            old_id = old.obj_id
            old_time = self._times.get(old_id, {})
            if (WM_TO_PUBLIC.get(old.name) != "red-ball"
                    or self.wm.get_archived(old_id) is not old
                    or old.state != ObjectState.LOST
                    or old_time.get("confirmed_s") is None
                    or old_id in self._lifecycle
                    or len(neighbours[old_id]) != 1):
                continue
            current_id = neighbours[old_id][0]
            current = next(track for track in tracks if track.obj_id == current_id)
            current_time = self._times.get(current_id, {})
            poses = self._accepted_poses.get(current_id, [])
            required_hits = self.wm.decay_cfg.confirm_hits
            gap = self.wm.assoc_cfg.min_hit_pose_gap_m
            if (neighbours[current_id] != [old_id]
                    or current_id in existing_successors or current_id not in seen
                    or current_id in self._lifecycle
                    or current.state != ObjectState.CONFIRMED
                    or current_time.get("confirmed_s") is None
                    or current.first_seen <= old.last_seen
                    or current.hit_count < required_hits or len(poses) < required_hits
                    or any(math.hypot(a["x_m"] - b["x_m"], a["z_m"] - b["z_m"]) < gap
                           for index, a in enumerate(poses) for b in poses[:index])):
                continue
            binding = {
                "version": "world-model-reacquisition/v1",
                "historical_object_id": old_id, "current_object_id": current_id,
                "evidence": {
                    "association": "unchanged_world_model_gate_bidirectionally_unique",
                    "frame_id": frame_id, "simulation_time_s": timestamp,
                    "historical_position_m": {"x": old.x, "z": old.z},
                    "current_position_m": {"x": current.x, "z": current.z},
                    "distance_m": math.hypot(old.x - current.x, old.z - current.z),
                    "gate_distance_m": gate_for(old, timestamp, self.wm.assoc_cfg),
                    "historical_confirmed_s": old_time["confirmed_s"],
                    "current_confirmed_s": current_time["confirmed_s"],
                    "current_hit_poses": copy.deepcopy(poses),
                    "competing_identity_ids": [track.obj_id for track in tracks],
                    "historical_candidates": list(neighbours[old_id]),
                    "current_candidates": list(neighbours[current_id]),
                },
            }
            planned.append(binding)
        for binding in planned:
            self._reacquisitions[binding["historical_object_id"]] = binding

    def reacquisition_bindings(self) -> list[dict[str, Any]]:
        """Return detached evidence; neither query nor binding changes WM IDs."""
        return copy.deepcopy(list(self._reacquisitions.values()))

    def _row(self, track: Any) -> dict[str, Any]:
        local_x, local_z = self.pose.to_local(track.x, track.z)
        row = {"id": track.obj_id, "category": WM_TO_PUBLIC.get(track.name, track.name),
                "position_m": {"x": track.x, "z": track.z},
                "confidence": track.confidence,
                "state": self._lifecycle.get(track.obj_id, track.state.value.upper()),
                "distance_cm": math.hypot(local_x, local_z) * 100.0,
                "bearing_deg": _wrap_deg(math.degrees(math.atan2(local_x, local_z))),
                "hit_count": track.hit_count, "source": track.source,
                "radius_cm": track.radius_cm,
                "last_seen_s": track.last_seen,
                "hit_poses": copy.deepcopy(self._accepted_poses.get(track.obj_id, []))}
        if track.obj_id in self._reacquisitions:
            row["reacquisition_binding"] = copy.deepcopy(self._reacquisitions[track.obj_id])
        if row["category"] == "red-ball":
            times = self._times.get(track.obj_id, {})
            known_confirmation_history = "confirmed_s" in times
            row["ever_confirmed"] = (times["confirmed_s"] is not None
                                     if known_confirmation_history else None)
            row["completion_classification"] = ("delivered" if row["state"] == "DELIVERED"
                                                else "pending")
            # Archival without any confirmation closes an uncertain hypothesis,
            # not a physical object. Preserve its LOST state and all raw history.
            # Unknown history and any manipulation lifecycle remain obligations.
            if (track.state == ObjectState.LOST
                    and self.wm.get_archived(track.obj_id) is track
                    and known_confirmation_history and times["confirmed_s"] is None
                    and isinstance(times.get("first_seen_frame_id"), str)
                    and bool(times["first_seen_frame_id"])
                    and track.obj_id not in self._lifecycle):
                row["completion_classification"] = "retired_unconfirmed_hypothesis"
                row["retirement_evidence"] = {
                    "reason": "archived_without_confirmation", "archived": True,
                    "confirmed_s": None, "first_seen_s": track.first_seen,
                    "last_seen_s": track.last_seen, "last_updated_s": track.last_updated,
                    "first_seen_frame_id": times["first_seen_frame_id"],
                    "last_frame_id": track.last_frame_id,
                    "hit_count": track.hit_count, "confidence": track.confidence}
        return row

    def objects(self) -> list[dict[str, Any]]:
        """Keep lost history, but count a verified release alias only once."""
        rows = []
        for oid in self._history:
            if oid in self._delivery_aliases:
                continue
            track = self.wm.get_object(oid, include_lost=True)
            if track is not None:
                rows.append(self._row(track))
        return rows

    def get_object(self, object_id: str) -> dict[str, Any] | None:
        if object_id in self._delivery_aliases:
            track = self.wm.get_object(object_id, include_lost=True)
            return dict(self._row(track), alias_of=self._delivery_aliases[object_id]) if track is not None else None
        return next((row for row in self.objects() if row["id"] == object_id), None)

    def confirmed(self, object_id: str) -> dict[str, Any] | None:
        row = self.get_object(object_id)
        return row if row is not None and row["state"] == "CONFIRMED" else None

    def visible(self, object_id: str) -> dict[str, Any] | None:
        if self.last_evidence is None:
            return None
        return next((copy.deepcopy(item) for item in self.last_evidence["detections"]
                     if item["track_id"] == object_id), None)

    def original_position_evidence(self, original, category):
        """Absence needs a fresh, in-frame, unobstructed old-position view."""
        result = {"valid": False, "frame_id": self._last_frame, "matches": [],
                  "original_position_m": {"x": original[0], "z": original[1]},
                  "category": category}
        if self.last_evidence is None or category not in DETECTOR_WIDTH_CM:
            return dict(result, reason="original_position_observation_unavailable")
        x, z = self.pose.to_local(*original)
        if not .15 <= math.hypot(x, z) <= .9 or z <= 0:
            return dict(result, reason="original_position_outside_valid_range")
        try:
            u, v = self.ground_camera.ground_point_to_pixel(x, z)
        except (ValueError, ZeroDivisionError, OverflowError):
            return dict(result, reason="original_position_projection_invalid")
        diameter_px = DETECTOR_WIDTH_CM[category] / 100 * self.camera["fy"] / z
        box = {"x": u - diameter_px / 2, "y": v - diameter_px,
               "w": diameter_px, "h": diameter_px}
        result["projected_bbox"] = box
        if (box["x"] <= 0 or box["y"] <= 0 or box["x"] + box["w"] >= self.camera["width"]
                or box["y"] + box["h"] >= self.camera["height"]):
            return dict(result, reason="original_position_not_fully_visible")
        detections = self.last_evidence["detections"]
        result["matches"] = [copy.deepcopy(d) for d in detections if d["category"] == category
            and "position_m" in d and math.hypot(original[0] - d["position_m"]["x"],
                original[1] - d["position_m"]["z"]) < .15]
        occluders = []
        for d in detections:
            if d["category"] == "storage-zone":
                continue
            b = d["bbox"]
            if (b["x"] < box["x"] + box["w"] and b["x"] + b["w"] > box["x"]
                    and b["y"] < box["y"] + box["h"] and b["y"] + b["h"] > box["y"]):
                occluders.append(copy.deepcopy(d))
        result["occluders"] = occluders
        return dict(result, valid=not occluders,
                    reason="original_position_obstructed" if occluders else "original_position_visible")

    def mark_picked(self, object_id: str, *, holding: bool, original_position_absent: bool,
                    simulation_time_s: float, evidence: Mapping[str, Any]) -> bool:
        if holding is not True or not original_position_absent or not evidence:
            return False
        row = self.get_object(object_id)
        if row is None or self._times[object_id]["confirmed_s"] is None:
            return False
        view = evidence.get("original_position_observation")
        if not isinstance(view, Mapping) or view.get("frame_id") != self._last_frame:
            return False
        original = (row["position_m"]["x"], row["position_m"]["z"])
        actual_view = self.original_position_evidence(original, row["category"])
        if (evidence.get("holding") is not True or view != actual_view
                or actual_view.get("valid") is not True or actual_view["matches"]
                or simulation_time_s != self._last_timestamp):
            return False
        if self._lifecycle.get(object_id) in ("HELD", "DELIVERED", "RELEASED_UNVERIFIED", "DELIVERY_ALIAS"):
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
        if self._lifecycle.get(object_id) not in {"HELD", "RELEASED_UNVERIFIED"}:
            return False
        placement = evidence.get("placement")
        release = evidence.get("release_observation")
        saved = self._unverified_releases.get(object_id)
        if (self._lifecycle.get(object_id) == "RELEASED_UNVERIFIED"
                and (not saved or release != saved.get("release_observation"))):
            return False
        if (not isinstance(placement, Mapping) or not isinstance(release, Mapping)
                or evidence.get("holding") is not False
                or type(evidence.get("candidate_witnesses")) is not int or evidence["candidate_witnesses"] != 1
                or not self.last_evidence):
            return False
        witness_id = placement.get("ball_track_id")
        preexisting = release.get("preexisting_ball_ids")
        if ("ball_track_id" not in placement
                or (witness_id is not None and not isinstance(witness_id, str)) or witness_id == object_id
                or witness_id in self._delivery_aliases
                or not isinstance(preexisting, list) or not all(isinstance(oid, str) for oid in preexisting)
                or witness_id in preexisting):
            return False
        frame_id = str(placement.get("frame_id", ""))
        boundary = self._observed_frames.get(str(release.get("frame_id", "")))
        if (frame_id != self._last_frame or boundary is None
                or type(release.get("simulation_time_s")) not in (int, float)
                or release.get("simulation_time_s") != boundary["simulation_time_s"]
                or simulation_time_s != self._last_timestamp):
            return False
        # The near-field pixel witness remains valid outside the WM admission
        # window. Only an actual track needs release-identity/birth validation.
        if witness_id is not None:
            birth = self._times.get(witness_id, {})
            birth_frame = self._observed_frames.get(birth.get("first_seen_frame_id"))
            if (birth_frame is None or birth_frame["index"] < boundary["index"]
                    or birth["first_seen_s"] < boundary["simulation_time_s"]
                    or witness_id not in {track.obj_id for track in self.wm.get_scene()}):
                return False
        original = self.get_object(object_id)
        category = original["category"]
        if saved is not None:
            # A direct mark cannot bypass the same identity obligations that
            # later look/place recovery enforces. This also covers same-action
            # post-release retreat, whose initial sensor boundary is saved.
            seen_delivered = {d["known_delivered_object_id"] for d in self.last_evidence["detections"]
                              if d.get("known_delivered_object_id")}
            candidates = [d for d in self.last_evidence["detections"]
                if d["category"] == category and "position_m" in d
                and not d.get("known_delivered_object_id") and d.get("track_id") not in preexisting]
            anchor = saved.get("identity_anchor_m")
            if (not set(saved.get("required_delivered_ids", [])) <= seen_delivered
                    or len(candidates) != 1 or not isinstance(anchor, Mapping)
                    or math.hypot(candidates[0]["position_m"]["x"] - anchor["x"],
                                  candidates[0]["position_m"]["z"] - anchor["z"]) > .30):
                return False
        witnesses = [d for d in self.last_evidence["detections"]
                     if d.get("track_id") == witness_id and d.get("category") == category
                     and str(d.get("frame_id")) == frame_id
                     and not d.get("known_delivered_object_id")
                     and placement.get("ball_position_m") == d.get("position_m")
                     and placement.get("ball_bbox") == d.get("bbox")]
        if len(witnesses) != 1 or placement.get("ball_category") != category:
            return False
        zones = [d for d in self.last_evidence["detections"]
                 if d.get("category") == "storage-zone" and str(d.get("frame_id")) == frame_id
                 and d.get("bbox") == placement.get("storage_bbox")]
        if len(zones) != 1:
            return False
        # Recheck the same unique pixel-witness gate as Actions.place; a
        # claimed count of one cannot conceal another qualifying detection.
        pairs = [(ball, zone) for ball in self.last_evidence["detections"]
                 for zone in self.last_evidence["detections"]
                 if ball["category"] == category and "position_m" in ball
                 and zone["category"] == "storage-zone"
                 and not ball.get("known_delivered_object_id")
                 and ball.get("track_id") not in preexisting
                 and ball_inside_region(ball["bbox"], zone["bbox"])]
        if len(pairs) != 1 or pairs[0][0] != witnesses[0] or pairs[0][1] != zones[0]:
            return False
        try:
            position = {key: _number(placement["ball_position_m"][key], f"ball_position_m.{key}")
                        for key in ("x", "z")}
            self._bbox({"bbox": placement["ball_bbox"]})
            self._bbox({"bbox": placement["storage_bbox"]})
            timestamp = _number(simulation_time_s, "simulation_time_s")
        except (KeyError, TypeError, ValueError):
            return False
        self.wm.mark_removed(object_id, now=timestamp)
        alias = None
        if witness_id is not None:
            self.wm.mark_removed(witness_id, now=timestamp)
            alias = {"alias_of": object_id, "aliased_s": timestamp,
                     "witness_frame_id": frame_id, "release_observation": copy.deepcopy(dict(release)),
                     "witness_position_m": copy.deepcopy(position), "category": category}
            self._delivery_aliases[witness_id] = object_id
            self._lifecycle[witness_id] = "DELIVERY_ALIAS"
            self._times[witness_id].update(copy.deepcopy(alias))
        self._times[object_id]["delivery_witness_id"] = witness_id
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
        self._unverified_releases.pop(object_id, None)
        self._times[object_id]["delivered_s"] = timestamp
        self._times[object_id]["delivered_position_m"] = copy.deepcopy(position)
        self._action_evidence.append({"action": "place", "object_id": object_id,
            "simulation_time_s": timestamp, "holding": False,
            "ball_in_storage": True, "delivery_alias": dict(alias, witness_id=witness_id) if alias else None,
            "evidence": copy.deepcopy(dict(evidence))})
        return True

    def mark_release_unverified(self, object_id: str, *, simulation_time_s: float,
                                evidence: Mapping[str, Any]) -> bool:
        """Empty gripper without containment evidence is not a delivery."""
        if evidence.get("holding") is not False or self._lifecycle.get(object_id) != "HELD":
            return False
        timestamp = _number(simulation_time_s, "simulation_time_s")
        self.wm.mark_removed(object_id, now=timestamp)
        self._lifecycle[object_id] = "RELEASED_UNVERIFIED"
        self._unverified_releases[object_id] = copy.deepcopy(dict(evidence))
        release = evidence.get("release_observation")
        if isinstance(release, Mapping) and self.last_evidence:
            candidates = [d for d in self.last_evidence["detections"]
                if d["category"] == self.get_object(object_id)["category"]
                and "position_m" in d and not d.get("known_delivered_object_id")
                and d.get("track_id") not in release.get("preexisting_ball_ids", [])]
            anchor = (candidates[0]["position_m"] if len(candidates) == 1
                      else evidence.get("release_aim_position_m"))
            self._unverified_releases[object_id]["identity_anchor_m"] = copy.deepcopy(anchor)
        self._times[object_id]["released_unverified_s"] = timestamp
        self._action_evidence.append({"action": "release_unverified", "object_id": object_id,
            "simulation_time_s": timestamp, "holding": False,
            "evidence": copy.deepcopy(dict(evidence))})
        return True

    def unverified_releases(self):
        return [{"object_id": oid, "category": self.get_object(oid)["category"],
                 **copy.deepcopy(evidence)} for oid, evidence in self._unverified_releases.items()]

    def recover_release(self, object_id, *, holding, simulation_time_s, evidence):
        """Resolve a saved release only from a unique current sensor witness."""
        def unresolved(reason):
            return {"resolved": False, "reason": reason}

        saved = self._unverified_releases.get(object_id)
        if holding is not False or not saved or not self.last_evidence:
            return unresolved("release_recovery_state_unavailable")
        category = self.get_object(object_id)["category"]
        if sum(self.get_object(oid)["category"] == category for oid in self._unverified_releases) != 1:
            return unresolved("multiple_unverified_release_identities")
        release = saved.get("release_observation")
        boundary = self._observed_frames.get(str((release or {}).get("frame_id")))
        if (not boundary or evidence.get("release_observation") != release
                or release.get("simulation_time_s") != boundary["simulation_time_s"]
                or simulation_time_s != self._last_timestamp
                or self._observed_frames[self._last_frame]["index"] <= boundary["index"]):
            return unresolved("release_recovery_requires_fresh_boundary")
        observed = {d["known_delivered_object_id"] for d in self.last_evidence["detections"]
                    if d.get("known_delivered_object_id")}
        if not set(saved.get("required_delivered_ids", [])) <= observed:
            return unresolved("previously_delivered_objects_not_reobserved")
        preexisting = release["preexisting_ball_ids"]
        candidates = [d for d in self.last_evidence["detections"] if d["category"] == category
            and "position_m" in d and not d.get("known_delivered_object_id")
            and d.get("track_id") not in preexisting]
        if len(candidates) != 1:
            return unresolved("release_identity_candidate_not_unique")
        candidate = candidates[0]
        anchor = saved.get("identity_anchor_m")
        if (not isinstance(anchor, Mapping)
                or math.hypot(candidate["position_m"]["x"] - anchor["x"],
                              candidate["position_m"]["z"] - anchor["z"]) > .30):
            return unresolved("release_identity_continuity_unverified")
        if self.mark_delivered(object_id, holding=False, ball_in_storage=evidence.get("placement") is not None,
                               simulation_time_s=simulation_time_s, evidence=evidence):
            return {"resolved": True, "reason": "delayed_delivery_observed", "state": "DELIVERED"}
        # A rejected containment witness is not proof that the object is out.
        # Require one complete region and a ball box wholly outside its box.
        zones = [d for d in self.last_evidence["detections"] if d["category"] == "storage-zone"]
        witness_id = candidate.get("track_id")
        track = self.confirmed(witness_id) if witness_id is not None else None
        birth = self._times.get(witness_id, {})
        first = self._observed_frames.get(birth.get("first_seen_frame_id"))
        if (len(zones) != 1 or track is None or first is None
                or first["index"] < boundary["index"]
                or witness_id in self._delivery_aliases or witness_id == object_id):
            return unresolved("released_object_location_or_identity_unresolved")
        b, z = candidate["bbox"], zones[0]["bbox"]
        complete = (z["x"] > 0 and z["y"] > 0 and z["x"] + z["w"] < self.camera["width"]
                    and z["y"] + z["h"] < self.camera["height"] and z["w"] >= 3 and z["h"] >= 3)
        outside = (b["x"] + b["w"] < z["x"] or b["x"] > z["x"] + z["w"]
                   or b["y"] + b["h"] < z["y"] or b["y"] > z["y"] + z["h"])
        if not complete or not outside:
            return unresolved("released_object_location_or_identity_unresolved")
        # The observed confirmed successor remains a normal pickable track;
        # preserve the archived grasp identity and its explicit alias witness.
        self._delivery_aliases[object_id] = witness_id
        self._lifecycle[object_id] = "RECOVERED_ALIAS"
        self._times[object_id].update(recovered_object_id=witness_id,
                                      recovery_frame_id=self._last_frame)
        self._unverified_releases.pop(object_id)
        self._action_evidence.append({"action": "release_recovery", "object_id": object_id,
            "recovered_object_id": witness_id, "simulation_time_s": simulation_time_s,
            "holding": False, "outside_storage": True,
            "evidence": {**copy.deepcopy(dict(evidence)), "release_identity_anchor_m": copy.deepcopy(anchor),
                         "candidate": copy.deepcopy(candidate), "storage": copy.deepcopy(zones[0])}})
        return {"resolved": True, "reason": "released_object_recovered_outside_storage",
                "state": "CONFIRMED", "recovered_object_id": witness_id}

    def timeline(self) -> list[dict[str, Any]]:
        return [dict(copy.deepcopy(value),
                     accepted_hit_poses=copy.deepcopy(self._accepted_poses.get(oid, [])))
                for oid, value in self._times.items()]

    def action_evidence(self) -> list[dict[str, Any]]:
        return copy.deepcopy(self._action_evidence)
