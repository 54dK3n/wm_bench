"""The wiring goal is explicitly separate from the unchanged two-ball gate."""
from test_brain_evaluation import evaluation, fixture_data, write_fixture


def test_one_delivery_passes_smoke_physics_but_cannot_pass_original_stage1(fixture_data):
    data = fixture_data
    record = data["record"]
    missing = "truth-red-west"
    record["native"]["events"] = [row for row in record["native"]["events"] if row["packageId"] != missing]
    record["native"]["samples"][-1]["packages"][-1]["x"] = 0
    args = [record, data["rounds"], data["summary"], data["metadata"], data["observations"]]
    smoke = evaluation._evaluate_delivery(*args, required_count=1)
    assert smoke["failures"] == []
    assert len(smoke["expected_target_ids"]) == 2
    assert smoke["qualifying_delivered_target_ids"] == ["truth-red-east"]
    assert "no_active_delivery_event:" + missing in evaluation.evaluate_delivery(*args)["failures"]
    record["native"]["events"] = []
    assert "insufficient_physical_deliveries" in evaluation._evaluate_delivery(*args, required_count=1)["failures"]


def test_smoke_full_entry_does_not_accept_missing_task_or_legal_chain(tmp_path, fixture_data):
    run = write_fixture(tmp_path, fixture_data)
    result = evaluation.evaluate_one_ball_smoke(run)
    assert result["success"] is False
    assert "one_ball_smoke_missing_instruction_scope" in result["failures"]
