"""Stage-one evaluation must corroborate the task and the recorded LLM choice."""
import copy

from test_brain_evaluation import evaluation, fixture_data
from test_brain_task_scope import ledger
from autonomous_brain.task import parse_task


def task_fixture():
    rows, events = ledger()
    call = {"call_index": 1, "action": {"action": "done", "params": {}},
            "mode": "live", "request_sha256": "a" * 64,
            "request": {"model": "deepseek-flash", "temperature": 0,
                        "thinking": {"type": "disabled"}}}
    summary = {"task": "把两个红球送到绿色存放区",
               "task_spec": parse_task("把两个红球送到绿色存放区"),
               "action_evidence": events, "final_objects": rows,
               "held_object_id": None, "pending_grasp": None,
               "junction_history": [{"exits": [{"completed": False}]}]}
    observations = []
    for event in events:
        evidence = event["evidence"]
        if event["action"] == "pick":
            observations.append({"observation_index": evidence["post_observation"],
                                 "holding": {"holding": True}})
        else:
            placement = evidence["placement"]
            observations.append({"observation": {"frameId": placement["frame_id"]},
                "holding": {"holding": False}, "perception": {"detections": [
                    {"category": "red-ball", "bbox": placement["ball_bbox"]},
                    {"category": "storage-zone", "bbox": placement["storage_bbox"]}]}})
    observations.append({"holding": {"holding": False}, "objects": rows})
    rounds = [{"action": call["action"], "llm_output": call}]
    return summary, observations, rounds, [call]


def test_stage1_accepts_two_observed_deliveries_without_map_completion():
    result = evaluation.evaluate_task_scope(*task_fixture())
    assert result["stage"] == "stage-1" and result["failures"] == []


def test_native_truth_or_summary_status_cannot_replace_observation_ledger():
    summary, observations, rounds, calls = task_fixture()
    summary["action_evidence"] = []
    summary["status"] = "done"
    result = evaluation.evaluate_task_scope(summary, observations, rounds, calls)
    assert "task_completion:required_delivery_count_not_met" in result["failures"]


def test_done_must_be_selected_by_the_recorded_model():
    summary, observations, rounds, calls = task_fixture()
    rounds[0]["llm_output"] = {}
    result = evaluation.evaluate_task_scope(summary, observations, rounds, calls)
    assert "done_not_selected_in_recorded_llm_call" in result["failures"]


def test_model_and_same_frame_evidence_are_acceptance_gates():
    summary, observations, rounds, calls = task_fixture()
    calls[0]["request"]["temperature"] = .6
    observations[1]["perception"]["detections"] = []
    result = evaluation.evaluate_task_scope(summary, observations, rounds, calls)
    assert "formal_model_configuration_mismatch" in result["failures"]
    assert "delivery_ledger_missing_same_frame_observation" in result["failures"]


def test_interrupted_model_call_remains_a_missing_evidence_failure():
    _, _, _, calls = task_fixture()
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
