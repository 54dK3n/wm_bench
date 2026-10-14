"""Fixed task scope consumes positive separation, never absence of a relation.

Synthetic ledger-shaped unit fixtures exercise completion consumption only.
Production Perception owns the source authorization and its pixel validation;
these are not simulator runs or new physical-identity observations.
"""
import copy

import pytest

from autonomous_brain.task import completion_progress, parse_task
from test_brain_task_scope import ledger, progress

EXTRA = "independent-extra"


def separate_witness_ledger(state="LOST"):
    rows, events = ledger()
    rows.append({"id": EXTRA, "category": "red-ball", "state": state, "ever_confirmed": True})
    for number, event in enumerate(events):
        if event["action"] != "pick":
            continue
        oid = event["object_id"]
        index = 100 + number
        frame = str(index)
        command = {"round": number + 1, "before_observation": index,
                   "bridge_sequence": index, "bridge_request_id": f"brain-{index:06d}"}
        items = []
        for ident, x in ((oid, 300), (EXTRA, 80)):
            items.append({"category": "red-ball", "source": "virtual-cv", "frame_id": frame,
                "track_id": ident, "bbox": {"x": x, "y": 220, "w": 30, "h": 30},
                "pixel_quality": {"schema": "red-component-quality/v1", "frameId": index,
                    "componentPixels": 900, "redSectorPixels": 850,
                    "status": "supported", "reason": "red_sector_majority"}})
        authorization = {"schema": "brain-grab-authorization/v1", "canonical_object_id": oid,
            "object": {"id": oid, "category": "red-ball", "state": "CONFIRMED"},
            "holding": False, "observation_index": index, "frame_id": frame,
            "detections": items, "candidate_ids_by_detection": [[oid], [EXTRA]],
            "detection_index": 0, "target_detection_indices": [0], "command_ref": command}
        event["evidence"]["post_observation"] = index + 3
        event["evidence"]["grasp_chain"] = {"schema": "brain-grasp-chain/v1", "object_id": oid,
            "grab": {**command, "object_id": oid, "before_holding": False,
                     "after_observation": index + 1, "outcome_unknown": False,
                     "authorization": authorization}}
    return rows, events


def proof(events, event_index=0):
    return events[event_index]["evidence"]["grasp_chain"]["grab"]["authorization"]


@pytest.mark.parametrize("state", ["CONFIRMED", "STALE", "LOST"])
def test_independently_distinct_extra_does_not_expand_known_delivery_count(state):
    rows, events = separate_witness_ledger(state)
    original = copy.deepcopy((rows, events))
    result = progress(rows, events)
    assert result["ready_for_done"] is True
    assert result["delivered_count"] == 2
    assert result["delivered_object_ids"] == ["red-a", "red-b"]
    assert result["pending_objects"] == [EXTRA]  # No history is deleted/resolved.
    assert result["known_quantity_excluded_history_ids"] == ([EXTRA] if state == "LOST" else [])
    assert (rows, events) == original


@pytest.mark.parametrize("fault", ["no-authorization", "only-one-delivery-proof", "absent-extra",
    "extra-not-a-candidate", "competing-candidate", "wrong-track", "duplicate-frame-box",
    "overlapping-box", "unknown-pixels", "wrong-quality-frame", "stale-frame",
    "invalid-command", "unknown-grab", "missing-grab-readback", "duplicate-identity",
    "missing-extra-quality", "missing-selected-quality", "boundary-box", "false-supported-counts"])
def test_lost_extra_with_missing_or_ambiguous_separation_stays_unresolved(fault):
    rows, events = separate_witness_ledger()
    p = proof(events)
    if fault == "no-authorization":
        for event in events:
            if event["action"] == "pick":
                event["evidence"].pop("grasp_chain")
    elif fault == "only-one-delivery-proof":
        events[2]["evidence"].pop("grasp_chain")
    elif fault == "absent-extra":
        p["detections"].pop(); p["candidate_ids_by_detection"].pop()
    elif fault == "extra-not-a-candidate":
        p["candidate_ids_by_detection"][1] = []
    elif fault == "competing-candidate":
        p["candidate_ids_by_detection"][1].append("red-a")
    elif fault == "wrong-track":
        p["detections"][1]["track_id"] = "unrelated-label"
    elif fault == "duplicate-frame-box":
        p["detections"][1]["bbox"] = copy.deepcopy(p["detections"][0]["bbox"])
    elif fault == "overlapping-box":
        p["detections"][1]["bbox"]["x"] = 320
    elif fault == "unknown-pixels":
        p["detections"][1]["pixel_quality"].update(status="unknown", reason="red_sector_not_majority", redSectorPixels=0)
    elif fault == "wrong-quality-frame":
        p["detections"][1]["pixel_quality"]["frameId"] += 1
    elif fault == "stale-frame":
        p["detections"][1]["frame_id"] = "99"
    elif fault == "invalid-command":
        p["command_ref"]["bridge_request_id"] = "brain-999999"
    elif fault == "unknown-grab":
        events[0]["evidence"]["grasp_chain"]["grab"]["outcome_unknown"] = True
    elif fault == "missing-grab-readback":
        events[0]["evidence"]["grasp_chain"]["grab"]["after_observation"] = None
    elif fault == "missing-extra-quality":
        p["detections"][1].pop("pixel_quality")
    elif fault == "missing-selected-quality":
        p["detections"][0].pop("pixel_quality")
    elif fault == "boundary-box":
        p["detections"][1]["bbox"]["x"] = 0
    elif fault == "false-supported-counts":
        p["detections"][1]["pixel_quality"]["redSectorPixels"] = 1
    else:
        duplicate = copy.deepcopy(p["detections"][1]); duplicate["bbox"]["x"] = 180
        p["detections"].append(duplicate); p["candidate_ids_by_detection"].append([EXTRA])
    result = progress(rows, events)
    assert result["delivered_count"] == 2
    assert result["ready_for_done"] is False
    assert EXTRA in result["unresolved_identity_ids"]
    assert result["known_quantity_excluded_history_ids"] == []


@pytest.mark.parametrize("fault", ["extra-action", "extra-alias", "incoming-alias", "invalid-reacquisition",
    "extra-ambiguity", "delivered-ambiguity", "shared-delivery-witness", "invalid-delivery"])
def test_identity_and_manipulation_obligations_cannot_be_scoped_away(fault):
    rows, events = separate_witness_ledger()
    if fault == "extra-action":
        events.append({"action": "release_unverified", "object_id": EXTRA, "holding": False})
    elif fault == "extra-alias":
        rows[-1]["alias_of"] = "missing-object"
    elif fault == "incoming-alias":
        rows.append({"id": "alias-extra", "category": "red-ball", "state": "STALE", "alias_of": EXTRA})
    elif fault == "invalid-reacquisition":
        rows[-1]["reacquisition_binding"] = {"version": "invalid", "current_object_id": "red-a"}
    elif fault == "extra-ambiguity":
        rows[-1]["identity_ambiguity"] = {"candidate_ids": [EXTRA, "red-a"]}
    elif fault == "delivered-ambiguity":
        rows[0]["identity_ambiguity"] = {"candidate_ids": [EXTRA, "red-a"]}
    elif fault == "shared-delivery-witness":
        events[3]["evidence"]["placement"] = copy.deepcopy(events[1]["evidence"]["placement"])
    else:
        events[3]["evidence"]["candidate_witnesses"] = 2
    result = progress(rows, events)
    assert result["ready_for_done"] is False
    assert "delivery_identity_or_evidence_unresolved" in result["unmet_conditions"]
    assert result["known_quantity_excluded_history_ids"] == []


@pytest.mark.parametrize("options", [{"holding": True}, {"held_object_id": EXTRA},
                                     {"pending_grasp": {"object_id": EXTRA}}])
def test_current_unresolved_gripper_blocks_even_with_separation_proof(options):
    result = progress(*separate_witness_ledger(), **options)
    assert result["ready_for_done"] is False
    assert "gripper_or_grasp_not_resolved" in result["unmet_conditions"]


@pytest.mark.parametrize("state", ["HELD", "RELEASED_UNVERIFIED"])
def test_extra_manipulation_state_keeps_original_gate(state):
    result = progress(*separate_witness_ledger(state))
    assert result["ready_for_done"] is False
    assert EXTRA in result["unresolved_identity_ids"]


def test_unknown_quantity_keeps_extra_obligation_and_complete_exploration_requirement():
    rows, events = separate_witness_ledger()
    result = completion_progress(rows, events, parse_task("把地图上的红球都送到绿色存放区"),
        holding=False, nodes=1, unexplored=0, observed_detections=[],
        discovery_evidence={"schema": "brain-discovery-evidence/v2", "records": [], "unresolved": [], "resolutions": []},
        exploration={"schema": "brain-road-exploration/v1", "complete": True,
                     "state_counts": {"unexplored": 0, "exploring": 0, "verified": 1, "blocked": 0, "unresolved": 0},
                     "pending_exit_count": 0, "unresolved_node_count": 0, "unresolved_connection_count": 0})
    assert result["ready_for_done"] is False
    assert EXTRA in result["pending_objects"] and EXTRA in result["unresolved_identity_ids"]
    assert "observed_targets_pending" in result["unmet_conditions"]
    assert result["known_quantity_excluded_history_ids"] == []


def test_separation_does_not_replace_missing_second_delivery():
    rows, events = separate_witness_ledger()
    rows = [r for r in rows if r["id"] != "red-b"]
    events = [e for e in events if e["object_id"] != "red-b"]
    result = progress(rows, events)
    assert result["delivered_count"] == 1 and not result["ready_for_done"]
    assert "required_delivery_count_not_met" in result["unmet_conditions"]
    assert result["known_quantity_excluded_history_ids"] == []


def test_later_pick_cannot_supply_exclusion_for_an_earlier_delivery():
    rows, events = separate_witness_ledger()
    later_pick = copy.deepcopy(events[0])
    events[0]["evidence"].pop("grasp_chain")
    events.append(later_pick)
    result = progress(rows, events)
    assert result["delivered_count"] == 2
    assert result["ready_for_done"] is False
    assert EXTRA in result["unresolved_identity_ids"]
    assert result["known_quantity_excluded_history_ids"] == []


def test_unrelated_obstacle_competition_does_not_erase_positive_ball_separation():
    rows, events = separate_witness_ledger()
    for index in (0, 2):
        p = proof(events, index)
        p["detections"].extend([{"category": "obstacle"}, {"category": "obstacle"}])
        p["candidate_ids_by_detection"].extend([["obstacle-a", "obstacle-b"], ["obstacle-a"]])
    result = progress(rows, events)
    assert result["ready_for_done"] is True
    assert result["known_quantity_excluded_history_ids"] == [EXTRA]


@pytest.mark.parametrize("related", [EXTRA, "red-a"])
@pytest.mark.parametrize("field", ["candidate_ids", "candidate_kinds", "candidate_distances_m", "candidate_detection_indices"])
def test_incoming_ambiguity_endpoint_cannot_be_scoped_away(related, field):
    rows, events = separate_witness_ledger()
    value = [related] if field == "candidate_ids" else {related: "existing-claim"}
    rows.append({"id": "other-history", "category": "red-ball", "state": "STALE",
                 "identity_ambiguity": {field: value}})
    result = progress(rows, events)
    assert result["ready_for_done"] is False
    assert EXTRA in result["unresolved_identity_ids"]
    assert result["known_quantity_excluded_history_ids"] == []


def test_current_untracked_ambiguity_referencing_delivery_also_blocks_exception():
    rows, events = separate_witness_ledger()
    result = progress(rows, events, observed_detections=[{"category": "red-ball", "track_id": None,
        "identity_ambiguity": {"candidate_ids": ["red-a", "other-history"]}}])
    assert result["ready_for_done"] is False
    assert EXTRA in result["unresolved_identity_ids"]
