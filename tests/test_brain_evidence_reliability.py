"""Reject forged completion witnesses without running a simulator or a model."""
import copy
import json

import pytest

from brain_evidence_fixtures import task_fixture
from test_brain_evaluation import evaluation
from autonomous_brain.actions import ball_inside_region
from tools.brain_evidence_audit import strict_transcript_replay


def sync_bridge(observations, bridge):
    for call in bridge:
        if call["request"]["method"] == "observe":
            index = call["terminal"]["result"]["frameId"]
            call["terminal"]["result"] = copy.deepcopy(observations[index - 1]["observation"])


def mutate_ball_everywhere(data, box):
    summary, observations, rounds, _, bridge, _ = data
    summary["action_evidence"][1]["evidence"]["placement"]["ball_bbox"] = copy.deepcopy(box)
    rounds[1]["result"]["evidence"]["placement"]["ball_bbox"] = copy.deepcopy(box)
    for field in ("observation", "perception"):
        observations[5][field]["detections"][0]["bbox"] = copy.deepcopy(box)
    sync_bridge(observations, bridge)


def test_outside_region_source_probe_is_rejected_despite_consistent_claims():
    data = task_fixture()
    mutate_ball_everywhere(data, {"x": 500, "y": 400, "w": 30, "h": 30})
    placement = data[0]["action_evidence"][1]["evidence"]["placement"]
    assert not ball_inside_region(placement["ball_bbox"], placement["storage_bbox"])
    result = evaluation.evaluate_task_scope(*data)
    assert "delivery_unique_geometric_witness_not_verified" in result["failures"]
    # A function test is intentionally not evidence of evaluate_run acceptance.
    assert "success" not in result


@pytest.mark.parametrize("case,failure", [
    ("multiple_balls", "delivery_unique_geometric_witness_not_verified"),
    ("multiple_regions", "delivery_unique_geometric_witness_not_verified"),
    ("second_ball_conversion_deleted", "delivery_raw_detection_missing_or_duplicated_in_conversion"),
    ("second_ball_fake_old", "delivery_unknown_delivered_label"),
    ("second_ball_fake_existing_old", "delivery_prior_delivered_label_not_corroborated"),
    ("second_ball_position_deleted", "delivery_converted_geometry_unavailable"),
    ("ambiguous_identity", "delivery_witness_identity_ambiguous"),
    ("old_ball", "delivery_unique_geometric_witness_not_verified"),
    ("missing_old", "delivery_prior_deliveries_not_distinguished"),
    ("release_before", "delivery_release_boundary_invalid"),
    ("release_time", "delivery_release_boundary_invalid"),
    ("frame_duplicate", "observation_frame_duplicate_or_conflicting"),
    ("index_duplicate", "observation_index_duplicate_or_conflicting"),
    ("bridge_frame_duplicate", "bridge_observation_frame_duplicate_or_conflicting"),
    ("bridge_raw_tamper", "observation_not_corroborated_by_bridge"),
    ("stale_gripper", "observation_not_corroborated_by_bridge"),
    ("converted_only", "delivery_ledger_missing_same_frame_observation"),
    ("converted_wrong_frame", "delivery_ledger_missing_same_frame_observation"),
    ("ledger_position", "delivery_converted_witness_mismatch"),
    ("ledger_bbox", "delivery_ledger_missing_same_frame_observation"),
    ("ledger_old_ids", "delivery_preexisting_identities_mismatch"),
    ("ledger_duplicate", "delivery_duplicate_identity_or_witness"),
    ("action_result_tamper", "delivery_action_evidence_mismatch"),
    ("no_release", "delivery_release_command_not_corroborated"),
    ("wrong_held_identity", "delivery_released_identity_not_held"),
    ("no_grab", "pick_ledger_missing_holding_observation"),
    ("parsed_done_only", "done_not_selected_in_recorded_llm_call"),
    ("raw_done_tamper", "done_not_selected_in_recorded_llm_call"),
    ("response_done_tamper", "done_not_selected_in_recorded_llm_call"),
    ("request_hash_tamper", "done_not_selected_in_recorded_llm_call"),
    ("done_no_fresh_observation", "done_post_action_completion_not_corroborated"),
    ("done_claimed_count", "done_post_action_completion_not_corroborated"),
    ("done_failed", "done_post_action_completion_not_corroborated"),
])
def test_rejects_incomplete_or_conflicting_evidence(case, failure):
    data = task_fixture()
    summary, observations, rounds, calls, bridge, motions = data
    witness = observations[5]
    event = summary["action_evidence"][1]
    if case in {"multiple_balls", "multiple_regions"}:
        index = 0 if case == "multiple_balls" else 1
        for field in ("observation", "perception"):
            duplicate = copy.deepcopy(witness[field]["detections"][index])
            duplicate["bbox"]["x"] += 10
            witness[field]["detections"].append(duplicate)
        sync_bridge(observations, bridge)
    elif case in {"second_ball_conversion_deleted", "second_ball_fake_old", "second_ball_position_deleted"}:
        second = copy.deepcopy(witness["observation"]["detections"][0])
        second["bbox"]["x"] += 40
        witness["observation"]["detections"].append(second)
        if case == "second_ball_fake_old":
            witness["perception"]["detections"].append(dict(second, frame_id="6",
                position_m={"x": 2.4, "z": 1}, known_delivered_object_id="fabricated-old"))
        if case == "second_ball_position_deleted":
            witness["perception"]["detections"].append(dict(second, frame_id="6"))
        sync_bridge(observations, bridge)
    elif case == "ambiguous_identity":
        witness["perception"]["detections"][0]["identity_ambiguity"] = {"candidates": ["red-a", "red-b"]}
    elif case == "second_ball_fake_existing_old":
        third = copy.deepcopy(observations[12]["perception"]["detections"][1])
        third["bbox"]["x"] += 10
        third["known_delivered_object_id"] = "red-a"
        observations[12]["perception"]["detections"].append(third)
        observations[12]["observation"]["detections"].append({"category": "red-ball", "bbox": third["bbox"]})
        sync_bridge(observations, bridge)
    elif case == "old_ball":
        observations[12]["perception"]["detections"][1]["known_delivered_object_id"] = "red-a"
    elif case == "missing_old":
        observations[12]["perception"]["detections"].pop(0)
    elif case == "release_before":
        event["evidence"]["release_observation"]["frame_id"] = 7
    elif case == "release_time":
        event["evidence"]["release_observation"]["simulation_time_s"] += 1
    elif case == "frame_duplicate":
        observations[6]["observation"]["frameId"] = 6
    elif case == "index_duplicate":
        observations[6]["observation_index"] = 6
    elif case == "bridge_frame_duplicate":
        duplicate = copy.deepcopy(next(c for c in bridge if c["request"]["method"] == "observe"))
        duplicate["request"]["requestId"] = "extra"
        bridge.append(duplicate)
    elif case == "bridge_raw_tamper":
        next(c for c in bridge if c["request"]["method"] == "observe")["terminal"]["result"]["tick"] += 1
    elif case == "stale_gripper":
        bridge.pop(next(i for i, c in enumerate(bridge) if c["request"]["method"] == "holding"))
    elif case == "converted_only":
        witness["observation"]["detections"] = []
        sync_bridge(observations, bridge)
    elif case == "converted_wrong_frame":
        witness["perception"]["detections"][0]["frame_id"] = "5"
    elif case == "ledger_position":
        event["evidence"]["placement"]["ball_position_m"]["x"] += 10
    elif case == "ledger_bbox":
        event["evidence"]["placement"]["ball_bbox"]["x"] += 1
    elif case == "ledger_old_ids":
        event["evidence"]["release_observation"]["preexisting_ball_ids"] = []
    elif case == "ledger_duplicate":
        summary["action_evidence"].append(copy.deepcopy(event))
    elif case == "action_result_tamper":
        rounds[1]["result"]["evidence"]["candidate_witnesses"] = 2
    elif case == "no_release":
        motions[:] = [m for m in motions if m["method"] != "release"]
    elif case == "wrong_held_identity":
        observations[3]["objects"][0]["state"] = "CONFIRMED"
    elif case == "no_grab":
        motions[:] = [m for m in motions if m["method"] != "grab"]
    elif case == "parsed_done_only":
        calls[0].pop("response_body")
    elif case == "raw_done_tamper":
        calls[0]["raw_output"] = '{"action":"explore","params":{}}'
    elif case == "response_done_tamper":
        calls[0]["response_body"] = calls[0]["response_body"].replace("done", "explore")
    elif case == "request_hash_tamper":
        calls[0]["request_sha256"] = "0" * 64
    elif case == "done_no_fresh_observation":
        rounds[-1]["result"]["evidence"]["before_observation"] = 16
    elif case == "done_claimed_count":
        rounds[-1]["result"]["evidence"]["delivered_count"] = 20
    elif case == "done_failed":
        rounds[-1]["result"]["success"] = False
    assert failure in evaluation.evaluate_task_scope(*data)["failures"]


def identity_fixture():
    data = task_fixture()
    summary, observations, rounds, calls, bridge, motions = data
    for index, oid, x in ((0, "red-a", 200), (7, "red-b", 280)):
        detection = {"category": "red-ball", "bbox": {"x": x, "y": 220, "w": 30, "h": 30}}
        observations[index]["observation"]["detections"] = [copy.deepcopy(detection)]
        observations[index]["perception"]["detections"] = [dict(detection, frame_id=str(index + 1), track_id=oid)]
    sync_bridge(observations, bridge)
    captures = []
    for o in observations:
        truths = []
        for d in o["observation"]["detections"]:
            if d["category"] != "red-ball":
                continue
            box = d["bbox"]
            truths.append({"id": "truth-a" if box["x"] == 200 else "truth-b", "category": "red-ball",
                           "active": True, "centerWorld": [box["x"] + 15, -box["y"] - 15, -100]})
        captures.append({"frameId": o["observation"]["frameId"], "tick": o["observation"]["tick"],
            "truthObjects": truths, "cameraPose": {"matrixWorld": [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
                                                     "fx": 100, "fy": 100, "cx": 0, "cy": 0},
            "odometryOrigin": {"x": 0, "z": 0, "heading": 0}, "worldUnitsToMeters": 1})
    record = {"clock": {"stepMs": 20}, "native": {"events": [], "samples": [], "taskDefinition": {"deliveries": [
        {"objectRole": "target", "destinationRole": "storage", "requiredPackageIds": ["truth-a", "truth-b"]}]}}}
    return data, record, captures


def test_unverifiable_action_history_does_not_automatically_fail_valid_completion_witnesses():
    data, record, captures = identity_fixture()
    summary, observations, rounds, _, _, motions = data
    result = evaluation.evaluate_action_identity_audits(record, captures, summary, observations, rounds, motions,
                                                       evaluation.evaluate_task_scope(*data))
    assert result["prefix_judge"]["eligible_actions"] == 4
    assert result["prefix_judge"]["counts"] == {"unverifiable": 4}  # Native action samples deliberately absent.
    assert not result["failures"]
    assert [w["truth_id"] for w in result["completion_witnesses"]] == ["truth-a", "truth-b"]
    assert result["global_judge_replaced"] is False


@pytest.mark.parametrize("case,failure", [
    ("reused_object", "completion_reuses_physical_object"),
    ("capture_duplicate", "completion_witness_exact_capture_missing_or_ambiguous"),
    ("capture_tick", "completion_witness_exact_capture_missing_or_ambiguous"),
    ("old_label_wrong", "completion_old_object_exclusion_identity_conflict"),
])
def test_completion_physical_identity_checks(case, failure):
    data, record, captures = identity_fixture()
    summary, observations, rounds, _, _, motions = data
    if case == "reused_object":
        captures[12]["truthObjects"][0]["id"] = "truth-b"
        captures[12]["truthObjects"][1]["id"] = "truth-a"
    elif case == "capture_duplicate":
        captures.append(copy.deepcopy(captures[12]))
    elif case == "capture_tick":
        captures[12]["tick"] += 1
    elif case == "old_label_wrong":
        captures[12]["truthObjects"][0]["id"] = "truth-b"
        captures[12]["truthObjects"][1]["id"] = "truth-a"
    result = evaluation.evaluate_action_identity_audits(record, captures, summary, observations, rounds, motions,
                                                       evaluation.evaluate_task_scope(*data))
    assert failure in result["failures"]


def test_strict_replay_missing_transcript_cannot_succeed(tmp_path):
    assert strict_transcript_replay(tmp_path)["failures"] == ["strict_model_transcript_replay_failed"]


def test_native_contradiction_for_credited_pick_blocks_completion():
    data, record, captures = identity_fixture()
    summary, observations, rounds, _, _, motions = data
    record["complete"] = True
    record["native"]["samples"] = [{"tick": 10, "holding": None}, {"tick": 30, "holding": None}]
    result = evaluation.evaluate_action_identity_audits(record, captures, summary, observations, rounds, motions,
                                                       evaluation.evaluate_task_scope(*data))
    assert result["prefix_judge"]["rows"][0]["judge"]["status"] == "false_positive"
    assert "completion_action_contradicted_by_native_window" in result["failures"]
