#!/usr/bin/env python3
"""Offline attribution of the first native difference; never changes C gates.

Request projections below are diagnostic decompositions only. The authoritative
comparison still treats every native input/event field, including frame IDs,
timestamps, sequence numbers and perception results, as significant.
"""
import argparse
from collections import Counter
import json
from pathlib import Path

from compare_refactor_records import (
    DEFAULT_BASELINE, MAPS, MISSING, ROOT, differences, load_map,
    repository_reference, round_path, sha,
)


REQUEST_FIELDS = {
    "navigation_query": ("type", "method", "args"),
    "vision_query": ("type", "method", "args"),
    "navigation_control": ("type", "method", "args"),
    "control": ("type", "command", "source"),
    "package_grab": ("type", "intent"),
    "package_release": ("type", "intent"),
    "run_end": ("type", "reason", "source"),
}
ACTION_TYPES = {"navigation_control", "control", "package_grab", "package_release"}
DEFINITION_FIELDS = (
    "schemaVersion", "taskId", "mapId", "mapVersion", "ruleVersion", "randomSeed",
    "runDefinition", "taskDefinition", "ruleDefinition", "scoringDefinition",
    "simulationDefinition", "interactionDefinition", "navigationDefinition",
    "navigationControlDefinition",
)


def request(row):
    fields = REQUEST_FIELDS.get(row.get("type"))
    if fields is None:
        raise ValueError("Unknown native input type; no diagnostic fields may be guessed: " + str(row.get("type")))
    return {key: row[key] for key in fields if key in row}


def indexed(rows, keep=lambda row: True):
    return [(index, row) for index, row in enumerate(rows) if keep(row)]


def position(pair):
    if pair is None:
        return None
    index, row = pair
    return {"input_index": index, **{key: row[key] for key in
            ("seq", "type", "method", "tick", "t", "frameId", "evidenceId") if key in row}}


def first_difference(left, right, project=lambda row: row):
    """Compare ordered records without resynchronizing after divergent calls."""
    for ordinal in range(max(len(left), len(right))):
        a = left[ordinal] if ordinal < len(left) else None
        b = right[ordinal] if ordinal < len(right) else None
        x, y = project(a[1]) if a is not None else MISSING, project(b[1]) if b is not None else MISSING
        diff = differences(x, y)
        if diff:
            return {"ordinal": ordinal, "baseline": position(a), "candidate": position(b),
                    "differences": diff}
    return None


def payload_counter(value):
    if not isinstance(value, list):
        return None
    return Counter(json.dumps(item, sort_keys=True, separators=(",", ":")) for item in value)


def perception_at_first(left, right, first):
    if first is None or first["baseline"] is None or first["candidate"] is None:
        return None
    a = left[first["baseline"]["input_index"]]
    b = right[first["candidate"]["input_index"]]
    if a.get("type") != "vision_query" or b.get("type") != "vision_query":
        return None
    x, y = a.get("result", MISSING), b.get("result", MISSING)
    payload_diff = differences(x, y, "/result")
    without_ids_a = {k: v for k, v in a.items() if k not in ("frameId", "evidenceId")}
    without_ids_b = {k: v for k, v in b.items() if k not in ("frameId", "evidenceId")}
    ca, cb = payload_counter(x), payload_counter(y)
    return {
        "same_request": not differences(request(a), request(b)),
        "frame_id_changed": differences(a.get("frameId", MISSING), b.get("frameId", MISSING)) != [],
        "evidence_id_changed": differences(a.get("evidenceId", MISSING), b.get("evidenceId", MISSING)) != [],
        "only_frame_or_evidence_identity_changed": not differences(without_ids_a, without_ids_b),
        "payload_changed": bool(payload_diff),
        "payload_permutation_only": bool(payload_diff) and ca is not None and ca == cb,
        "payload_differences": payload_diff,
        "baseline_result": x, "candidate_result": y,
        "removed_exact_detection_items": [json.loads(k) for k, n in (ca - cb).items() for _ in range(n)] if ca is not None and cb is not None else None,
        "added_exact_detection_items": [json.loads(k) for k, n in (cb - ca).items() for _ in range(n)] if ca is not None and cb is not None else None,
    }


def relation(first_input, first_action):
    if first_action is None:
        return "no_different_action_request_in_complete_runs"
    if first_input is None:
        return "no_input_divergence"
    if any(first_input[side] is None or first_action[side] is None for side in ("baseline", "candidate")):
        return "cannot_order_missing_entry"
    comparisons = [first_input[side]["input_index"] - first_action[side]["input_index"]
                   for side in ("baseline", "candidate")]
    if all(value < 0 for value in comparisons):
        return "before_first_different_action_request_in_both_runs"
    if all(value > 0 for value in comparisons):
        return "after_first_different_action_request_in_both_runs"
    if all(value == 0 for value in comparisons):
        return "at_first_different_action_request"
    return "ordering_differs_between_runs"


def diagnose_layout(baseline_folder, candidate_folder, map_name):
    old, new = load_map(baseline_folder, map_name), load_map(candidate_folder, map_name)
    a, b = old["native"], new["native"]
    ai, bi = a["inputs"], b["inputs"]
    first = first_difference(indexed(ai), indexed(bi))
    first_request = first_difference(indexed(ai), indexed(bi), request)
    actions_a = indexed(ai, lambda row: row.get("type") in ACTION_TYPES)
    actions_b = indexed(bi, lambda row: row.get("type") in ACTION_TYPES)
    first_action = first_difference(actions_a, actions_b, request)
    first_action_record = first_difference(actions_a, actions_b)
    prefix = min(first[side]["input_index"] for side in ("baseline", "candidate")) if first and all(first[side] for side in ("baseline", "candidate")) else min(len(ai), len(bi))
    prior_actions = indexed(ai[:prefix], lambda row: row.get("type") in ACTION_TYPES)
    cutoff = min(first[side].get("tick", 0) for side in ("baseline", "candidate")) if first and all(first[side] for side in ("baseline", "candidate")) else 0
    samples_a = [row for row in a.get("samples", []) if row.get("tick", float("inf")) <= cutoff]
    samples_b = [row for row in b.get("samples", []) if row.get("tick", float("inf")) <= cutoff]
    sample_diff = differences(samples_a, samples_b)
    definitions = {field: {"equal": not differences(a.get(field, MISSING), b.get(field, MISSING)),
                           "differences": differences(a.get(field, MISSING), b.get(field, MISSING))}
                   for field in DEFINITION_FIELDS}
    previous_states = [row for row in ai[:prefix] if "startState" in row]
    program_requests_through_first_equal = (first_request is None or first_request["ordinal"] > prefix)
    log_lines = {}
    for side, run, native_inputs in (("baseline", old, ai), ("candidate", new, bi)):
        if first and first[side]:
            point = first[side]
            log_lines[side] = [{"line_index": i, "line_number": i + 1,
                                "observe_count": line.get("observe_count"), "tick": line.get("tick")}
                               for i, line in enumerate(run["raw"].get("lines", []))
                               if line.get("event") == "observe" and line.get("tick") == point.get("tick")]
    return {
        "map": map_name, "provenance": {"baseline": old["provenance"], "candidate": new["provenance"]},
        "original_gates_unchanged": {
            "inputs_equal": not differences(ai, bi), "events_equal": not differences(a["events"], b["events"]),
            "score_equal": not differences(a["result"]["score"], b["result"]["score"]),
            "baseline_score": a["result"]["score"], "candidate_score": b["result"]["score"]},
        "first_native_input_difference": first,
        "first_perception_difference": perception_at_first(ai, bi, first),
        "first_different_program_request": first_request,
        "first_different_action_request": first_action,
        "first_different_full_action_record": first_action_record,
        "input_difference_vs_first_action_request": relation(first, first_action),
        "prior_prefix": {
            "native_input_count": prefix, "all_native_fields_equal": not differences(ai[:prefix], bi[:prefix]),
            "all_program_requests_through_first_difference_equal": program_requests_through_first_equal,
            "action_count": len(prior_actions), "actions": [position(item) for item in prior_actions],
            "last_action": ({"position": position(prior_actions[-1]), "record": prior_actions[-1][1]} if prior_actions else None),
            "control_start_state_count": len(previous_states),
            "control_start_states_equal": not differences([row["startState"] for row in ai[:prefix] if "startState" in row], [row["startState"] for row in bi[:prefix] if "startState" in row]),
            "initial_pose_equal": not differences(a["simulationDefinition"].get("initialPose"), b["simulationDefinition"].get("initialPose")),
            "sample0_equal": not differences(a["samples"][0], b["samples"][0]),
            "sample_cutoff_tick": cutoff, "sample_counts": [len(samples_a), len(samples_b)],
            "all_samples_through_first_difference_tick_equal": not sample_diff,
            "first_sample_difference": sample_diff[0] if sample_diff else None,
        },
        "definition_comparisons": definitions,
        "challenge_digest": {"equal": a.get("challengeDigest") == b.get("challengeDigest"),
                             "baseline": a.get("challengeDigest"), "candidate": b.get("challengeDigest")},
        "raw_observe_log_references": log_lines,
        "interpretation_limit": "Sequence evidence identifies when observed records first differ. It does not establish the image/rendering cause or prove a later score change was caused by this one frame.",
    }


def diagnose(baseline, candidate):
    rows = [diagnose_layout(baseline, candidate, map_name) for map_name in MAPS]
    return {
        "baseline": repository_reference(round_path(baseline)), "candidate": repository_reference(round_path(candidate)),
        "tool_sha256": sha(Path(__file__).read_bytes()), "indexing": "input/event/list indices are zero-based; raw log line_number is one-based",
        "diagnostic_only": True, "equivalence_exceptions_added": [],
        "scope": "Only source records are read. No controller, simulator, image processing, program edits or gate changes.",
        "request_projection_fields": REQUEST_FIELDS,
        "action_types": sorted(ACTION_TYPES),
        "totals": {
            "layouts": len(rows),
            "inputs_equal": sum(row["original_gates_unchanged"]["inputs_equal"] for row in rows),
            "events_equal": sum(row["original_gates_unchanged"]["events_equal"] for row in rows),
            "scores_equal": sum(row["original_gates_unchanged"]["score_equal"] for row in rows),
            "first_difference_is_perception_payload": sum(bool(row["first_perception_difference"] and row["first_perception_difference"]["payload_changed"]) for row in rows),
            "first_difference_frame_id_changed": sum(bool(row["first_perception_difference"] and row["first_perception_difference"]["frame_id_changed"]) for row in rows),
            "first_difference_identity_only": sum(bool(row["first_perception_difference"] and row["first_perception_difference"]["only_frame_or_evidence_identity_changed"]) for row in rows),
            "request_action_relations": dict(Counter(row["input_difference_vs_first_action_request"] for row in rows)),
        }, "layouts": rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--candidate", type=Path, default=ROOT / "artifacts/inloop/refactor/round-1")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    out = args.out or round_path(args.candidate) / "first-divergence.json"
    report = diagnose(args.baseline, args.candidate)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"out": repository_reference(out), **report["totals"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
