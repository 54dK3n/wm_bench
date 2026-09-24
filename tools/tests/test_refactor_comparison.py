"""No simulation: strict equality positives and independent record mutations."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch


TOOL = Path(__file__).resolve().parents[1] / "compare_refactor_records.py"
sys.path.insert(0, str(TOOL.parent))
SPEC = importlib.util.spec_from_file_location("refactor_comparison", TOOL)
comparison = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(comparison)


def native_record():
    return {
        "schemaVersion": "chenlong.run-record/v4", "runId": "old-run",
        "sourceCode": "print('old')", "clientStartedAt": "old-wall-time",
        "inputs": [{"seq": 3, "t": 0, "tick": 0, "type": "navigation_query",
                    "method": "odometry", "result": {"forwardCm": 0, "rightCm": 0,
                    "headingDeg": 0, "distanceCm": 0, "tick": 0}}],
        "events": [{"seq": 1, "t": 0, "type": "run_started", "mapVersion": "same-map"},
                   {"seq": 4, "t": 20, "type": "run_finished", "score": 40,
                    "reason": "program_finished"}],
        "result": {"score": 40, "durationSeconds": .02, "simulationTick": 1,
                   "completedTasks": 0, "reason": "program_finished"},
    }


def write_layout(folder, map_name, record=None, lines=None):
    record = record or native_record()
    archive = folder / "attempts" / (map_name + ".record.json")
    archive.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(record).encode()
    archive.write_bytes(payload)
    version = {"event": "program_version", "version": "old-version",
               "file_sha256": hashlib.sha256(record["sourceCode"].encode()).hexdigest(),
               "wm_kit_commit": "a" * 40, "wm_embed_sha256": "b" * 64,
               "turn_cost_k": .06, "turn_calibration_sha256": "c" * 64}
    raw = {"assignedMap": map_name, "timedOut": False, "stallReason": None,
           "fullRecordFile": "attempts/" + archive.name, "lines": lines if lines is not None else [version],
           "record": {"events": record["events"]}, "score": {"total": "40"},
           "fullRecordExport": {"sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)}}
    (folder / (map_name + ".json")).write_text(json.dumps(raw))


class StrictNativeComparisonTests(unittest.TestCase):
    def test_identical_arrays_and_score_pass(self):
        result = comparison.compare_records(native_record(), native_record())
        self.assertTrue(all(result[k]["equal"] for k in ("inputs", "events", "score")))

    def test_any_input_leaf_change_fails(self):
        candidate = native_record()
        candidate["inputs"][0]["result"]["distanceCm"] = .000000000001
        result = comparison.compare_records(native_record(), candidate)
        self.assertFalse(result["inputs"]["equal"])
        self.assertEqual(result["inputs"]["differences"][0]["path"], "/inputs/0/result/distanceCm")

    def test_event_value_change_fails(self):
        candidate = native_record()
        candidate["events"][1]["reason"] = "changed"
        self.assertFalse(comparison.compare_records(native_record(), candidate)["events"]["equal"])

    def test_time_seq_evidence_id_never_normalized(self):
        for field in ("tick", "t", "seq", "evidenceId", "frameId", "sha256", "version"):
            with self.subTest(field=field):
                left, right = native_record(), native_record()
                left["inputs"][0][field] = 1
                right["inputs"][0][field] = 2
                self.assertFalse(comparison.compare_records(left, right)["inputs"]["equal"])

    def test_types_keys_lengths_and_order_are_strict(self):
        mutations = [
            lambda r: r["inputs"][0]["result"].update(tick=False),
            lambda r: r["inputs"][0]["result"].update(tick=0.0),
            lambda r: r["inputs"][0]["result"].pop("tick"),
            lambda r: r["inputs"].append(copy.deepcopy(r["inputs"][0])),
        ]
        for change in mutations:
            candidate = native_record()
            change(candidate)
            self.assertFalse(comparison.compare_records(native_record(), candidate)["inputs"]["equal"])
        candidate = native_record()
        candidate["events"].reverse()
        self.assertFalse(comparison.compare_records(native_record(), candidate)["events"]["equal"])

    def test_score_change_and_bool_score_fail(self):
        for changed in (41, True, None, "40", 40.0):
            candidate = native_record()
            candidate["result"]["score"] = changed
            self.assertFalse(comparison.compare_records(native_record(), candidate)["score"]["equal"])

    def test_object_key_order_is_irrelevant(self):
        candidate = native_record()
        candidate["inputs"][0] = dict(reversed(list(candidate["inputs"][0].items())))
        self.assertTrue(comparison.compare_records(native_record(), candidate)["inputs"]["equal"])


class RoundComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name) / "baseline"
        self.candidate = Path(self.temp.name) / "candidate"
        for folder in (self.base, self.candidate):
            for map_name in comparison.MAPS:
                write_layout(folder, map_name)

    def compare(self):
        return comparison.compare_rounds(self.candidate, self.base)

    def test_legal_code_metadata_only_changes_pass(self):
        for map_name in comparison.MAPS:
            record = native_record()
            record.update(sourceCode="print('refactored')", runId="new-run", clientStartedAt="new-wall-time")
            write_layout(self.candidate, map_name, record)
            path = self.candidate / (map_name + ".json")
            raw = json.loads(path.read_text())
            raw["lines"][0].update(version="new-version", wm_kit_commit="d"*40, wm_embed_sha256="e"*64)
            path.write_text(json.dumps(raw))
        report = self.compare()
        self.assertTrue(report["all_pass"])
        self.assertEqual(report["passing_layouts"], 10)
        self.assertTrue(all(row["program_log_diagnostic"]["equal_except_code_identity"] for row in report["layouts"]))

    def test_missing_native_record_is_failure_not_dropped_layout(self):
        (self.candidate / "attempts/map-05.record.json").unlink()
        report = self.compare()
        self.assertFalse(report["all_pass"])
        self.assertEqual(len(report["layouts"]), 10)
        self.assertEqual(report["passing_layouts"], 9)

    def test_equal_program_errors_still_fail(self):
        record = native_record()
        record["events"].insert(1, {"seq": 2, "t": 0, "type": "program_error", "error": "NameError"})
        for folder in (self.base, self.candidate):
            write_layout(folder, "map-01", record)
        report = self.compare()
        self.assertFalse(report["all_pass"])
        self.assertTrue(report["layouts"][0]["events"]["equal"])
        self.assertFalse(report["layouts"][0]["gates"]["both_runs_valid_without_errors"])

    def test_timeout_and_unfinished_record_fail(self):
        path = self.candidate / "map-01.json"
        raw = json.loads(path.read_text());raw["timedOut"] = True
        path.write_text(json.dumps(raw))
        self.assertFalse(self.compare()["all_pass"])
        record = native_record();record["events"].pop()
        write_layout(self.candidate, "map-01", record)
        self.assertFalse(self.compare()["all_pass"])

    def test_diagnostics_never_add_raw_log_or_full_result_gate(self):
        record = native_record();record["result"]["durationSeconds"] = 99
        write_layout(self.candidate, "map-01", record, [{"event": "different_diagnostic"}])
        report = self.compare()
        self.assertTrue(report["all_pass"])
        row = report["layouts"][0]
        self.assertFalse(row["full_result_diagnostic"]["equal"])
        self.assertFalse(row["program_log_diagnostic"]["equal_except_code_identity"])

    def test_only_four_program_identity_fields_are_diagnostic_exceptions(self):
        path = self.candidate / "map-01.json"
        raw = json.loads(path.read_text())
        raw["lines"][0]["turn_calibration_sha256"] = "f" * 64
        path.write_text(json.dumps(raw))
        report = self.compare()
        self.assertTrue(report["all_pass"])
        self.assertFalse(report["layouts"][0]["program_log_diagnostic"]["equal_except_code_identity"])
        raw["lines"][0].pop("file_sha256")
        path.write_text(json.dumps(raw))
        self.assertFalse(self.compare()["layouts"][0]["program_log_diagnostic"]["equal_except_code_identity"])

    def test_candidate_cannot_reuse_baseline_native_path(self):
        path = self.candidate / "map-01.json"
        raw = json.loads(path.read_text())
        raw["fullRecordFile"] = str(self.base / "attempts/map-01.record.json")
        path.write_text(json.dumps(raw))
        self.assertFalse(self.compare()["all_pass"])

    def test_old_checkout_artifact_paths_are_relocated_with_round_containment(self):
        import platform_paths
        relocated = Path(self.temp.name) / "artifacts/refactor/candidate"
        for map_name in comparison.MAPS:
            write_layout(relocated, map_name)
            path = relocated / (map_name + ".json")
            raw = json.loads(path.read_text())
            raw["fullRecordFile"] = "/old/checkout/artifacts/refactor/candidate/attempts/" + map_name + ".record.json"
            path.write_text(json.dumps(raw))
        with patch.object(platform_paths, "ROOT", Path(self.temp.name).resolve()):
            report = comparison.compare_rounds(relocated, self.base)
            self.assertTrue(report["all_pass"])
            path = relocated / "map-01.json"
            raw = json.loads(path.read_text())
            raw["fullRecordFile"] = "/old/checkout/artifacts/refactor/other-round/attempts/map-01.record.json"
            path.write_text(json.dumps(raw))
            self.assertFalse(comparison.compare_rounds(relocated, self.base)["all_pass"])

    def test_invalid_json_number_and_missing_score_fail(self):
        path = self.candidate / "attempts/map-01.record.json"
        path.write_text(path.read_text().replace('"score": 40', '"score": NaN'))
        self.assertFalse(self.compare()["all_pass"])
        record = native_record();record["result"].pop("score")
        write_layout(self.candidate, "map-01", record)
        self.assertFalse(self.compare()["all_pass"])

    def test_missing_log_remains_diagnostic(self):
        path = self.candidate / "map-01.json"
        raw = json.loads(path.read_text());raw["lines"] = None
        path.write_text(json.dumps(raw))
        self.assertTrue(self.compare()["all_pass"])


if __name__ == "__main__":
    unittest.main()
