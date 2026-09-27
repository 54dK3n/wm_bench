"""Bounded feedback from smoke-01 r35; this does not authorize any grasp."""
import copy
from types import SimpleNamespace

from autonomous_brain.actions import Actions
from autonomous_brain.run import compact_action_result


def test_identity_competition_feedback_retains_r35_blocker_without_changing_guard():
    # Minimal public excerpt, not the full runtime observation or model log.
    source = {"success": False, "reason": "grab_identity_competition", "evidence": {
        "grab_authorization": {"authorized": False, "reason": "grab_identity_competition",
            "object_id": "target_027", "observation_index": 184, "frame_id": "184", "holding": False,
            "candidate_ids_by_detection": [["target_017", "target_027"], ["target_038"]],
            "target_detection_indices": [0], "object": {"all_history": "omit"}},
        "authorization_recovery": {"success": False, "reason": "no_recorded_confirmed_view",
                                   "motions": ["omit"]}}}
    original = copy.deepcopy(source)
    action = {"action": "pick", "params": {"object_id": "target_027"}}
    out = compact_action_result(35, action, source, 185)["evidence"]
    auth = out["grab_authorization"]
    assert auth["target_candidates"] == [{"detection_index": 0, "candidate_count": 2,
                                           "candidate_ids": ["target_017", "target_027"]}]
    assert (auth["observation_index"], auth["frame_id"], auth["object_id"]) == (184, "184", "target_027")
    assert "candidate_ids_by_detection" not in auth and "object" not in auth
    assert "target_038" not in str(auth)
    assert out["authorization_recovery"] == {"success": False, "reason": "no_recorded_confirmed_view"}
    assert "不能解除身份竞争" in auth["recovery_guidance"]
    assert source == original

    key = ("pick", "target_027")
    context = {"position_m": [0, 0], "heading_deg": 0, "on_road": True, "at_node": False,
        "holding": False, "target_state": "CONFIRMED", "visible": True, "known_paths": [],
        "target_position_m": [0, .22], "distance_cm": 22, "bearing_deg": 0,
        "heading_error_deg": 0, "left_clearance_cm": 20, "right_clearance_cm": 20,
        "front_clearance_cm": 100, "exit_headings_deg": []}
    r = SimpleNamespace(navigation_progress=SimpleNamespace(action_failures={key: [
        {"reason": "grab_identity_competition", "context": context}]}))
    actions = Actions(r)
    actions._manipulation_failure_context = lambda _: (key, context)
    actions.result = lambda success, reason, **evidence: dict(success=success, reason=reason, evidence=evidence)
    blocked = actions.action_failure_guard(action)
    assert blocked["success"] is False and blocked["reason"] == "action_repeat_without_new_evidence"
    assert "go_to_a_confirmed_operation_position" not in blocked["evidence"]["recovery_options"]
    assert any("explore" in item for item in blocked["evidence"]["recovery_options"])
    r.navigation_progress.action_failures[key][0]["reason"] = "target_too_far_for_pick"
    assert "go_to_a_confirmed_operation_position" in actions.action_failure_guard(action)["evidence"]["recovery_options"]

    source["evidence"]["grab_authorization"].update(
        candidate_ids_by_detection=[[f"id-{i}" for i in range(20)] for _ in range(10)],
        target_detection_indices=list(range(10)))
    bounded = compact_action_result(35, action, source, 185)["evidence"]["grab_authorization"]
    assert bounded["target_detection_count"] == 10 and len(bounded["target_candidates"]) == 3
    assert all(row["candidate_count"] == 20 and len(row["candidate_ids"]) == 12
               for row in bounded["target_candidates"])
