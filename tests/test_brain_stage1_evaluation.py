"""Stage-one evaluation must corroborate the task and the recorded LLM choice."""
import copy

from test_brain_evaluation import evaluation, fixture_data
from brain_evidence_fixtures import task_fixture


def test_stage1_accepts_two_observed_deliveries_without_map_completion():
    result = evaluation.evaluate_task_scope(*task_fixture())
    assert result["stage"] == "stage-1" and result["failures"] == []


def test_native_truth_or_summary_status_cannot_replace_observation_ledger():
    summary, observations, rounds, calls, bridge, motions = task_fixture()
    summary["action_evidence"] = []
    summary["status"] = "done"
    result = evaluation.evaluate_task_scope(summary, observations, rounds, calls, bridge, motions)
    assert "task_completion:required_delivery_count_not_met" in result["failures"]


def test_done_must_be_selected_by_the_recorded_model():
    summary, observations, rounds, calls, bridge, motions = task_fixture()
    rounds[-1]["llm_output"] = {}
    result = evaluation.evaluate_task_scope(summary, observations, rounds, calls, bridge, motions)
    assert "done_not_selected_in_recorded_llm_call" in result["failures"]


def test_model_and_same_frame_evidence_are_acceptance_gates():
    summary, observations, rounds, calls, bridge, motions = task_fixture()
    calls[0]["request"]["temperature"] = .6
    observations[5]["perception"]["detections"] = []
    result = evaluation.evaluate_task_scope(summary, observations, rounds, calls, bridge, motions)
    assert "formal_model_configuration_mismatch" in result["failures"]
    assert "delivery_ledger_missing_same_frame_observation" in result["failures"]


def test_interrupted_model_call_remains_a_missing_evidence_failure():
    _, _, _, calls, _, _ = task_fixture()
    started = dict(calls[0], event="started")
    assert evaluation.evaluate_call_lifecycle(calls, [started])["failures"]
    finished = dict(calls[0], event="finished")
    assert evaluation.evaluate_call_lifecycle(calls, [started, finished])["failures"] == []


def test_final_allowed_round_done_is_not_an_extra_round(fixture_data):
    data = copy.deepcopy(fixture_data)
    data["metadata"]["maxRounds"] = 2
    result = evaluation.evaluate_delivery(data["record"], data["rounds"], data["summary"],
                                          data["metadata"], data["observations"])
    assert "round_limit_reached" not in result["failures"]
