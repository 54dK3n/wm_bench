"""Stage-2 evidence regressions. All inputs are synthetic or previously saved."""
import copy
import json
import math
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import opt2_report as report


def control(seq, tick, elapsed, moved, method="follow_road"):
    return {"seq": seq, "tick": tick, "type": "navigation_control", "method": method,
            "result": {"elapsedTicks": elapsed, "distanceCm": moved}}


def test_road_controls_are_not_total_odometer_or_free_motion():
    inputs = [control(1, 10, 5, 10), control(2, 15, 5, 25, "take_exit"),
              {"type": "control", "tick": 20, "command": {"kind": "forward"}, "distanceCm": 10},
              control(3, 0, 10, 99), control(4, 25, 5, 88)]
    result = report.road_distance(inputs, 10, 25)
    assert result["value_cm"] == 35
    assert [row["input_seq"] for row in result["inputs"]] == [1, 2]


@pytest.mark.parametrize("row", [control(1, 5, 10, 20), control(1, 20, 10, 20), control(1, 12, None, 20)])
def test_crossing_or_unknown_control_end_is_not_interpolated(row):
    result = report.road_distance([row], 10, 25)
    assert result["value_cm"] is None
    assert result["unknown"]


def test_WM_truth_association_is_30cm_unique_and_bound():
    initial = {"x": 0, "z": 0, "heading": 0}
    truth = {"objectState": {"packages": [{"id": "red", "role": "target", "x": 0, "z": -8}]}}
    assert report.associate({"x": 0, "z": 1.3}, initial, truth, 8)["status"] == "pass"
    assert report.associate({"x": 0, "z": 1.31}, initial, truth, 8)["status"] == "fail"
    assert report.associate({"x": 0, "z": 1}, initial, None, 8)["status"] == "unknown"
    ambiguous = copy.deepcopy(truth)
    ambiguous["objectState"]["packages"].append({"id": "other", "role": "target", "x": 0, "z": -8})
    assert report.associate({"x": 0, "z": 1}, initial, ambiguous, 8)["status"] == "unknown"


def test_actual_grab_angle_uses_recovery_heading_not_preapproach_heading():
    confirmation = {"hits": [{"pose_x": 0, "pose_z": 0, "world_x": 0, "world_z": 1}]}
    initial = {"heading": math.pi}
    pose = {"heading": math.pi + math.radians(62.88)}
    assert report.actual_grab_sight_angle(confirmation, pose, initial) == pytest.approx(-62.88)
    assert report.actual_grab_sight_angle(confirmation, None, initial) is None


@pytest.mark.parametrize("public_turn, expected", [(90, -90), (-90, 90)])
def test_public_heading_and_WM_sight_have_opposite_signs(public_turn, expected):
    confirmation = {"hits": [{"pose_x": 0, "pose_z": 0, "world_x": 0, "world_z": 1}]}
    initial = {"heading": .713}
    pose = {"heading": .713 + math.radians(public_turn)}
    assert report.actual_grab_sight_angle(confirmation, pose, initial) == pytest.approx(expected)


def test_grab_pose_rejects_rounded_samples_or_inconsistent_same_tick():
    pose = {"x": 1.123456789, "z": 2.123456789, "heading": 1.123456789}
    record = {"samples": [{"tick": 10, "x": 1.1235, "z": 2.1235, "heading": 1.1235}], "inputs": []}
    assert report.exact_grab_pose(record, 10)["pose"] is None
    record["inputs"] = [{"seq": 1, "tick": 10, "startState": {"tick": 10, "pose": pose}}]
    assert report.exact_grab_pose(record, 10)["pose"] == pose
    record["inputs"].append({"seq": 2, "tick": 10, "startState": {"tick": 10, "pose": {**pose, "x": 2}}})
    assert report.exact_grab_pose(record, 10)["pose"] is None


def test_missing_native_evidence_retains_failed_layout(tmp_path):
    path = tmp_path / "map-01.json"
    report.save(path, {"assignedMap": "map-01", "lines": [], "record": {}})
    row = report.analyse_trial_safe(path)
    assert row["map"] == "map-01" and row["passed"] is False
    assert row["physical_two_deliveries_status"] == "unknown"
    assert row["first_choice"]["match"] is False


def test_first_confirmed_checks_every_track_once_including_not_selected():
    lines = [{"event": "observe", "tick": 10}, {"event": "wm_targets", "tracks": [
        {"id": "real", "state": "confirmed", "x": 0, "z": 1},
        {"id": "phantom", "state": "confirmed", "x": 100, "z": 1}]},
        {"event": "wm_targets", "tracks": [{"id": "real", "state": "confirmed", "x": 0, "z": 1}]}]
    truth = {"objectState": {"packages": [{"id": "red", "role": "target", "x": 0, "z": -8}]}}
    rows = report.confirmation_audit(lines, {0: truth}, {"x": 0, "z": 0, "heading": 0}, 8)
    assert len(rows) == 2
    assert [row["association"]["status"] for row in rows] == ["pass", "fail"]
    assert report.confirmation_audit(lines, {}, {"x": 0, "z": 0, "heading": 0}, 8)[0]["association"]["status"] == "unknown"


def trial(name, second_trace, passed=True):
    return {"map": name, "passed": passed, "physical_two_deliveries": passed,
            "target_trace": {"has_target_trace": True, "trace": [{"ball_slot": 1, "trace": [1]},
                {"ball_slot": 2, "trace": second_trace}]}}


def test_grouping_uses_both_balls_and_mixed_outcomes_fail():
    groups = report.group_trials([trial("map-01", [2]), trial("map-02", [3]), trial("map-03", [2], False)])
    assert len(groups) == 2
    assert groups[0]["members"] == ["map-01", "map-03"]
    assert groups[0]["passed"] is False
    assert groups[1]["members"] == ["map-02"]


def test_image_ownership_uses_event_tick_and_reconciles(tmp_path):
    report.save(tmp_path / "vision.json", {"frames": [{"frameId": 1, "tick": 5, "byteLength": 10},
                                                     {"frameId": 2, "tick": 10, "byteLength": 20}]})
    report.save(tmp_path / "keys.json", {"frames": [{"eventTick": 9, "captureTick": 11, "byteLength": 4, "event": {"seq": 1}}]})
    raw = {"visionEvidenceFile": "vision.json", "demoEvidenceFile": "keys.json",
           "demoEvidence": {"combinedImageBytes": 34}, "record": {"vision": {"frameBytes": 30}}}
    result = report.image_accounting(raw, tmp_path / "map-01.json", [
        {"ball_index": 1, "start_tick": 0, "end_tick": 10}, {"ball_index": 2, "start_tick": 10, "end_tick": math.inf}])
    assert result["all_bytes_accounted"]
    assert [row["combined_image_bytes"] for row in result["balls"]] == [14, 20]


DEMO = report.ROOT / "artifacts/inloop/demo/map-05.json"


def test_saved_demo_two_balls_have_exact_separate_metrics_and_no_600_gate():
    result = report.analyse_trial(DEMO)
    assert result["passed"] and result["physical_two_deliveries"]
    assert not any("600" in key for key in result["gates"])
    assert result["budgets"]["simulation_seconds"] > 300
    left, right = result["balls"]
    assert left["package_id"] != right["package_id"]
    assert [ball["approach_calls"] for ball in result["balls"]] == [1, 1]
    assert [ball["observes"] for ball in result["balls"]] == [9, 18]
    assert left["confirm_to_grab_total_odometer_cm"] == pytest.approx(902.5)
    assert right["confirm_to_grab_total_odometer_cm"] == pytest.approx(483.3)
    assert left["confirm_to_grab_road_controls_cm"] == pytest.approx(803.8)
    assert right["confirm_to_grab_road_controls_cm"] == pytest.approx(467.3)
    assert result["image_accounting"]["all_bytes_accounted"]
    assert result["first_choice"]["evaluated"] is False
    assert result["first_choice"]["match"] is False
    assert all(ball["grab_truth_exact_tick"] for ball in result["balls"])


def test_depart_failure_does_not_revoke_two_verified_deliveries(tmp_path):
    raw = report.read(DEMO)
    raw["samplesFile"] = str(DEMO.with_name("map-05.samples.json"))
    for line in raw["lines"]:
        if line.get("event") in ("ball_end", "flow_end") and line.get("ball_index") == 2:
            line.update(success=False, reason="synthetic_depart_failed")
    path = tmp_path / "map-05.json"
    report.save(path, raw)
    result = report.analyse_trial(path)
    assert result["physical_two_deliveries"]
    assert result["passed"]
    assert result["balls"][1]["ending"]["success"] is False


def test_previous_single_target_regression_uses_first_ball_only(tmp_path):
    report.save(tmp_path / "opt_report.json", {"scenarios": [{"scenario": "S1", "members": ["map-01"], "passed": True}]})
    rows = [{"map": "map-01", "passed": False, "balls": [{"ball_index": 1, "confirmed_and_grabbed": True}]}]
    assert not report.regression_audit(rows, tmp_path)["regressions"]
    rows[0]["balls"] = [{"ball_index": 2, "confirmed_and_grabbed": True}]
    assert report.regression_audit(rows, tmp_path)["regressions"]


def test_later_round_regression_requires_previous_dual_success(tmp_path):
    report.save(tmp_path / "opt2_report.json", {"scenarios": [{"scenario": "S1", "members": ["map-01"], "passed": True}]})
    rows = [{"map": "map-01", "passed": False, "balls": [{"ball_index": 1, "confirmed_and_grabbed": True}]}]
    assert report.regression_audit(rows, tmp_path)["regressions"]


def test_batch_gate_detects_edited_raw_and_duplicate_execution(tmp_path, monkeypatch):
    folder, previous = tmp_path / "round-1", tmp_path / "prior"
    folder.mkdir(); previous.mkdir()
    original = report.analyse_trial(DEMO)
    original["first_choice"] = {"evaluated": True, "match": True}
    report.save(previous / "opt_report.json", {"scenarios": [{"scenario": "S1", "members": ["map-01"], "passed": True}]})
    completed, attempts = {}, []
    for name in report.MAPS:
        path = folder / (name + ".json")
        report.save(path, {"assignedMap": name})
        completed[name] = {"raw_sha256": report.sha(path)}
        attempts.append({"map": name, "classification": "executed"})
    report.save(folder / "progress.json", {"status": "complete", "completed": completed, "attempts": attempts})
    calibration = tmp_path / "calibration.json"
    report.save(calibration, {"all_pass": True})
    report.save(folder / "build.json", {"calibration": str(calibration), "calibration_sha256": report.sha(calibration)})
    report.save(folder / "code_manifest.json", {str(calibration): report.sha(calibration)})
    def trial(path):
        row = copy.deepcopy(original)
        row.update(map=path.stem, raw_sha256=report.sha(path))
        return row
    monkeypatch.setattr(report, "analyse_trial_safe", trial)
    result = report.evaluate(folder, previous)
    assert result["gates"]["complete_ten_layouts_once"]
    assert result["gates"]["raw_trial_hashes_match_execution_ledger"]
    report.save(folder / "map-01.json", {"assignedMap": "map-01", "edited": True})
    progress = report.read(folder / "progress.json")
    progress["attempts"].append({"map": "map-01", "classification": "executed"})
    report.save(folder / "progress.json", progress)
    result = report.evaluate(folder, previous)
    assert result["gates"]["complete_ten_layouts_once"] is False
    assert result["gates"]["raw_trial_hashes_match_execution_ledger"] is False
