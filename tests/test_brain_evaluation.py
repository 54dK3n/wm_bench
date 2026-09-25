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
    summary = {"status": "done", "reason": "observed_completion", "rounds": 2,
               "llm_calls": 2, "llm_total_elapsed_s": 0.75, "simulation_seconds": 100,
               "timeline": [{"object_id": "unrelated-wm-0", "first_seen_s": 2.5}]}
    return {"record": record, "captures": captures, "summary": summary, "rounds": rounds,
            "observations": observations, "llm": [{"elapsed_s": 0.25}, {"elapsed_s": 0.5}],
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
    for key, name in (("rounds", "rounds"), ("observations", "observations"), ("llm", "llm"), ("bridge", "bridge-calls")):
        (run / "brain" / (name + ".jsonl")).write_text("".join(json.dumps(row) + "\n" for row in data[key]))
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
    for item in fixture_data["observations"][-1]["perception"]["detections"]:
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
