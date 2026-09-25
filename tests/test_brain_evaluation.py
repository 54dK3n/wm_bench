"""Offline fixtures for independent autonomous-brain truth evaluation."""
import copy
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "tools/evaluate_autonomous_brain.py"
SPEC = importlib.util.spec_from_file_location("autonomous_evaluation", SCRIPT)
evaluation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evaluation)


@pytest.fixture
def fixture_data():
    expected = ["truth-red-east", "truth-red-west"]
    objects = [
        {"id": expected[0], "category": "red-ball", "centerWorld": [1, 0, -4], "active": True},
        {"id": expected[1], "category": "red-ball", "centerWorld": [-1, 0, -4], "active": True},
    ]
    boxes = [{"x": 340, "y": 230, "w": 10, "h": 20},
             {"x": 290, "y": 230, "w": 10, "h": 20}]
    captures, observations = [], []
    for frame, tick in ((1, 100), (2, 150)):
        captures.append({"frameId": frame, "tick": tick, "stepMs": 20,
            "cameraPose": {"matrixWorld": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                           "fx": 100, "fy": 100, "cx": 320, "cy": 240},
            "odometryOrigin": {"x": 0, "z": 0, "heading": 0},
            "worldUnitsToMeters": 0.125, "truthObjects": copy.deepcopy(objects)})
        observations.append({"observation_index": frame, "round": frame,
            "simulation_seconds": tick * 0.02,
            "observation": {"frameId": frame, "tick": tick, "detections": [
                {"category": "red-ball", "bbox": box, "confidence": 0.8, "source": "virtual-cv"}
                for box in boxes]},
            "perception": {"detections": [{"category": "red-ball", "bbox": box,
                "track_id": f"unrelated-wm-{index}" if frame == 2 else None}
                for index, box in enumerate(boxes)]},
            "objects": [] if frame == 1 else [
                {"id": "unrelated-wm-0", "category": "red-ball", "state": "CONFIRMED",
                 "position_m": {"x": 0.145, "z": 0.5}},
                {"id": "unrelated-wm-1", "category": "red-ball", "status": "CONFIRMED",
                 "position_m": {"x": -0.155, "z": 0.5}}]})
    events = []
    for index, truth_id in enumerate(expected):
        events.extend([
            {"type": "package_grabbed", "packageId": truth_id, "accepted": True,
             "objectRole": "target", "tick": 500 + index * 1000, "t": 10000 + index * 20000},
            {"type": "package_delivered", "packageId": truth_id, "objectRole": "target",
             "tick": 1000 + index * 1000, "t": 20000 + index * 20000},
        ])
    record = {"complete": True, "clock": {"stepMs": 20}, "calls": [{"method": "observe"}], "bridgeCalls": [],
        "native": {"simulationEndTick": 5000, "taskDefinition": {"deliveries": [
            {"objectRole": "target", "destinationRole": "storage", "destination": [8, -8],
             "radius": 1, "requiredPackageIds": expected}]}, "events": events,
            "samples": [{"x": 0, "z": 0, "heading": 0, "tick": 0},
                        {"tick": 5000, "holding": None, "packages": [
                            {"id": truth_id, "role": "target", "x": 8, "z": -8} for truth_id in expected]}]}}
    rounds = [{"round": i, "state": {}, "action": {"action": "look_around", "params": {}},
               "result": {"success": True}, "simulation_seconds": i * 2} for i in (1, 2)]
    observations.append({"observation_index": 3, "round": 2, "simulation_seconds": 100,
                         "observation": {"frameId": 3, "tick": 5000, "detections": []},
                         "holding": {"holding": False}, "objects": []})
    rounds[-1].update(action={"action": "done", "params": {}}, simulation_seconds=100,
                      result={"success": True, "reason": "observed_completion",
                              "evidence": {"before_observation": 2, "after_observation": 3}})
    summary = {"status": "done", "reason": "observed_completion", "rounds": 2,
               "llm_calls": 2, "llm_total_elapsed_s": 0.75, "simulation_seconds": 100,
               "timeline": [{"object_id": "unrelated-wm-0", "first_seen_s": 2.5}],
               "source_sha256": {"run.py": "a" * 64}}
    source_manifest = {"version": "wm-autonomous-brain-driver/v4",
                       "brain": {"autonomous_brain/run.py": "a" * 64},
                       "driver": {"file": "tools/autonomous_brain_driver.js", "sha256": "b" * 64},
                       "platform": {"competition-core.js": "c" * 64},
                       "evaluatorCaptureSha256": "d" * 64}
    return {"record": record, "captures": captures, "summary": summary, "rounds": rounds,
            "observations": observations, "llm": [{"elapsed_s": 0.25}, {"elapsed_s": 0.5}],
            "source_manifest": source_manifest,
            "driver_summary": {"schema": source_manifest["version"], "status": "complete",
                               "sourcesUnchanged": True, "sourceManifestAfterRun": copy.deepcopy(source_manifest)},
            "bridge": [{"request": {"method": "observe"}}],
            "metadata": {"map": "map-05", "success": True, "process": {"code": 0},
                         "maxRounds": 200, "maxSimulationSeconds": 1200}}


def write_fixture(tmp_path, data, compressed=True):
    run = tmp_path / "map-05-run-1"
    (run / "brain").mkdir(parents=True)
    evidence = {}
    for key, name in (("record", "record.json"), ("captures", "captures.json")):
        raw = (json.dumps(data[key]) + "\n").encode()
        packed = gzip.compress(raw) if compressed else raw
        target = run / (name + ".gz" if compressed else name)
        target.write_bytes(packed)
        evidence[key] = {"file": target.name, "sha256": hashlib.sha256(packed).hexdigest(),
                         "expandedSha256": hashlib.sha256(raw).hexdigest()}
    (run / "evidence.json").write_text(json.dumps(evidence))
    (run / "evaluation.json").write_text(json.dumps(data["metadata"]))
    (run / "brain/summary.json").write_text(json.dumps(data["summary"]))
    for key, name in (("source_manifest", "manifest.json"), ("driver_summary", "summary.json"),
                      ("evaluator_stop", "evaluator-stop.json")):
        if key in data:
            (run.parent / name).write_text(json.dumps(data[key]))
    for key, name in (("rounds", "rounds"), ("observations", "observations"), ("llm", "llm"), ("bridge", "bridge-calls")):
        (run / "brain" / (name + ".jsonl")).write_text("".join(json.dumps(row) + "\n" for row in data[key]))
    if "motions" in data:
        (run / "brain/motions.jsonl").write_text("".join(json.dumps(row) + "\n" for row in data["motions"]))
    return run


def test_independent_success_geometry_error_and_timeline(tmp_path, fixture_data):
    run = write_fixture(tmp_path, fixture_data)
    result = evaluation.evaluate_run(run)
    assert result["success"] is True
    assert result["metrics"]["llm_calls"] == 2
    assert result["metrics"]["llm_total_elapsed_s"] == 0.75
    assert result["metrics"]["simulation_seconds"] == 100
    errors = result["perception"]["position_error"]
    assert errors["count"] == 2
    assert errors["mean_cm"] == pytest.approx(2.5)
    assert errors["rmse_cm"] == pytest.approx(math.sqrt(6.5))
    ball = result["perception"]["timeline"][0]
    assert ball["wm_track_ids"] == ["unrelated-wm-0"]
    assert ball["first_raw_seen"]["simulation_seconds"] == 2
    assert ball["first_confirmed"]["simulation_seconds"] == 3
    assert ball["first_grabbed_truth_event"]["simulation_seconds"] == 10
    assert ball["final_active_delivery_truth_event"]["simulation_seconds"] == 20
    assert ball["brain_memory_timeline"][0]["first_seen_s"] == 2.5
    report = evaluation.report_text(result)
    assert str(evaluation.ROOT) not in report
    assert "`" + str(run.resolve()) not in report
    assert "2.500000" in report


def test_driver_boolean_is_not_used(tmp_path, fixture_data):
    fixture_data["metadata"]["success"] = False
    assert evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))["success"] is True


def test_failed_brain_cannot_be_overridden_by_delivered_truth(tmp_path, fixture_data):
    fixture_data["summary"].update(status="failed", reason="LLMOutputError: invalid after repair")
    result = evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))
    assert result["delivery"]["delivered_target_ids"] == ["truth-red-east", "truth-red-west"]
    assert not result["success"]
    assert "brain_did_not_finish_with_observed_done" in result["failures"]


@pytest.mark.parametrize("mutation,reason", [
    ("revoke", "no_active_delivery_event"),
    ("outside", "final_position_outside_storage"),
    ("held", "final_position_outside_storage"),
    ("time", "simulation_limit_reached"),
    ("rounds", "round_limit_reached"),
    ("forbidden", "nonwhitelist_calls_executed"),
    ("incomplete", "incomplete_record"),
    ("process", "execution_or_controller_error"),
])
def test_failures_override_declared_success(tmp_path, fixture_data, mutation, reason):
    native = fixture_data["record"]["native"]
    if mutation == "revoke":
        native["events"].append({"type": "package_delivery_revoked", "packageId": "truth-red-east", "t": 50000})
    elif mutation == "outside":
        native["samples"][-1]["packages"][0]["x"] = 20
    elif mutation == "held":
        native["samples"][-1]["holding"] = "truth-red-east"
    elif mutation == "time":
        native["simulationEndTick"] = 60000
    elif mutation == "rounds":
        fixture_data["rounds"][-1]["round"] = fixture_data["summary"]["rounds"] = 200
    elif mutation == "forbidden":
        fixture_data["record"]["calls"].append({"method": "mission"})
    elif mutation == "incomplete":
        fixture_data["record"]["complete"] = False
    elif mutation == "process":
        fixture_data["metadata"]["process"]["code"] = 1
    result = evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))
    assert not result["success"]
    assert any(reason in failure for failure in result["failures"])


def test_later_delivery_after_revoke_can_succeed(tmp_path, fixture_data):
    events = fixture_data["record"]["native"]["events"]
    events.extend([{"type": "package_delivery_revoked", "packageId": "truth-red-east", "t": 50000},
                   {"type": "package_delivered", "packageId": "truth-red-east", "t": 60000}])
    result = evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))
    assert result["success"]
    ball = result["perception"]["timeline"][0]
    assert ball["first_delivered_truth_event"]["simulation_seconds"] == 20
    assert ball["final_active_delivery_truth_event"]["simulation_seconds"] == 60


def test_rotated_world_to_odometry():
    transformed = evaluation.world_to_odometry([10, 0, 16], {"x": 10, "z": 20, "heading": math.pi / 2}, 0.125)
    assert transformed["x"] == pytest.approx(0.5)
    assert transformed["z"] == pytest.approx(0, abs=1e-12)


def test_no_nearest_fallback_for_unmatched_detections(tmp_path, fixture_data):
    for observation in fixture_data["observations"]:
        for detection in observation["observation"]["detections"]:
            detection["bbox"]["x"] = 10
    result = evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))
    assert result["success"]  # reported error coverage is not a new physical gate
    assert result["perception"]["position_error"]["count"] == 0
    assert result["perception"]["position_error"]["mean_cm"] is None
    assert result["perception"]["unmatched_confirmed_count"] == 2
    assert result["perception"]["timeline"][0]["first_raw_seen"] is None


def test_multi_truth_bbox_is_explicitly_ambiguous(fixture_data):
    detection = {"category": "red-ball", "bbox": {"x": 280, "y": 230, "w": 80, "h": 20}}
    matches = evaluation.match_pixels([detection], fixture_data["captures"][0])
    assert matches[0]["status"] == "ambiguous"
    assert len(matches[0]["candidates"]) == 2


def test_multiple_boxes_for_one_truth_are_ambiguous(fixture_data):
    detection = fixture_data["observations"][0]["observation"]["detections"][0]
    matches = evaluation.match_pixels([detection, copy.deepcopy(detection)], fixture_data["captures"][0])
    assert [row["status"] for row in matches] == ["ambiguous", "ambiguous"]


def test_conflicting_track_identity_excludes_position_error(tmp_path, fixture_data):
    for item in fixture_data["observations"][1]["perception"]["detections"]:
        item["track_id"] = "unrelated-wm-0"
    result = evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))
    assert len(result["perception"]["ambiguous_track_ids"]["unrelated-wm-0"]) == 2
    assert result["perception"]["position_error"]["count"] == 0


def test_exact_frame_tick_binding_required(tmp_path, fixture_data):
    fixture_data["captures"][-1]["tick"] = 999
    result = evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))
    assert result["perception"]["position_error"]["count"] == 0
    assert any(row["reason"] == "missing_or_ambiguous_exact_capture"
               for row in result["perception"]["matching_issues"])


def test_evidence_hash_tamper_fails(tmp_path, fixture_data):
    run = write_fixture(tmp_path, fixture_data, compressed=False)
    record = run / "record.json"
    record.write_text(record.read_text() + " ")
    assert "evidence_sha_mismatch:record" in evaluation.evaluate_run(run)["failures"]


def test_failed_actions_report_actual_reason(tmp_path, fixture_data):
    fixture_data["rounds"][0]["result"] = {"success": False, "reason": "target_not_visible", "evidence": {"holding": False}}
    result = evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))
    assert result["metrics"]["failed_actions"] == 1
    assert "target_not_visible" in evaluation.report_text(result)


def test_cli_writes_new_report_and_refuses_overwrite(tmp_path, fixture_data):
    run = write_fixture(tmp_path, fixture_data)
    out = tmp_path / "report"
    assert evaluation.main(["--input", str(run), "--out", str(out)]) == 0
    assert json.loads((out / "evaluation.json").read_text())["success"]
    before = (out / "REPORT.md").read_text()
    with pytest.raises(SystemExit):
        evaluation.main(["--input", str(run), "--out", str(out)])
    assert (out / "REPORT.md").read_text() == before


@pytest.mark.parametrize("tick", [None, 4999, 5001, True])
def test_final_sample_must_match_exact_export_end_tick(tmp_path, fixture_data, tick):
    fixture_data["record"]["native"]["samples"][-1]["tick"] = tick
    result = evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))
    assert not result["success"]
    assert "final_sample_tick_mismatch" in result["failures"]


@pytest.mark.parametrize("mutation", ["no_done", "failed_done", "missing_reference", "unknown_reference", "wrong_round", "stale_tick", "holding"])
def test_terminal_done_requires_a_successful_action_and_final_observation(tmp_path, fixture_data, mutation):
    last, observation = fixture_data["rounds"][-1], fixture_data["observations"][-1]
    if mutation == "no_done":
        last["action"]["action"] = "look_around"
    elif mutation == "failed_done":
        last["result"]["success"] = False
    elif mutation == "missing_reference":
        last["result"].pop("evidence")
    elif mutation == "unknown_reference":
        last["result"]["evidence"]["after_observation"] = 9
    elif mutation == "wrong_round":
        observation["round"] = 1
    elif mutation == "stale_tick":
        observation["observation"]["tick"] = 4999
    else:
        observation["holding"]["holding"] = True
    result = evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))
    assert not result["success"]
    assert "terminal_done_not_corroborated" in result["failures"]


@pytest.mark.parametrize("mutation", ["changed", "flag_false", "summary_hash", "missing", "unsupported", "malformed_hash"])
def test_source_proof_failures_cannot_pass_final_acceptance(tmp_path, fixture_data, mutation):
    if mutation == "changed":
        fixture_data["driver_summary"]["sourceManifestAfterRun"]["brain"]["autonomous_brain/run.py"] = "e" * 64
    elif mutation == "flag_false":
        fixture_data["driver_summary"]["sourcesUnchanged"] = False
    elif mutation == "summary_hash":
        fixture_data["summary"]["source_sha256"]["run.py"] = "f" * 64
    elif mutation == "missing":
        fixture_data.pop("source_manifest")
        fixture_data.pop("driver_summary")
    elif mutation == "unsupported":
        fixture_data["source_manifest"]["version"] = "unknown/v1"
    else:
        fixture_data["source_manifest"]["brain"]["autonomous_brain/run.py"] = "not-a-sha"
    result = evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))
    assert not result["success"]
    assert result["source_proof"]["status"] != "verified"
    assert any(reason.startswith("source_proof_") for reason in result["failures"])


def test_known_source_proof_is_reported_without_reading_current_runtime(tmp_path, fixture_data):
    result = evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))
    assert result["source_proof"]["status"] == "verified"
    assert result["source_proof"]["recorded_before_after_equal"] is True
    assert result["source_proof"]["brain_summary_hashes_match"] is True


def test_missing_archive_sidecar_is_not_a_fallback_integrity_pass(tmp_path, fixture_data):
    run = write_fixture(tmp_path, fixture_data)
    (run / "evidence.json").unlink()
    result = evaluation.evaluate_run(run)
    assert not result["success"]
    assert "missing_input:evidence.json" in result["failures"]


def test_report_does_not_call_active_event_a_valid_delivery_when_final_position_fails(tmp_path, fixture_data):
    fixture_data["record"]["native"]["samples"][-1]["packages"][0]["x"] = 20
    result = evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))
    assert not result["success"]
    report = evaluation.report_text(result)
    assert "最终有效送达" not in report
    assert "最终未撤销交付事件" in report


def judge_fixture(data, action, claimed_success, actual_success):
    """Build a real bounded actuator window using public observations and offline truth."""
    truth_id = "truth-red-east"
    before = {"observation_index": 3, "round": 2, "simulation_seconds": 5,
              "observation": {"frameId": 3, "tick": 250, "detections": []},
              "holding": {"holding": action == "place"}, "objects": []}
    after = {"observation_index": 4, "round": 2, "simulation_seconds": 12,
             "observation": {"frameId": 4, "tick": 600, "detections": []},
             "holding": {"holding": action == "pick" and actual_success}, "objects": []}
    terminal = copy.deepcopy(data["observations"][-1])
    terminal.update(observation_index=5, round=3)
    data["observations"] = data["observations"][:2] + [before, after, terminal]
    done = copy.deepcopy(data["rounds"][-1])
    done.update(round=3)
    done["result"]["evidence"] = {"before_observation": 4, "after_observation": 5}
    data["rounds"] = [data["rounds"][0], {"round": 2, "state": {"robot": {"held_object_id": "unrelated-wm-0"}},
        "action": {"action": action, "params": {"object_id": "unrelated-wm-0"} if action == "pick" else {}},
        "result": {"success": claimed_success, "reason": "synthetic_action_result",
                   "evidence": {"object_id": "unrelated-wm-0", "before_observation": 3,
                                "after_observation": 4, "final_observation": 4}}, "simulation_seconds": 12}, done]
    data["motions"] = [{"round": 2, "method": "grab" if action == "pick" else "release",
                        "before_observation": 3, "after_observation": 4, "actuator_result": {"completed": True}}]
    native = data["record"]["native"]
    native["events"] = [e for e in native["events"] if not (e.get("packageId") == truth_id and e.get("tick", 0) <= 600)]
    if actual_success:
        native["events"].insert(0, {"type": "package_grabbed" if action == "pick" else "package_delivered",
                                    "packageId": truth_id, "accepted": True, "tick": 500})
    native["samples"].insert(1, {"tick": 250, "holding": truth_id if action == "place" else None,
                                "packages": [{"id": truth_id, "x": 20, "z": -8}]})
    native["samples"].insert(2, {"tick": 600, "holding": truth_id if action == "pick" and actual_success else None,
                                "packages": [{"id": truth_id, "x": 8 if actual_success else 20, "z": -8}]})
    data["summary"].update(rounds=3, llm_calls=3, llm_total_elapsed_s=1)
    data["llm"].append({"elapsed_s": .25})
    return data


@pytest.mark.parametrize("action", ["pick", "place"])
@pytest.mark.parametrize("claimed,actual,status", [(True, True, "match"), (False, False, "match"),
                                                  (True, False, "false_positive"), (False, True, "false_negative")])
def test_independent_judge_counts_bound_pick_and_place_outcomes(tmp_path, fixture_data, action, claimed, actual, status):
    result = evaluation.evaluate_run(write_fixture(tmp_path, judge_fixture(fixture_data, action, claimed, actual)))
    judge = result["judge"]
    assert judge["rows"][1]["status"] == status
    assert judge["counts"][status] == 1
    assert judge["counts"]["eligible_actions"] == 1
    assert judge["counts"]["not_evaluated"] == 2
    assert "Judge" in evaluation.report_text(result)


@pytest.mark.parametrize("missing", ["binding", "sample", "motion", "reference", "ambiguous_sample"])
def test_judge_marks_missing_or_ambiguous_evidence_unverifiable(tmp_path, fixture_data, missing):
    data = judge_fixture(fixture_data, "pick", True, True)
    if missing == "binding":
        data["rounds"][1]["action"]["params"]["object_id"] = "unknown"
        data["rounds"][1]["result"]["evidence"]["object_id"] = "unknown"
    elif missing == "sample":
        data["record"]["native"]["samples"] = [x for x in data["record"]["native"]["samples"] if x["tick"] != 600]
    elif missing == "motion":
        data.pop("motions")
    elif missing == "reference":
        data["rounds"][1]["result"]["evidence"].pop("before_observation")
    else:
        data["record"]["native"]["samples"].insert(3, {"tick": 600, "holding": None, "packages": []})
    judge = evaluation.evaluate_run(write_fixture(tmp_path, data))["judge"]
    assert judge["rows"][1]["status"] == "unverifiable"
    assert judge["counts"]["unverifiable"] == 1
    assert judge["counts"]["false_positive"] == judge["counts"]["false_negative"] == 0


def test_external_stop_error_is_separated_from_action_failure(tmp_path, fixture_data):
    fixture_data["summary"].update(status="failed", reason="BridgeError: turn: NOT_RUNNING")
    fixture_data["rounds"][-1]["result"] = {"success": False, "reason": "turn: NOT_RUNNING", "error_type": "BridgeError"}
    fixture_data["evaluator_stop"] = {"version": "evaluator-requested-stop/v1", "task_success": False,
                                     "reason": "fixture stop", "result": {"running": True, "tick": 5000}}
    result = evaluation.evaluate_run(write_fixture(tmp_path, fixture_data))
    assert not result["success"]
    assert result["metrics"]["failed_rounds"] == result["metrics"]["external_stop_failures"] == 1
    assert result["metrics"]["failed_actions"] == 0
    assert result["failed_actions"][0]["failure_kind"] == "external_stop"
    assert "评估方停止后的错误" in evaluation.report_text(result)
