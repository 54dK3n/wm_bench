"""Explicit uncertainty semantics in state, evidence, and offline LLM replay."""
import copy
import json
from types import SimpleNamespace
from unittest.mock import patch

from autonomous_brain import run
from autonomous_brain.actions import Actions
from autonomous_brain.llm import LLMClient
from autonomous_brain.navigation import RoadMemory
from autonomous_brain.perception import Perception
from test_brain_perception import CAMERA, ball, observe
from test_brain_llm import legacy_record, records, response


def runtime_with_retired_history():
    perception = Perception(CAMERA)
    observe(perception, 1, time=.1, items=[ball(80)])
    observed = observe(perception, 2, time=20, items=[])
    road = {"onRoad": True, "atNode": True, "atJunction": False,
            "exits": [{"angleDeg": 0}], "frontClearanceCm": 0}
    roads = RoadMemory()
    roads.update(observed["odometry"], road)
    roads.chosen(observed["odometry"], 0, blocked=True)
    runtime = object.__new__(run.Runtime)
    runtime.perception, runtime.roads = perception, roads
    runtime.config, runtime.round = {"task": "把观察并确认的红球送入存放区"}, 2
    runtime.bridge = SimpleNamespace(seconds=20)
    runtime.held_object_id = runtime.pending_grasp = None
    runtime.recent = []
    runtime.snapshot = {"observation_index": 2, "observation": observed["raw_observation"],
                        "odometry": observed["odometry"], "road": road,
                        "holding": {"holding": False}}
    return runtime


def test_retirement_basis_reaches_done_evidence_and_next_state_without_rewriting_lost():
    runtime = runtime_with_retired_history()
    original = copy.deepcopy(runtime.perception.timeline())
    outcome = Actions(runtime).done()
    assert outcome["success"] is True
    completion = runtime.state()["completion"]
    assert completion["pending_objects"] == []
    retired = completion["retired_unconfirmed_hypotheses"]
    assert len(retired) == 1
    assert retired[0]["reason"] == "archived_without_confirmation"
    assert retired[0]["confirmed_s"] is None and retired[0]["hit_count"] == 1
    assert retired == outcome["evidence"]["retired_unconfirmed_hypotheses"]
    summary = run.compact_action_result(2, {"action": "done", "params": {}}, outcome, 2)
    runtime.recent.append(summary)
    state = runtime.state()
    row = state["objects"][0]
    assert row["status"] == "LOST" and row["ever_confirmed"] is False
    assert row["completion_classification"] == "retired_unconfirmed_hypothesis"
    assert state["recent_actions"][0]["evidence"]["retired_unconfirmed_hypotheses"] == retired
    state["completion"]["retired_unconfirmed_hypotheses"][0]["reason"] = "mutated"
    state["recent_actions"][0]["evidence"]["retired_unconfirmed_hypotheses"][0]["reason"] = "mutated"
    assert runtime.perception.timeline() == original
    assert runtime.state()["completion"]["retired_unconfirmed_hypotheses"] == retired
    assert runtime.recent[0]["evidence"]["retired_unconfirmed_hypotheses"] == retired


def test_live_prompt_carries_explicit_retirement_semantics_and_unchanged_sensor_state(tmp_path):
    state = runtime_with_retired_history().state()
    fake = {"LLM_BASE_URL": "https://model.invalid/v1", "LLM_API_KEY": "offline-fixture",
            "LLM_MODEL": "offline-model"}
    with patch.dict("os.environ", fake, clear=True), \
            patch("urllib.request.urlopen", return_value=response('{"action":"done","params":{}}')) as send:
        with LLMClient(tmp_path / "request.jsonl") as client:
            assert client.decide(state) == {"action": "done", "params": {}}
    request = json.loads(send.call_args.args[0].data)
    assert json.loads(request["messages"][1]["content"]) == state
    prompt = request["messages"][0]["content"]
    assert "retired_unconfirmed_hypothesis" in prompt
    assert "不代表已送达" in prompt and "不代表物体不存在" in prompt
    assert "曾确认的 LOST" in prompt


def test_v9_repair_replay_keeps_its_old_prompt_and_state_exact_without_network_env_or_sleep(tmp_path):
    old_state = {"task": "搬运红球", "objects": [], "robot": {"holding": False},
                 "junction_history": [], "recent_actions": []}
    old_prompt = "历史 v9 提示：只根据当前观测选择一个动作，没有退休分类字段。"
    source = tmp_path / "v9.jsonl"
    fake = {"LLM_BASE_URL": "https://model.invalid/v1", "LLM_API_KEY": "offline-fixture",
            "LLM_MODEL": "offline-model"}
    with patch.dict("os.environ", fake, clear=True), patch("urllib.request.urlopen", side_effect=[
            response("invalid json"), response('{"action":"look_around","params":{}}')]):
        with LLMClient(source) as client:
            client.system_prompt = old_prompt
            expected = client.decide(old_state)
    saved = [legacy_record(row, "autonomous-brain-llm/v9") for row in records(source)]
    source.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in saved))
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("environment read")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")), \
            patch("autonomous_brain.llm.time.sleep", side_effect=AssertionError("sleep")):
        with LLMClient(tmp_path / "replayed.jsonl", replay_path=source) as replay:
            assert replay.decide(old_state) == expected
            assert replay.call_count == 2
            replay.assert_replay_consumed()
    actual = records(tmp_path / "replayed.jsonl")
    assert [{k: v for k, v in row.items() if k != "mode"} for row in actual] == [
        {k: v for k, v in row.items() if k != "mode"} for row in saved]
    assert all(row["request"]["messages"][0]["content"] == old_prompt for row in actual)
    assert all("completion" not in json.loads(row["request"]["messages"][1]["content"]) for row in actual)
