#!/usr/bin/env python3
"""Read-only supplement to the frozen demo audit; never starts a simulator.

Keep physical delivery, user constraints, missing evidence and wrapper completion
separate. In particular, a failed departure after the second valid delivery is
not itself a user acceptance rule. The frozen report and runner are unchanged.
Print JSON to stdout; callers may preserve it under a new postprocessing name.
"""
import argparse
import json

try:
    from .demo_report import analyse_demo, audit
except ImportError:
    from demo_report import analyse_demo, audit


BEHAVIOR_GATES = (
    "program_errors_zero", "simulation_seconds_at_most_600",
    "observe_at_most_92", "vision_at_most_20mib",
    "no_stationary_observe_or_guard_violation", "on_road_entire_run",
    "no_target_anchor_access", "no_layout_coordinates",
)
EVIDENCE_GATES = (
    "program_identity", "full_raw_record_preserved", "samples_preserved",
    "native_png_evidence_complete", "driver_keyframes_preserved",
)


def aggregate(checks):
    """Unknown evidence is not evidence that a robot violated a constraint."""
    statuses = [value.get("status", "unknown") for value in checks.values()]
    if "fail" in statuses:
        return "fail"
    return "pass" if statuses and all(value == "pass" for value in statuses) else "unknown"


def supplement(report):
    details = report.get("gate_details", {})
    missing = audit("unknown", reason="audit_evidence_missing")
    final_record = details.get("run_finished", missing).get("status") == "pass"
    physical = dict(details.get("two_distinct_targets_grabbed_and_delivered", missing))
    # A partial record cannot establish the final delivery state, including
    # whether a delivery will later be revoked.
    if not final_record:
        physical["status"] = "unknown"
        physical["reason"] = "execution_record_not_final"

    behavior = {key: details.get(key, missing) for key in BEHAVIOR_GATES}
    if not final_record and behavior["observe_at_most_92"].get("status") == "fail":
        count = behavior["observe_at_most_92"].get("evidence", {}).get("count")
        if isinstance(count, int) and count <= 92:
            behavior["observe_at_most_92"] = audit("unknown", {"count": count}, "execution_record_not_final")
    evidence = {key: details.get(key, missing) for key in EVIDENCE_GATES}
    evidence["final_execution_record"] = audit("pass" if final_record else "unknown",
                                               details.get("run_finished"),
                                               None if final_record else "execution_record_not_final")
    balls = report.get("balls", [])
    identity_known = len(balls) == 2 and [ball.get("ball_index") for ball in balls] == [1, 2]
    identity_known = identity_known and all(
        ball.get("track_id") and ball.get("source") in ("memory", "new_observations")
        and ball.get("source_verified") and len(ball.get("platform_deliveries", [])) == 1
        for ball in balls)
    evidence["two_ball_identity_source_and_delivery_evidence"] = audit(
        "pass" if identity_known else "unknown",
        [{key: ball.get(key) for key in ("ball_index", "track_id", "source", "source_verified", "distinct_package_ids")}
         for ball in balls], None if identity_known else "two_ball_timeline_evidence_incomplete")
    if len(balls) != 2:
        evidence["two_ball_fixed_rule_evidence"] = audit("unknown", reason="two_ball_timelines_missing")
    for offset, ball in enumerate(balls):
        rules = ball.get("fixed_rule_audit", {})
        if not rules:
            evidence[f"ball_{offset + 1}_fixed_rule_evidence"] = audit("unknown", reason="fixed_rule_evidence_missing")
        for name, check in rules.items():
            behavior[f"ball_{offset + 1}_{name}"] = check

    endings = [ball.get("ending") for ball in balls]
    flow_status = ("fail" if any(ending and ending.get("success") is False for ending in endings)
                   else "pass" if len(endings) == 2 and all(ending and ending.get("success") is True for ending in endings)
                   else "unknown")
    extra = {
        "each_ball_wrapper_ends_successfully": audit(flow_status, endings,
            "not_an_independent_user_delivery_condition; departure_failure_does_not_undo_package_delivered"),
        "frozen_composite_timeline_gate": details.get("two_ball_timelines_complete", missing),
    }
    behavior_status, evidence_status = aggregate(behavior), aggregate(evidence)
    # Failed evidence preservation means unverifiable, not physical non-delivery.
    if physical["status"] == "fail" or behavior_status == "fail":
        classification = "verified_task_failure"
    elif physical["status"] == "pass" and behavior_status == evidence_status == "pass":
        classification = "user_conditions_met"
    else:
        classification = "unverified_or_incomplete_evidence"
    return {
        "schema": "wm-two-target-user-conditions-supplement/v1",
        "map": report.get("map"), "raw_file": report.get("raw_file"),
        "classification": classification,
        "physical_delivery": physical,
        "verified_final_delivered_package_ids": report.get("verified_final_delivered_package_ids", []),
        "user_behavior_conditions": {"status": behavior_status, "checks": behavior},
        "evidence_conditions": {"status": evidence_status, "checks": evidence},
        "additional_flow_checks_information_only": extra,
        "frozen_report_all_gates_pass": report.get("all_gates_pass"),
        "frozen_failure_reasons": report.get("failure_reasons", []),
        "flow_end_information_only": report.get("flow_end", []),
        "interpretation": "Physical delivery, rule violations and missing evidence are separate. A failed wrapper departure alone does not revoke delivery. This supplement does not change the frozen runner or its report.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("raw", help="One preserved raw trial JSON; never a directory or a simulator command")
    args = parser.parse_args()
    print(json.dumps(supplement(analyse_demo(args.raw)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
