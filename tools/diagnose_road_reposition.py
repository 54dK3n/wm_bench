#!/usr/bin/env python3
"""Recompute the fixed-sensor curved-road diagnostic with current brain code.

No simulator, model, credentials, recorded formal run, evaluator truth or map
layout is accessed. The existing test fixture supplies synthetic sensor and
actuator responses, and a confirmed target stub. The actual Actions.execute()
path must perform road repositioning followed by its fresh visual standoff.
Outputs are create-only, so earlier diagnostics cannot be overwritten.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import position
from test_brain_route_evidence import curve_runtime


def sources():
    paths = {Path(__file__).resolve()}
    for module in tuple(sys.modules.values()):
        filename = getattr(module, "__file__", None)
        if not filename:
            continue
        path = Path(filename).resolve()
        if path.suffix == ".py" and path.is_relative_to(ROOT):
            paths.add(path)
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}


def diagnose():
    runtime, calls = curve_runtime()
    initial = copy.deepcopy(runtime.snapshot)
    seed_segments = runtime.roads.road_segment_records()
    observations, motions = [initial], []
    original_observe = runtime.observe

    def observe(*, motion=None):
        original_observe(motion=motion)
        observations.append(copy.deepcopy(runtime.snapshot))

    runtime.observe = observe
    runtime.motion_log.write = lambda row: motions.append(copy.deepcopy(row))
    action = {"action": "go_to", "params": {"object_id": "red"}}
    outcome = Actions(runtime).execute(action)
    evidence = outcome.get("evidence", {})
    reposition = evidence.get("road_reposition", {})
    attempts = reposition.get("attempts", [])
    attempt = next((row for row in attempts if row.get("reached")), {})
    steps = attempt.get("steps", [])
    indexed = {row["observation_index"]: row for row in observations}
    recomputed = []
    for step in steps:
        before, after = indexed.get(step["before_observation"]), indexed.get(step["after_observation"])
        if before is None or after is None:
            recomputed.append({"verified": False, "reason": "missing_diagnostic_observation"})
            continue
        a, b = before["odometry"], after["odometry"]
        measured = math.dist(position(a), position(b)) * 100
        travelled = b["distanceCm"] - a["distanceCm"]
        fresh = (after["observation_index"] > before["observation_index"]
            and str(after["observation"]["frameId"]) != str(before["observation"]["frameId"])
            and b["tick"] > a["tick"]
            and before["observation"]["tick"] == a["tick"]
            and after["observation"]["tick"] == b["tick"])
        recomputed.append({"before_observation": before["observation_index"],
            "after_observation": after["observation_index"], "fresh_sensor": fresh,
            "odometer_travel_cm": travelled, "endpoint_displacement_cm": measured,
            "verified": fresh and before["road"]["onRoad"] is True
                and after["road"]["onRoad"] is True and measured >= .2
                and travelled >= .2 and measured <= travelled + .2})
    arrival_index = steps[-1]["after_observation"] if steps else None
    approach_index = attempt.get("approach_observation")
    visual_index = evidence.get("after_observation")
    arrival = indexed.get(arrival_index)
    candidate_position = attempt.get("candidate", {}).get("position_m")
    gap = (math.dist(position(arrival["odometry"]), candidate_position) * 100
           if arrival is not None and candidate_position is not None else None)
    view = evidence.get("detection", {})
    distance_cm = view.get("distance_cm")
    bearing_deg = view.get("bearing_deg")
    checks = {
        "generated_candidate": bool(attempts),
        "observed_road_steps_verified": bool(recomputed) and all(row["verified"] for row in recomputed),
        "candidate_reached": attempt.get("reached") is True and gap is not None and gap <= 15,
        "fresh_observation_after_arrival": (arrival is not None and approach_index is not None
            and approach_index > arrival_index and approach_index in indexed
            and str(indexed[approach_index]["observation"]["frameId"]) != str(arrival["observation"]["frameId"])),
        "visual_standoff_verified": (outcome.get("success") is True
            and reposition.get("status") == "reposition_and_visual_standoff_verified"
            and isinstance(distance_cm, (int, float)) and 25 <= distance_cm <= 40
            and isinstance(bearing_deg, (int, float)) and abs(bearing_deg) <= 5
            and visual_index in indexed and approach_index is not None and visual_index >= approach_index
            and str(view.get("frame_id")) == str(indexed[visual_index]["observation"]["frameId"])),
        "curve_sampled_between_recorded_waypoints": bool(steps) and (
            steps[0]["after_position_m"] != attempt["candidate"]["path"][1]),
    }
    return {
        "schema": "synthetic-road-reposition-diagnostic/v1",
        "classification": "synthetic_fixed_public_sensor_test_not_formal_simulator_run",
        "fixture": "tests/test_brain_route_evidence.py::curve_runtime",
        "source_sha256": sources(), "action": action,
        "passed": all(checks.values()), "checks": checks,
        "metrics": {"candidate_attempt_count": len(attempts),
            "candidate_reached_count": sum(row.get("reached") is True for row in attempts),
            "complete_reposition_success_count": int(checks["visual_standoff_verified"]
                and checks["candidate_reached"] and checks["fresh_observation_after_arrival"]),
            "road_translation_steps": len(steps),
            "odometer_travel_cm": sum(row.get("odometer_travel_cm", 0) for row in recomputed),
            "sum_step_endpoint_displacements_cm": sum(row.get("endpoint_displacement_cm", 0) for row in recomputed),
            "net_reposition_displacement_cm": (math.dist(position(initial["odometry"]),
                position(arrival["odometry"])) * 100 if arrival is not None else None),
            "candidate_arrival_error_cm": gap, "visual_distance_cm": distance_cm},
        "initial_observation": initial["observation_index"], "arrival_observation": arrival_index,
        "approach_observation": approach_index, "final_observation": runtime.snapshot["observation_index"],
        "final_visual_observation": visual_index,
        "recomputed_road_steps": recomputed, "seed_road_segments": seed_segments,
        "primitive_calls": [{"method": method, "params": params} for method, params in calls],
        "motions": motions, "observations": observations, "result": outcome,
        "limitations": [
            "Synthetic sensor and actuator fixture, including a confirmed target stub; no independent object discovery is tested.",
            "No simulator, model, historical formal transcript, credentials or evaluator truth is used.",
            "Success is this fixed-input controller diagnostic, not a formal task pass, topology acceptance or successful historical r102 replay.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="New JSON path; an existing file is never overwritten")
    args = parser.parse_args()
    if args.output.exists():
        parser.error(f"Output already exists: {args.output}")
    report = diagnose()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
    print(json.dumps({"output": str(args.output), "classification": report["classification"],
        "passed": report["passed"], "checks": report["checks"], "metrics": report["metrics"]}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
