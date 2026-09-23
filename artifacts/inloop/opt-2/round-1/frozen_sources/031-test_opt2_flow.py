"""Two-object bookkeeping and public-choice orchestration, without simulation."""
import ast
import importlib.util
from pathlib import Path
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("demo_test_helpers", ROOT / "tests/test_demo_flow.py")
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


def namespace(tracks=()):
    ns, machine = demo.namespace(tracks)
    source = (ROOT / "programs/opt2_flow_fragment.py").read_text()
    exec(compile(source, "opt2-flow", "exec"), ns)
    ns.update(TURN_COST_K=0.1, edge_by_road={}, nav_road_state=Mock(return_value={"onRoad": True}),
              select_target=Mock(return_value={"selected_candidate_id": None, "status": "unknown"}))
    return ns, machine


def test_per_ball_approach_resets_but_observe_guard_and_geometry_remain():
    ns, _ = namespace([demo.target("one")])
    ns["STATE"].update(observe_count=61, approach_calls=3, last_observe_pose=[1, 2, 3])
    ns["NAV_STATE"].update(queries=321, controls=123)
    ns["VP_STATE"]["roads"]["a"] = [{"s": 20, "x": 0, "z": .2}]
    ns["_demo_reset_ball"](2)
    assert ns["STATE"]["approach_calls"] == 0
    assert ns["STATE"]["observe_count"] == 61
    assert ns["STATE"]["last_observe_pose"] == [1, 2, 3]
    assert ns["NAV_STATE"]["queries"] == 321 and ns["NAV_STATE"]["controls"] == 123
    assert ns["VP_STATE"]["roads"]["a"] == [{"s": 20, "x": 0, "z": .2}]


def test_one_unscorable_memory_object_is_explicitly_not_called_optimal():
    target = demo.target("one")
    ns, _ = namespace([target])
    assert ns["_demo_memory_target"]() is target
    choice = ns["DEMO_STATE"]["selection_snapshot"]["selection"]
    assert choice["status"] == "unknown" and choice["selected_candidate_id"] is None
    assert choice["execution_choice_reason"] == "unique_memory_candidate_cost_unknown"


def test_ranked_public_cost_overrides_confidence_and_excludes_delivered():
    near, other, delivered = (demo.target("one", confidence=.99), demo.target("two", 3, 3, .7),
                              demo.target("delivered", 7, 7))
    ns, _ = namespace([near, other, delivered])
    ns["DEMO_STATE"]["delivered_track_ids"].add(delivered.obj_id)
    ns["select_target"].return_value = {"selected_candidate_id": "two", "status": "selected"}
    assert ns["_demo_memory_target"]() is other
    inputs = ns["select_target"].call_args.args[0]
    assert {item["obj_id"] for item in inputs} == {"one", "two"}
    assert ns["select_target"].call_args.args[-1] == .1


def test_unscorable_multiple_objects_do_not_fabricate_a_cost_ranking():
    ns, _ = namespace([demo.target("one"), demo.target("two", 3, 3)])
    assert ns["_demo_memory_target"]() is None
    assert ns["DEMO_STATE"]["selection_snapshot"]["selected_track_id"] is None


def test_selection_snapshot_logs_once_at_lock(capsys):
    ns, _ = namespace([demo.target("one")])
    ns["_demo_reset_ball"](1)
    ns["_wm_target"]()
    ns["_wm_target"]()
    events = demo.recorded(capsys)
    selections = [item for item in events if item["event"] == "target_selection"]
    assert len(selections) == 1 and selections[0]["selected_track_id"] == "one"
    assert selections[0]["wm_candidates"][0]["obj_id"] == "one"
    assert selections[0]["tick"] == 123


def test_second_patrol_budget_is_remaining_global_allowance():
    ns, _ = namespace()
    ns["STATE"]["observe_count"] = 65
    ns["patrol_until_target_seen"] = Mock(return_value=None)
    ns["_demo_fail"] = Mock()
    ns["run_target_flow"]()
    assert ns["patrol_until_target_seen"].call_args.kwargs == {"max_obs": 92}


def test_fixed_confirmation_and_release_helpers_still_exact_demo():
    old = ast.parse((ROOT / "programs/demo_flow_fragment.py").read_text())
    new = ast.parse((ROOT / "programs/opt2_flow_fragment.py").read_text())
    funcs = lambda tree: {node.name: ast.dump(node) for node in tree.body if isinstance(node, ast.FunctionDef)}
    for name in ("_demo_release_active_target", "_demo_detection_excluded", "_demo_filter_observations"):
        assert funcs(old)[name] == funcs(new)[name]
