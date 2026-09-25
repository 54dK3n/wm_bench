"""Run an external brain with one restricted capability received on stdin."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
WM_ROOT = Path(os.environ.get("WORLD_MODEL_ROOT", ROOT / "vendor/wm_kit_opt2")).resolve()
sys.path.insert(0, str(WM_ROOT))

from . import VERSION
from .actions import Actions, RETIREMENT_EVIDENCE_FIELDS, completion_evidence, reacquisition_chains
from .bridge import JsonLog, RobotBridge, SimulationLimit
from .llm import LLMClient
from .navigation import RoadMemory
from .perception import Perception

RUNTIME_VERSION = "autonomous-brain-runtime/v11"


def dump(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def compact_action_result(number, action, result, after_observation):
    """Carry bounded observed evidence forward, separately from WM geometry."""
    def fields(source, names):
        compact = {}
        if isinstance(source, dict):
            for name in names:
                if name not in source:
                    continue
                value = source[name]
                if value is None or type(value) in (bool, int, str) or (
                        type(value) is float and math.isfinite(value)):
                    compact[name] = value[:256] if isinstance(value, str) else value
        return compact

    detection_fields = ("track_id", "category", "source", "frame_id",
                        "distance_cm", "bearing_deg", "raw_distance_cm")

    def detection(source, target):
        if "detection" in source and source["detection"] is None:
            target["detection"] = None
        elif isinstance(source.get("detection"), dict):
            target["detection"] = fields(source["detection"], detection_fields)

    raw = result.get("evidence")
    raw = raw if isinstance(raw, dict) else {}
    evidence = fields(raw, ("object_id", "holding", "frame_id", "tick", "before_observation",
                            "after_observation", "final_observation", "post_observation",
                            "distance_cm", "remembered_distance_cm", "bearing_deg",
                            "front_clearance_cm", "requested_cm", "method", "measured_cm",
                            "heading_change_deg", "motion_observation",
                            "candidate_witnesses", "recovery_steps", "unexplored_exits"))
    detection(raw, evidence)
    if isinstance(raw.get("pending_objects"), list):
        evidence["pending_objects"] = [oid for oid in raw["pending_objects"] if isinstance(oid, str)]
    if isinstance(raw.get("retired_unconfirmed_hypotheses"), list):
        evidence["retired_unconfirmed_hypotheses"] = [
            fields(item, ("object_id", *RETIREMENT_EVIDENCE_FIELDS))
            for item in raw["retired_unconfirmed_hypotheses"] if isinstance(item, dict)]
    if isinstance(raw.get("resolved_reacquired_identities"), list):
        evidence["resolved_reacquired_identities"] = []
        for item in raw["resolved_reacquired_identities"]:
            if not isinstance(item, dict):
                continue
            resolved = fields(item, ("object_id", "delivered_object_id"))
            resolved["binding_chain"] = []
            links = item.get("binding_chain")
            for binding in links if isinstance(links, list) else []:
                if not isinstance(binding, dict):
                    continue
                link = fields(binding, ("version", "historical_object_id", "current_object_id"))
                basis = binding.get("evidence")
                if isinstance(basis, dict):
                    link["evidence"] = fields(basis, ("association", "frame_id", "simulation_time_s",
                        "distance_m", "gate_distance_m", "historical_confirmed_s", "current_confirmed_s"))
                    for name in ("historical_candidates", "current_candidates"):
                        if isinstance(basis.get(name), list):
                            link["evidence"][name] = [oid for oid in basis[name] if isinstance(oid, str)]
                    if isinstance(basis.get("current_hit_poses"), list):
                        link["evidence"]["current_hit_pose_count"] = len(basis["current_hit_poses"])
                resolved["binding_chain"].append(link)
            evidence["resolved_reacquired_identities"].append(resolved)
    for name in ("actuator_result", "recovery_result"):
        if isinstance(raw.get(name), dict):
            names = (("stoppedBy", "return_error_cm", "reversed_cm")
                     if name == "recovery_result" else ("stoppedBy",))
            evidence[name] = fields(raw[name], names)
    if isinstance(raw.get("road_return"), dict):
        evidence["road_return"] = fields(raw["road_return"], (
            "success", "reason", "on_road", "anchor_observation", "after_observation"))
    if isinstance(raw.get("reobservation"), dict):
        reobservation = raw["reobservation"]
        evidence["reobservation"] = fields(reobservation, ("reason", "after_observation", "old_objects_reobserved"))
        for name in ("required_delivered_ids", "observed_delivered_ids"):
            if isinstance(reobservation.get(name), list):
                evidence["reobservation"][name] = [oid for oid in reobservation[name] if isinstance(oid, str)]
        if isinstance(reobservation.get("road_return"), dict):
            evidence["reobservation"]["road_return"] = fields(reobservation["road_return"], (
                "success", "reason", "on_road", "anchor_observation", "after_observation"))
        if isinstance(reobservation.get("viewpoints"), list):
            evidence["reobservation"]["viewpoint_count"] = len(reobservation["viewpoints"])
    if isinstance(raw.get("road_clearance"), dict):
        evidence["road_clearance"] = fields(raw["road_clearance"], (
            "requested_cm", "permitted_cm", "heading_error_deg", "side",
            "side_clearance_cm", "front_clearance_cm", "predicted_lateral_cm", "reason"))
    if isinstance(raw.get("attempts"), list):
        evidence["attempts"] = []
        for attempt in raw["attempts"][-3:]:
            if not isinstance(attempt, dict):
                continue
            compact = fields(attempt, ("attempt", "holding", "before_observation", "after_observation"))
            if isinstance(attempt.get("alignment"), dict):
                alignment = fields(attempt["alignment"], ("mode", "remembered_distance_cm", "bearing_deg"))
                detection(attempt["alignment"], alignment)
                compact["alignment"] = alignment
            evidence["attempts"].append(compact)
    for name in ("old_position_matches", "old_position_detections"):
        matches = raw.get(name)
        if isinstance(matches, list) or (type(matches) is int and matches >= 0):
            evidence["old_position_matches"] = len(matches) if isinstance(matches, list) else matches
            break
    if "placement" in raw and raw["placement"] is None:
        evidence["placement"] = None
    elif isinstance(raw.get("placement"), dict):
        placement = fields(raw["placement"], ("frame_id",))
        for name in ("ball_bbox", "storage_bbox"):
            if isinstance(raw["placement"].get(name), dict):
                placement[name] = fields(raw["placement"][name], ("x", "y", "w", "h"))
        evidence["placement"] = placement
    compact_action = fields(action, ("action",))
    compact_action["params"] = fields(action.get("params"), ("object_id", "exit_angle"))
    summary = fields({"round": number, "success": result["success"], "reason": result["reason"],
                      "after_observation": after_observation},
                     ("round", "success", "reason", "after_observation"))
    return {**summary, "action": compact_action, "evidence": evidence}


class Runtime:
    def __init__(self, config, out):
        self.config, self.out = config, Path(out)
        self.round = 0
        self.observation_count = 0
        self.bridge = RobotBridge(config, self.out / "bridge-calls.jsonl")
        self.observation_log = JsonLog(self.out / "observations.jsonl")
        self.motion_log = JsonLog(self.out / "motions.jsonl")
        self.perception = Perception(self.bridge.call("camera_parameters"))
        self.roads = RoadMemory()
        self.held_object_id = None
        self.pending_grasp = None
        self.recent = []
        self.snapshot = None
        self.actions = Actions(self)

    def observe(self, *, motion=None):
        odo = self.bridge.call("odometry")
        road = self.bridge.call("local_road")
        holding = self.bridge.call("holding")
        observation = self.bridge.call("observe", {"category": None, "confidence": 0})
        if odo["tick"] != observation["tick"] or road["tick"] != odo["tick"]:
            raise RuntimeError("sensor snapshots do not share a simulation tick")
        perception = self.perception.update(observation, odo,
            simulation_time_s=self.bridge.seconds, round_index=self.round)
        self.roads.update(odo, road, observation_index=self.observation_count + 1)
        self.observation_count += 1
        self.snapshot = {"observation_index": self.observation_count, "round": self.round,
                         "simulation_seconds": self.bridge.seconds, "odometry": odo,
                         "road": road, "holding": holding, "observation": observation,
                         "perception": perception, "objects": self.perception.objects()}
        finalized_motion = (dict(motion, after_observation=self.observation_count)
                            if motion is not None else None)
        traversal_events = self.roads.observe_traversal(self.snapshot, finalized_motion)
        if traversal_events:
            self.snapshot["road_traversal_events"] = traversal_events
        self.observation_log.write(self.snapshot)
        return self.snapshot

    def state(self):
        objects = []
        rows = self.perception.objects()
        chains = reacquisition_chains(rows)
        for row in rows:
            objects.append({"id": row["id"], "category": row["category"],
                            "position_m": {k: round(v, 3) for k, v in row["position_m"].items()},
                            "confidence": round(row["confidence"], 3), "status": row["state"],
                            "distance_cm": round(row["distance_cm"], 1),
                            "bearing_deg": round(row["bearing_deg"], 1), "hit_count": row["hit_count"]})
            for key in ("completion_classification", "ever_confirmed"):
                if key in row:
                    objects[-1][key] = row[key]
            if row["id"] in chains:
                objects[-1]["reacquired_as"] = chains[row["id"]]["current_object_id"]
        odo, road = self.snapshot["odometry"], self.snapshot["road"]
        return {"task": self.config["task"], "round": self.round,
                "simulation_seconds": self.bridge.seconds,
                "coordinate_convention": {
                    "position_frame": "initial_odometry",
                    "position_axes": {"x": "right", "z": "forward"},
                    "object_bearing_deg": {"frame": "robot_relative", "positive": "right",
                                           "negative": "left", "zero": "forward"},
                    "heading_deg": {"frame": "initial_odometry", "positive": "left",
                                    "negative": "right", "zero": "initial_forward"},
                    "exit_angle_deg": {"frame": "robot_relative", "positive": "left",
                                       "negative": "right", "zero": "forward"},
                    "object_bearing_to_relative_turn": "negate"},
                "objects": objects,
                "completion": completion_evidence(rows),
                "robot": {"pose": {"right_cm": odo["rightCm"], "forward_cm": odo["forwardCm"],
                                    "heading_deg": odo["headingDeg"]},
                          "holding": self.snapshot["holding"]["holding"],
                          "held_object_id": self.held_object_id,
                          "pending_grasp_object_id": (self.pending_grasp or {}).get("object_id"),
                          "on_road": road["onRoad"], "at_junction": road["atJunction"],
                          "at_node": road.get("atNode", False),
                          "exit_angles": [e["angleDeg"] for e in road["exits"]],
                          "exits": self.roads.exits(odo, road),
                          "front_clearance_cm": road["frontClearanceCm"]},
                "junction_history": self.roads.summary(),
                "exploration_hints": [{key: value for key, value in hint.items() if key in {
                    "kind", "target_node_id", "target_exit_index", "target_heading_deg",
                    "next_exit_angle_deg", "recorded_travelled_cm", "cost_basis", "traversal_ids",
                    "target_anchor_gap_cm", "requires_fresh_arrival_and_exit_recheck"}}
                    for hint in self.roads.frontier_hints(odo, road,
                        observation_index=self.snapshot["observation_index"])],
                "unexplored_exit_count": self.roads.unexplored(),
                "observed_junction_count": len(self.roads.nodes),
                "recent_actions": copy.deepcopy(self.recent[-5:])}


def read_config():
    raw = sys.stdin.readline(65537)
    if len(raw) > 65536:
        raise ValueError("robot capability message exceeds limit")
    config = json.loads(raw)
    allowed = {"schema", "origin", "bridge_id", "client_token", "task",
               "simulation_step_ms", "max_rounds", "max_simulation_seconds"}
    if not isinstance(config, dict) or set(config) - allowed:
        raise ValueError("unexpected data in robot capability message")
    if not isinstance(config.get("task"), str) or not config["task"].strip():
        raise ValueError("one natural-language task is required")
    if not 1 <= config.get("max_rounds", 200) <= 200:
        raise ValueError("round cap must be 1..200")
    if not 0 < config.get("max_simulation_seconds", 1200) <= 1200:
        raise ValueError("simulation cap must be <=1200 seconds")
    return config


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--replay")
    args = parser.parse_args(argv)
    out = Path(args.out).resolve()
    # Driver may create an empty directory for the child; no old evidence is
    # overwritten, and every JSONL is opened exclusively.
    if out.exists() and any(out.iterdir()):
        raise ValueError("brain output directory is not empty")
    out.mkdir(parents=True, exist_ok=True)
    config = read_config()
    wall_start = time.monotonic()
    runtime = None
    llm = None
    rounds = JsonLog(out / "rounds.jsonl")
    status, reason, count = "failed", "not_started", 0
    try:
        llm = LLMClient(log_path=out / "llm.jsonl", replay_path=args.replay, transport_retries=5)
        runtime = Runtime(config, out)
        for number in range(1, config.get("max_rounds", 200) + 1):
            runtime.round = number
            runtime.observe()
            if runtime.bridge.seconds >= runtime.bridge.max_seconds:
                raise SimulationLimit("simulation_time_limit")
            state = runtime.state()
            action = None
            try:
                action = llm.decide(state)
                result = runtime.actions.execute(action)
            except Exception as exc:
                count = number
                rounds.write({"round": number, "state": state, "action": action,
                    "llm_output": llm.last_record,
                    "result": {"success": False, "reason": str(exc), "error_type": type(exc).__name__},
                    "simulation_seconds": runtime.bridge.seconds,
                    "llm_call_count": llm.call_count, "llm_total_elapsed_s": llm.total_elapsed_s})
                raise
            count = number
            rounds.write({"round": number, "state": state, "action": action,
                          "llm_output": llm.last_record, "result": result,
                          "simulation_seconds": runtime.bridge.seconds,
                          "llm_call_count": llm.call_count, "llm_total_elapsed_s": llm.total_elapsed_s})
            runtime.recent.append(compact_action_result(number, action, result,
                                                        runtime.snapshot["observation_index"]))
            runtime.recent = runtime.recent[-5:]
            print(json.dumps({"round": number, "action": action["action"], "success": result["success"],
                              "reason": result["reason"], "simulation_seconds": runtime.bridge.seconds}), flush=True)
            if action["action"] == "done" and result["success"]:
                status, reason = "done", "observation_completion"
                break
            if number >= config.get("max_rounds", 200):
                reason = "round_limit"
                break
        if args.replay:
            llm.assert_replay_consumed()
    except Exception as exc:
        status, reason = "failed", f"{type(exc).__name__}: {exc}"
    finally:
        summary = {"version": VERSION, "runtime_version": RUNTIME_VERSION, "status": status, "reason": reason,
                   "task": config["task"], "rounds": count,
                   "llm_calls": llm.call_count if llm else 0,
                   "llm_total_elapsed_s": llm.total_elapsed_s if llm else 0,
                   "wall_elapsed_s": time.monotonic() - wall_start,
                   "simulation_seconds": runtime.bridge.seconds if runtime else 0,
                   "observations": runtime.observation_count if runtime else 0,
                   "timeline": runtime.perception.timeline() if runtime else [],
                   "final_objects": runtime.perception.objects() if runtime else [],
                   "held_object_id": runtime.held_object_id if runtime else None,
                   "pending_grasp": runtime.pending_grasp if runtime else None,
                   "grab_attempts": runtime.actions.grab_attempts if runtime else {},
                   "action_evidence": runtime.perception.action_evidence() if runtime else [],
                   "junction_history": runtime.roads.summary() if runtime else [],
                   "limits": {"max_rounds": config.get("max_rounds", 200),
                              "max_simulation_seconds": config.get("max_simulation_seconds", 1200)},
                   "world_model": {"upstream_main": "fef0ba9b754ce9652836fdb720d1162dcadbc5ef",
                                   "profile": "guangyang_static_world_model", "max_range_m": 0.9},
                   "source_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                     for p in sorted(Path(__file__).parent.glob("*.py"))}}
        dump(out / "summary.json", summary)
        rounds.close()
        if llm:
            llm.close()
        if runtime:
            for log in (runtime.bridge.log, runtime.observation_log, runtime.motion_log):
                log.close()
    return 0 if status == "done" else 1


if __name__ == "__main__":
    raise SystemExit(main())
