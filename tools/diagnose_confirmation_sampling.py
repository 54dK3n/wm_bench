#!/usr/bin/env python3
"""Export synthetic public-sensor sampling diagnostics, never a formal result.

Run from a checkout with its test dependencies available. This reuses the real
SensorBridge fixture, Runtime, Actions.execute, Perception and frozen WorldModel;
it does not invoke a simulator/model or replace confirmation with a mocked bool.
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
sys.path[:0] = [str(ROOT), str(ROOT / "tests"), str(ROOT / "vendor/wm_kit_opt2")]

from autonomous_brain.confirmation_sampling import MAX_STEPS, VERSION as SAMPLING_VERSION
from autonomous_brain.perception import VERSION as PERCEPTION_VERSION
from test_brain_confirmation_sampling import discovery_id, sampling_runtime


SCENARIOS = [
    ("direct", {}, None, "success"),
    ("observed_node", {"at_node": True}, None, "success"),
    ("curve", {"mode": "curve"}, None, "success"),
    ("outside_window_about_97cm", {"target": (0, 106)}, None, "success"),
    ("observed_straight_reverse", {"target": (0, 82)}, 34, "success"),
    ("near_without_reverse_history", {"target": (0, 48)}, None, "refusal"),
    ("reverse_without_safe_margin", {"target": (0, 78)}, 30, "refusal"),
    ("occluded_after_movement", {"mode": "occluded"}, None, "refusal"),
    ("range_window_overshoot", {"mode": "overshoot"}, None, "refusal"),
    ("stationary_new_frames", {"mode": "stationary"}, None, "refusal"),
    ("same_frame_competition", {"mode": "competing"}, None, "refusal"),
    ("post_action_occlusion", {"mode": "post_occluded"}, None, "refusal"),
    ("late_competition", {"mode": "late_competing"}, None, "refusal"),
    ("unknown_motion_receipt", {"mode": "unknown"}, None, "exception"),
    ("actual_travel_budget_exceeded", {"mode": "budget_overshoot"}, None, "refusal"),
    ("turn_only", {"mode": "turn_only"}, None, "refusal"),
]


def hit_checks(runtime):
    """Independently join recorded hit frames to public detections and odometry."""
    frames = {row["perception"]["frame_id"]: row for row in runtime.trace}
    required = runtime.perception.wm.decay_cfg.confirm_hits
    gap = runtime.perception.wm.assoc_cfg.min_hit_pose_gap_m
    rows = []
    for obj in runtime.perception.objects():
        if obj["category"] != "red-ball":
            continue
        poses = obj["hit_poses"]
        pairwise = [dict(first_frame=a["frame_id"], second_frame=b["frame_id"],
                         separation_m=math.hypot(a["x_m"]-b["x_m"], a["z_m"]-b["z_m"]))
                    for i, a in enumerate(poses) for b in poses[:i]]
        matches = []
        for pose in poses:
            observed = frames.get(pose["frame_id"])
            detections = [] if observed is None else [d for d in observed["perception"]["detections"]
                if d["category"] == "red-ball" and d.get("track_id") == obj["id"]
                and d.get("fed_to_world_model")]
            odo = (observed or {}).get("odometry", {})
            matched = (len(detections) == 1 and observed is not None
                and abs(odo["rightCm"]/100-pose["x_m"]) < 1e-9
                and abs(odo["forwardCm"]/100-pose["z_m"]) < 1e-9
                and 40 <= detections[0]["raw_distance_cm"] < 90
                and abs(detections[0]["raw_bearing_deg"]) <= 35)
            matches.append(dict(frame_id=pose["frame_id"],
                observation_index=(observed or {}).get("observation_index"),
                admitted_detection_count=len(detections), public_pose_and_window_match=matched))
        rows.append(dict(object_id=obj["id"], state=obj["state"], hit_count=obj["hit_count"],
            required_hit_count=required, min_hit_pose_gap_m=gap, hit_poses=copy.deepcopy(poses),
            pairwise_separations=pairwise, public_hit_frame_matches=matches,
            every_hit_has_public_frame=all(x["public_pose_and_window_match"] for x in matches),
            separated=all(x["separation_m"]+1e-12 >= gap for x in pairwise),
            has_required_hits=len(poses) >= required))
    return rows


def scenario(name, options, setup_cm, expected):
    runtime = sampling_runtime(**options)
    selected = discovery_id(runtime)
    setup = []
    if setup_cm is not None:
        params = {"distanceCm": setup_cm, "speed": 30}
        receipt = runtime.actions.move("forward", params)
        setup.append(dict(method="forward", params=params, receipt=receipt))
    command = {"action": "explore", "params": {"discovery_id": selected}}
    before = runtime.perception.discovery_target(selected)
    result, exception = None, None
    try:
        result = runtime.actions.execute(command)
    except Exception as error:
        exception = dict(type=type(error).__name__, message=str(error),
                         action_evidence=copy.deepcopy(getattr(error, "action_evidence", None)))
    actual = "exception" if exception else "success" if result["success"] else "refusal"
    after = runtime.perception.discovery_target(selected)
    independent = hit_checks(runtime)
    confirmed_id = ((result or {}).get("evidence", {}).get("confirmation_sampling") or {}).get("confirmed_object_id")
    confirmed = next((x for x in independent if x["object_id"] == confirmed_id), None)
    calls = runtime.bridge.calls
    checks = dict(expected_outcome_matches=actual == expected,
        all_hit_frames_and_poses_match_public_data=all(x["every_hit_has_public_frame"] for x in independent),
        all_accepted_poses_separated=all(x["separated"] for x in independent),
        no_grab_release_or_unbounded_exit=all(method not in {"grab", "release", "take_exit"} for method, _ in calls),
        sampler_motor_calls_bounded=len(calls)-len(setup) <= MAX_STEPS,
        successful_result_has_independent_hits=(actual != "success" or bool(confirmed
            and confirmed["has_required_hits"] and confirmed["separated"] and confirmed["every_hit_has_public_frame"])),
        successful_result_has_fresh_corroboration=(actual != "success" or bool(after
            and after["current_confirmation_corroborated"])),
        unknown_motion_not_resent=(name != "unknown_motion_receipt" or len(calls) == 1),
        unknown_motion_keeps_sampling_trace=(name != "unknown_motion_receipt" or bool(exception
            and exception["action_evidence"] and exception["action_evidence"].get("confirmation_sampling"))))
    return dict(name=name, expected_outcome=expected, actual_outcome=actual,
        input=dict(render_only_fixture_options=options, setup_public_commands=setup,
                   action=command, target_before=before),
        observations=runtime.trace, motions=runtime.motions, normalized_motor_calls=calls,
        result=result, exception=exception, target_after=after,
        final_objects=runtime.perception.objects(), discovery_evidence=runtime.perception.discovery_evidence(),
        independent_hit_checks=independent, checks=checks,
        diagnostic_checks_satisfied=all(checks.values()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path,
                        help="New JSON file; existing files are never overwritten")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output already exists; choose a new file")
    files = ["tools/diagnose_confirmation_sampling.py", "tests/test_brain_confirmation_sampling.py",
             "tests/test_brain_perception.py", "tests/test_brain_route_contract.py",
             "autonomous_brain/confirmation_sampling.py", "autonomous_brain/perception.py",
             "autonomous_brain/actions.py", "autonomous_brain/run.py", "autonomous_brain/navigation.py"]
    hashes = {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in files}
    cases = [scenario(*entry) for entry in SCENARIOS]
    # Detect concurrent implementation edits rather than attributing all cases
    # to a single source snapshot when the tool was run during development.
    unchanged = all(hashlib.sha256((ROOT/name).read_bytes()).hexdigest() == sha for name, sha in hashes.items())
    artifact = dict(schema="synthetic-confirmation-sampling-diagnostic/v1",
        scope=dict(synthetic=True, formal_result=False, model_calls=False, simulator_calls=False,
                   real_perception_and_world_model=True,
                   fixture_geometry_used_only_to_render_public_pixels=True),
        versions=dict(perception=PERCEPTION_VERSION, sampling=SAMPLING_VERSION),
        source_sha256=hashes, sources_unchanged_during_export=unchanged,
        cases=cases, diagnostic_checks_satisfied=unchanged and all(c["diagnostic_checks_satisfied"] for c in cases))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as stream:
        json.dump(artifact, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps(dict(output=str(args.output), synthetic=True, formal_result=False,
        cases=len(cases), expected_successes=sum(c["expected_outcome"] == "success" for c in cases),
        diagnostic_checks_satisfied=artifact["diagnostic_checks_satisfied"],
        outcomes=[dict(name=c["name"], actual=c["actual_outcome"],
                       reason=(c["result"] or {}).get("reason"), checks=c["checks"]) for c in cases]), indent=2))
    return 0 if artifact["diagnostic_checks_satisfied"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
