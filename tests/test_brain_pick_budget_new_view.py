"""Bounded supported approach exhaustion must reach the existing view planner.

All pixels and actuator replies here are synthetic. Production Perception,
WorldModel, Actions and RoadMemory consume them; this is no competition run.
The reduced limits come from actual clipped-forward / verified-inverse actions,
not from injected permission to grasp or to navigate.
"""
import copy

import pytest

from autonomous_brain.navigation import RoadMemory, distance, position
from test_brain_grab_authorization import actual_grabs
from test_brain_pick_pixel_recovery import commands
from test_brain_supported_initial_approach import initial_runtime


def reduced_initial_probe(*, shrinks=6, recorded_road=False):
    r = initial_runtime(remaining=40, clip_gap=100)
    if recorded_road:
        r.roads = RoadMemory()
        original = r.observe

        def observe(*, motion=None):
            row = original(motion=motion)
            r.roads.update(row["odometry"], row["road"], row["observation_index"])
            finalized = dict(motion, after_observation=row["observation_index"]) if motion else None
            r.roads.observe_traversal(row, finalized)
            return row

        r.observe = observe
        r.observe()
        for method in ("backward", "forward"):
            r.actions.move(method, {"distanceCm": 20, "speed": 30})
    for index in range(shrinks):
        r.clip_after = r.forward + .01
        result = r.pick()
        assert not result["success"] and result["evidence"]["attempts"] == []
        assert result["evidence"]["authorization_recovery"]["success"]
        probe = result["evidence"]["retry_probe"]
        assert probe["probe_kind"] == "fresh_supported_approach"
        assert probe["limit_cm"] == pytest.approx(max(.1, 6 / 2 ** (index + 1)))
        assert probe["requires_new_view"] is False
        assert r.perception.check_grasp_identity(r.object_id, r.snapshot)["authorized"]
    assert not actual_grabs(r) and not r.perception._grab_authorizations
    r.clip_after = float("inf")
    return r


def consume_budget(r):
    before = copy.deepcopy(r.actions._pick_probe_limits[r.object_id])
    command_start, motion_start = len(commands(r, "forward")), len(r.records)
    result = r.pick()
    assert not result["success"] and result["reason"] == "pick_approach_view_budget_exhausted"
    evidence = result["evidence"]
    assert evidence["attempts"] == [] and evidence["road_return"]["success"] is True
    forwards = commands(r, "forward")[command_start:]
    assert len(forwards) == 10
    assert all(p["distanceCm"] == pytest.approx(before["limit_cm"]) for p in forwards)
    assert len(evidence["pick_trajectory"]) == 10
    assert all(m["motion_verification"]["motion_verified"] and not m.get("outcome_unknown")
               and m["actuator_result"]["completed"] is True for m in r.records[motion_start:])
    assert r.actions.object_geometry(r.perception.confirmed(r.object_id))[0] > 22.5
    assert not actual_grabs(r) and not r.perception._grab_authorizations
    return before, result


def test_ten_verified_small_steps_require_new_view_without_erasing_probe_or_return():
    r = reduced_initial_probe()
    old, result = consume_budget(r)
    bound = r.actions._pick_probe_limits[r.object_id]
    assert bound["requires_new_view"] is True
    assert {k: bound[k] for k in old if k != "requires_new_view"} == {
        k: v for k, v in old.items() if k != "requires_new_view"}
    returned = next(o for o in r.observations
                    if o["observation_index"] == result["evidence"]["road_return"]["after_observation"])
    assert bound["budget_return_odometry"] == returned["odometry"]
    assert bound["budget_return_observation"] == returned["observation_index"]
    assert result["evidence"]["retry_probe"] == bound
    assert r.actions.pick_probe_view_status(r.object_id)["blocked"]
    assert not r.actions.current_pick_ready(r.object_id)
    assert not r.actions.navigation_readiness(r.object_id)["operation_ready"]
    motion_count = len(r.records)
    repeated = r.pick()
    assert not repeated["success"]
    assert repeated["reason"] in {"pick_requires_new_supported_view", "action_repeat_without_new_evidence"}
    assert len(r.records) == motion_count and not actual_grabs(r)


def test_exhaustion_go_to_consumes_existing_independent_road_route():
    # .375cm is naturally learned and meets the unchanged route verifier's
    # minimum .2cm measured motion. The exact .1cm budget case is above.
    r = reduced_initial_probe(shrinks=4, recorded_road=True)
    consume_budget(r)
    bound = copy.deepcopy(r.actions._pick_probe_limits[r.object_id])
    assert bound["requires_new_view"] is True
    flags = []
    original = r.actions._road_reposition

    def observed_reposition(*args, **kwargs):
        flags.append(kwargs.get("require_new_pick_view"))
        return original(*args, **kwargs)

    r.actions._road_reposition = observed_reposition
    start = len(r.records)
    result = r.execute({"action": "go_to", "params": {"object_id": r.object_id}})
    assert flags == [True]
    attempts = result["evidence"]["road_reposition"]["attempts"]
    assert attempts and attempts[0]["reached"]
    assert attempts[0]["steps"] and all(s["historical_arc_retraced"] for s in attempts[0]["steps"])
    moved = r.records[start:]
    assert sum(m["params"]["distanceCm"] for m in moved if m["method"] == "backward") >= 20
    assert all(m["motion_verification"]["motion_verified"] for m in moved)
    assert r.actions._pick_probe_limits[r.object_id] == bound
    assert not actual_grabs(r) and r.pending_grasp is None and r.held_object_id is None


def test_budget_return_is_third_gap_anchor_before_original_fresh_reset_and_grab():
    r = reduced_initial_probe()
    consume_budget(r)
    bound = copy.deepcopy(r.actions._pick_probe_limits[r.object_id])
    assert bound["requires_new_view"] is True
    r.actions.move("forward", {"distanceCm": 14.5, "speed": 30})
    point, gap = position(r.snapshot["odometry"]), r.actions._pick_probe_gap()
    assert all(distance(point, position(bound[k])) >= gap
               for k in ("anchor_odometry", "observed_return_odometry"))
    assert distance(point, position(bound["budget_return_odometry"])) < gap
    assert r.actions.pick_probe_view_status(r.object_id)["blocked"]
    assert not r.actions.current_pick_ready(r.object_id)
    r.actions.move("forward", {"distanceCm": 1, "speed": 30})
    assert r.actions.pick_probe_view_status(r.object_id)["independent_supported_view"]
    assert r.actions._pick_probe_limits[r.object_id] == bound
    assert not actual_grabs(r) and not r.perception._grab_authorizations
    result = r.pick()
    assert result["success"], result
    assert result["evidence"]["retry_probe_reset"]["limit_cm"] == 6
    assert len(actual_grabs(r)) == 1
    attempt = result["evidence"]["attempts"][0]
    assert attempt["grab_ref"]["authorization"]["observation_index"] == attempt["before_observation"]
    assert r.audit()["failures"] == []


@pytest.mark.parametrize("fault", ["unknown-pixels", "rival"])
def test_independent_budget_view_still_requires_full_unique_pixels(fault):
    r = reduced_initial_probe()
    consume_budget(r)
    bound = copy.deepcopy(r.actions._pick_probe_limits[r.object_id])
    assert bound["requires_new_view"] is True
    r.actions.move("backward", {"distanceCm": 20, "speed": 30})
    if fault == "unknown-pixels":
        r.clip_after = r.forward - 1
    else:
        r.override_items = copy.deepcopy(r.snapshot["observation"]["detections"])
        r.override_items.append(copy.deepcopy(r.override_items[0]))
    r.observe()
    status = r.actions.pick_probe_view_status(r.object_id)
    assert status["changed_view"] and status["blocked"]
    assert not status["independent_supported_view"]
    outcome = r.pick()
    assert not outcome["success"] and "retry_probe_reset" not in outcome["evidence"]
    assert r.actions._pick_probe_limits[r.object_id] == bound
    assert not actual_grabs(r) and not r.perception._grab_authorizations


@pytest.mark.parametrize("fault", ["unknown", "holding", "holding-unknown"])
def test_interrupted_or_changed_holding_approach_cannot_infer_budget_obligation(fault):
    r = reduced_initial_probe()
    bound = copy.deepcopy(r.actions._pick_probe_limits[r.object_id])
    original, forwards = r.bridge.call, []

    def interrupted(method, params):
        response = original(method, params)
        if method == "forward":
            forwards.append(copy.deepcopy(params))
            if len(forwards) == 3:
                if fault == "unknown":
                    r.bridge_records[-1].update(terminal=None,
                        submission={"status": 202, "body": {"status": "queued"}})
                    raise ConnectionError("synthetic_budget_forward_ack_unknown")
                r.holding = True if fault == "holding" else None
        return response

    r.bridge.call = interrupted
    if fault == "unknown":
        with pytest.raises(ConnectionError, match="synthetic_budget_forward_ack_unknown"):
            r.pick()
    else:
        result = r.pick()
        assert not result["success"] and result["reason"] != "pick_approach_view_budget_exhausted"
    assert len(forwards) == 3
    assert r.actions._pick_probe_limits[r.object_id] == bound
    assert not actual_grabs(r) and not r.perception._grab_authorizations


@pytest.mark.parametrize("missing", ["probe_kind", "anchor_odometry", "observed_return_odometry"])
def test_incomplete_prior_shrink_evidence_does_not_create_new_obligation(missing):
    r = reduced_initial_probe()
    # Synthetic negative: remove evidence, never add authorization or a limit.
    r.actions._pick_probe_limits[r.object_id].pop(missing)
    bound, result = consume_budget(r)
    assert r.actions._pick_probe_limits[r.object_id] == bound
    assert "retry_probe" not in result["evidence"]
    assert bound["requires_new_view"] is False
