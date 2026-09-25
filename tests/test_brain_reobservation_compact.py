"""Offline regressions for the two separate placement-return outcomes."""

import copy
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from autonomous_brain.run import compact_action_result


def placement_result():
    return {
        "success": False,
        "reason": "released_ball_not_verified_in_storage",
        "evidence": {
            "object_id": "released-red",
            "holding": False,
            "frame_id": 584,
            "after_observation": 584,
            "post_observation": 584,
            "placement": None,
            "candidate_witnesses": 0,
            "road_return": {
                "success": True,
                "reason": "returned_to_observed_road",
                "on_road": True,
                "anchor_observation": 545,
                "after_observation": 571,
            },
            "reobservation": {
                "reason": "viewpoint_left_observed_road",
                "after_observation": 584,
                "viewpoints": [{"viewpoint": 1, "distance_cm": 16}],
                "road_return": {
                    "success": False,
                    "reason": "recorded_return_blocked",
                    "on_road": False,
                    "anchor_observation": 582,
                    "after_observation": 584,
                },
            },
        },
    }


def compact(result):
    return compact_action_result(75, {"action": "place", "params": {}}, result, 585)


def test_later_failed_return_is_visible_alongside_original_success_and_frame():
    result = placement_result()
    evidence = compact(result)["evidence"]

    assert evidence["road_return"] == result["evidence"]["road_return"]
    later = evidence["reobservation"]
    assert later == {
        "reason": "viewpoint_left_observed_road",
        "after_observation": 584,
        "viewpoint_count": 1,
        "road_return": result["evidence"]["reobservation"]["road_return"],
    }
    assert evidence["road_return"]["success"] is True
    assert later["road_return"]["success"] is False
    assert evidence["road_return"]["after_observation"] == 571
    assert later["road_return"]["after_observation"] == 584
    assert evidence["holding"] is False
    assert evidence["placement"] is None


def test_verified_delivery_frame_is_independent_of_later_failed_road_return():
    result = placement_result()
    result.update(success=True, reason="ball_observed_in_storage")
    result["evidence"].update(
        post_observation=580,
        candidate_witnesses=1,
        placement={"frame_id": 580, "ball_bbox": {"x": 282, "y": 208, "w": 78, "h": 64}},
    )
    summary = compact(result)

    assert summary["success"] is True
    assert summary["evidence"]["post_observation"] == 580
    assert summary["evidence"]["placement"]["frame_id"] == 580
    assert summary["evidence"]["frame_id"] == 584
    assert summary["evidence"]["reobservation"]["road_return"]["success"] is False
    assert summary["evidence"]["reobservation"]["road_return"]["after_observation"] == 584


def test_unknown_nested_fields_and_full_viewpoint_payload_do_not_enter_state():
    result = placement_result()
    raw = result["evidence"]
    unknown = {"unrecognized_payload": {"nested": "must-stay-in-full-log"}}
    raw.update(copy.deepcopy(unknown))
    raw["road_return"].update(copy.deepcopy(unknown))
    reobservation = raw["reobservation"]
    reobservation.update(copy.deepcopy(unknown))
    reobservation["road_return"].update(copy.deepcopy(unknown))
    reobservation.update(
        trajectory=[copy.deepcopy(unknown)],
        aiming_region=copy.deepcopy(unknown),
        initial_verification=copy.deepcopy(unknown),
    )
    reobservation["viewpoints"][0].update(copy.deepcopy(unknown))
    original = copy.deepcopy(result)
    summary = compact(result)
    encoded = json.dumps(summary, allow_nan=False)

    for excluded in (
        "unrecognized_payload", "must-stay-in-full-log", "trajectory",
        "aiming_region", "initial_verification", "distance_cm", "viewpoints",
    ):
        assert excluded not in encoded
    assert summary["evidence"]["reobservation"]["viewpoint_count"] == 1
    summary["evidence"]["road_return"]["success"] = False
    summary["evidence"]["reobservation"]["road_return"]["success"] = True
    assert result == original


def test_actions_without_reobservation_keep_the_previous_compact_shape():
    result = placement_result()
    del result["evidence"]["reobservation"]
    expected = compact(result)
    assert "reobservation" not in expected["evidence"]

    result["evidence"]["reobservation"] = None
    assert compact(result) == expected


def test_missing_old_identity_is_explicit_even_when_one_pixel_witness_exists():
    result = placement_result()
    result["evidence"]["candidate_witnesses"] = 1
    raw = result["evidence"]["reobservation"]
    raw.update(old_objects_reobserved=False, required_delivered_ids=["old", 1, None],
               observed_delivered_ids=[])
    summary = compact(result)["evidence"]
    assert summary["candidate_witnesses"] == 1
    assert summary["reobservation"]["old_objects_reobserved"] is False
    assert summary["reobservation"]["required_delivered_ids"] == ["old"]
    assert summary["reobservation"]["observed_delivered_ids"] == []
    summary["reobservation"]["required_delivered_ids"].append("unrelated")
    assert raw["required_delivered_ids"] == ["old", 1, None]
