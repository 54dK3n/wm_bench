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
from .actions import Actions
from .bridge import JsonLog, RobotBridge, SimulationLimit
from .llm import LLMClient
from .navigation import RoadMemory
from .perception import Perception

RUNTIME_VERSION = "autonomous-brain-runtime/v2"


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
                            "candidate_witnesses", "recovery_steps", "unexplored_exits"))
    detection(raw, evidence)
    for name in ("actuator_result", "recovery_result"):
        if isinstance(raw.get(name), dict):
            evidence[name] = fields(raw[name], ("stoppedBy",))
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

    def observe(self):
        odo = self.bridge.call("odometry")
        road = self.bridge.call("local_road")
        holding = self.bridge.call("holding")
        observation = self.bridge.call("observe", {"category": None, "confidence": 0})
        if odo["tick"] != observation["tick"] or road["tick"] != odo["tick"]:
            raise RuntimeError("sensor snapshots do not share a simulation tick")
        perception = self.perception.update(observation, odo,
            simulation_time_s=self.bridge.seconds, round_index=self.round)
        self.roads.update(odo, road)
        self.observation_count += 1
        self.snapshot = {"observation_index": self.observation_count, "round": self.round,
                         "simulation_seconds": self.bridge.seconds, "odometry": odo,
                         "road": road, "holding": holding, "observation": observation,
                         "perception": perception, "objects": self.perception.objects()}
        self.observation_log.write(self.snapshot)
        return self.snapshot

    def state(self):
        objects = []
        for row in self.perception.objects():
            objects.append({"id": row["id"], "category": row["category"],
                            "position_m": {k: round(v, 3) for k, v in row["position_m"].items()},
                            "confidence": round(row["confidence"], 3), "status": row["state"],
                            "distance_cm": round(row["distance_cm"], 1),
                            "bearing_deg": round(row["bearing_deg"], 1), "hit_count": row["hit_count"]})
        odo, road = self.snapshot["odometry"], self.snapshot["road"]
        return {"task": self.config["task"], "round": self.round,
                "simulation_seconds": self.bridge.seconds,
                "objects": objects,
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
        llm = LLMClient(log_path=out / "llm.jsonl", replay_path=args.replay, transport_retries=2)
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
            if number >= config.get("max_rounds", 200):
                reason = "round_limit"
                break
            if action["action"] == "done" and result["success"]:
                status, reason = "done", "observation_completion"
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
