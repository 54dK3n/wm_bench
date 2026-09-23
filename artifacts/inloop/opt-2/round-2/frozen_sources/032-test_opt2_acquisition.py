"""Real WM decay and planning liveness without changing range/confirmation rules."""
import ast
import asyncio
from pathlib import Path
import sys
from unittest.mock import Mock

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "vendor/wm_kit_opt2"))
from world_model import WorldModel
from world_model.decay import DecayConfig, FovConfig
from world_model.providers.guangyang import guangyang_static_association_config
from world_model.types import Detection, ObjectState, RobotPose

SOURCE = (ROOT / "programs/opt2_acquisition_fragment.py").read_text()


def namespace():
    wm = WorldModel(assoc_cfg=guangyang_static_association_config(),
                    decay_cfg=DecayConfig(), fov_cfg=FovConfig(max_range_m=.9))
    pose = RobotPose(0, 0, 0)
    wm.update([Detection(class_name="target", x=0, z=.65, confidence=.9, timestamp=0)], pose, now=0)
    target = wm.get_scene()[0]
    ns = {"wm": wm, "ObjectState": ObjectState,
          "STATE": {"confirmation_track_id": target.obj_id, "accepted_hits": [{"track_id": target.obj_id}],
                    "frame_track_ids": {}, "observe_count": 12, "approach_calls": 0},
          "VP_STATE": {"roads": {"measured": [1]}, "local_blocks": {"actual": 1}},
          "DEMO_STATE": {"ball_index": 2, "selection_snapshot": {}},
          "_update_wm": Mock(), "_demo_event": Mock(),
          "_is_target": lambda item: item.get("category") == "target"}
    exec(SOURCE, ns)
    return ns, pose, target


@pytest.mark.parametrize("distance", [29, 93, 100])
def test_window_clipping_or_capping_never_invents_missed_detection(distance):
    ns, pose, target = namespace()
    red = [{"category": "target", "distanceCm": distance, "bearingDeg": .69, "confidence": .83}]
    ns["_opt2_update_observations"](red, pose, 25)
    assert target.confidence == .9 and target.state == ObjectState.TENTATIVE
    assert ns["STATE"]["confirmation_track_id"] == target.obj_id
    ns["_update_wm"].assert_called_once_with(red, pose, 25, memory_phase=True)


def test_real_empty_frame_uses_existing_decay_and_archives_without_deleting_history():
    ns, pose, target = namespace()
    ns["_opt2_update_observations"]([], pose, .26)
    assert target.state == ObjectState.TENTATIVE
    ns["_opt2_update_observations"]([], pose, 5.32)
    assert target.state == ObjectState.LOST and target.confidence < .15
    assert ns["wm"].get_object(target.obj_id) is target
    assert target.hit_count == 1 and target.x == 0 and target.z == .65
    assert ns["STATE"]["confirmation_track_id"] is None
    assert ns["STATE"]["accepted_hits"] == []
    assert ns["STATE"]["observe_count"] == 12
    assert ns["VP_STATE"]["roads"] == {"measured": [1]}
    assert ns["VP_STATE"]["local_blocks"] == {"actual": 1}


def test_new_empty_frame_expires_capped_ray_but_not_existing_wm_goal():
    ns, _, target = namespace()
    assert ns["_opt2_planning_evidence_expired"]({"source": "capped_bearing_only"}, [])
    assert not ns["_opt2_planning_evidence_expired"]({"source": "capped_bearing_only"}, [{"category": "target", "distanceCm": 100}])
    goal = {"source": "world_model", "track_id": target.obj_id}
    assert not ns["_opt2_planning_evidence_expired"](goal, [])
    target.state = ObjectState.LOST
    assert ns["_opt2_planning_evidence_expired"](goal, [])


def test_lost_selection_keeps_other_current_frame_associations_and_does_not_abort_them():
    ns, _, old = namespace()
    ns["STATE"]["frame_track_ids"] = {1: old.obj_id, 2: "other-real-track"}
    ns["_opt2_clear_lost_selection"](old.obj_id)
    assert ns["STATE"]["frame_track_ids"] == {2: "other-real-track"}
    ns["STATE"]["planning_goal_abandoned"] = True
    ns["_wm_target"] = Mock(return_value=object())
    assert ns["_opt2_confirmation_should_abort"]() is False
    ns["_wm_target"].assert_not_called()
    assert ns["_opt2_confirmation_should_abort"]() is True


def test_integration_only_checks_expiry_after_real_observe():
    sys.path.insert(0, str(ROOT / "tools"))
    from build_opt2_program import BASE, acquisition_bridges
    source = acquisition_bridges(BASE.read_text())
    tree = ast.parse(source)
    funcs = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    func = funcs["_try_enter_range_and_confirm"]
    expiry_calls = [node for node in ast.walk(func) if isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name) and node.func.id == "_opt2_planning_evidence_expired"]
    assert len(expiry_calls) == 1
    wrapper_calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                     and isinstance(node.func, ast.Name) and node.func.id == "_opt2_update_observations"]
    assert len(wrapper_calls) == 3
    assert not any(isinstance(node, ast.Name) and node.id == "_opt2_planning_evidence_expired"
                   for node in ast.walk(funcs["_planning_goal"]))


def test_real_async_transform_calls_bridge_before_state_check():
    ns, pose, target = namespace()
    worker = Path("/Users/ken/Desktop/robot_competition-main/projects/car-python/python-worker.js").read_text()
    loader = {"ast": ast}
    exec(worker[worker.index("class AsyncRobotTransformer("):worker.index("student_run_target =")], loader)
    tree = ast.parse(SOURCE)
    names = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)} | {"_update_wm", "_demo_event", "_is_target"}
    tree = loader["AsyncRobotTransformer"](names).visit(tree)
    ast.fix_missing_locations(tree)
    order = []
    async def update(*args, **kwargs):
        await asyncio.sleep(0)
        order.append("original_bridge")
    async def event(*args, **kwargs):
        order.append(args[0])
    async def is_target(item):
        return item.get("category") == "target"
    ns.update(_update_wm=update, _demo_event=event, _is_target=is_target)
    exec(compile(tree, "acquisition", "exec"), ns)
    asyncio.run(ns["_opt2_update_observations"]([], pose, 5.32))
    assert order[0] == "original_bridge"
    assert order[-1] == "target_search_abandoned"
    assert target.state == ObjectState.LOST
    assert not asyncio.run(ns["_opt2_planning_evidence_expired"](
        {"source": "capped_bearing_only"}, [{"category": "target", "distanceCm": 100}]))
    assert asyncio.run(ns["_opt2_planning_evidence_expired"](
        {"source": "capped_bearing_only"}, [{"category": "distractor"}]))
