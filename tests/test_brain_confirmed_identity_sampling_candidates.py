"""Confirmed identity recovery uses real public pixels/WM and the existing planner.

These are synthetic component checks, not a platform task or grab authorization.
"""
import pytest

from test_brain_confirmation_sampling import sampling_runtime
from test_brain_perception import ball


def confirmed_competitor_scene(depth_cm=96):
    r = sampling_runtime(target=(8, depth_cm))
    old = r.perception.objects()[0]["id"]
    pixels = r.bridge.pixels
    r.bridge.pixels = lambda: []
    r.bridge.seconds = 200
    r.observe()
    assert r.perception.get_object(old)["state"] == "LOST"
    r.bridge.pixels = pixels
    r.bridge.target = (0, depth_cm)
    r.observe()
    for _ in range(2):
        r.actions.move("forward", {"distanceCm": 15.2, "speed": 30})
    obj = next(o for o in r.perception.objects() if o["state"] == "CONFIRMED")
    discovery = r.snapshot["perception"]["detections"][0]["discovery_id"]
    target = r.perception.discovery_target(discovery)
    assert obj["hit_count"] == 3
    assert target["has_pending_discovery"] is False
    assert target["identity_resolution_required"] is True
    assert target["identity_competitor_ids"] == [old]
    assert target["sampling_allowed"] is True
    return r, obj["id"], target


def test_confirmed_identity_obligation_survives_summary_and_has_safe_specific_option():
    r, oid, target = confirmed_competitor_scene()
    calls = list(r.bridge.calls)
    rows = r.perception.discovery_summary()["executable_candidates"]
    assert any(row["associated_object_id"] == oid for row in rows)
    options = r.actions.identity_recovery_choices(oid)["choices"]
    chosen = next(row for row in options if row["action"] == "explore")
    assert chosen["params"]["discovery_id"] == target["hypothesis_id"]
    assert chosen["executable"] is True
    assert chosen["next_view"]["method"] == "follow_road"
    assert chosen["requires_fresh_recheck"] is True
    assert r.bridge.calls == calls, "A query must not move the robot"
    assert r.perception.check_grasp_identity(oid, r.snapshot)["reason"] == "grab_identity_competition"
    full = r.perception.authorize_grab(oid, r.snapshot, {
        "before_observation": r.snapshot["observation_index"],
        "bridge_sequence": 77, "bridge_request_id": "brain-000077"})
    assert full["authorized"] is False and full["reason"] == "grab_identity_competition"
    assert r.perception._grab_authorizations == {}


def test_ordinary_confirmed_target_without_identity_obligation_remains_omitted():
    r = sampling_runtime(target=(0, 96))
    for _ in range(2):
        r.actions.move("forward", {"distanceCm": 15.2, "speed": 30})
    oid = r.perception.objects()[0]["id"]
    discovery = r.snapshot["perception"]["detections"][0]["discovery_id"]
    target = r.perception.discovery_target(discovery)
    assert target["associated_object"]["state"] == "CONFIRMED"
    assert target["has_pending_discovery"] is False
    assert target["identity_resolution_required"] is False
    assert not any(row["associated_object_id"] == oid
                   for row in r.perception.discovery_summary()["pending"])


@pytest.mark.parametrize("unavailable", ["off_road", "no_clearance", "no_independent_window_view"])
def test_visible_identity_candidate_does_not_invent_an_executable_motion(unavailable):
    r, oid, _ = confirmed_competitor_scene(90 if unavailable == "no_independent_window_view" else 96)
    sensor_call = r.bridge.call

    def call(method, params=None):
        result = sensor_call(method, params)
        if method == "local_road":
            if unavailable == "off_road":
                result["onRoad"] = False
            elif unavailable == "no_clearance":
                result.update(frontClearanceCm=.1, leftClearanceCm=.1, rightClearanceCm=.1)
        return result

    r.bridge.call = call
    r.observe()
    before_calls = list(r.bridge.calls)
    choices = r.actions.identity_recovery_choices(oid)["choices"]
    assert not any(row["executable"] for row in choices)
    if unavailable != "off_road":
        choice = next(row for row in choices if row["action"] == "explore")
        assert choice["next_view"] is None
        assert choice["rejections"]
        if unavailable == "no_independent_window_view":
            assert choice["rejections"]["target_would_leave_confirmation_window"] > 0
            assert choice["rejections"]["insufficient_separation_from_accepted_hit_poses"] > 0
    assert r.bridge.calls == before_calls
    assert r.perception.check_grasp_identity(oid, r.snapshot)["authorized"] is False


def test_requested_identity_candidate_is_filtered_before_display_limit():
    r, oid, target = confirmed_competitor_scene()
    pixels = r.bridge.pixels
    r.bridge.pixels = lambda: pixels() + [ball(95, bearing=-25)]
    r.observe()
    other = next(d["discovery_id"] for d in r.snapshot["perception"]["detections"]
                 if d["track_id"] != oid)
    ordinary = r.perception.discovery_summary(limit=1, current_discovery_id=other)
    assert ordinary["executable_candidates"][0]["associated_object_id"] != oid
    selected = r.perception.discovery_summary(limit=1, current_discovery_id=other, object_id=oid)
    assert len(selected["executable_candidates"]) == 1
    assert selected["executable_candidates"][0]["associated_object_id"] == oid
    assert selected["executable_candidates"][0]["hypothesis_id"] == target["hypothesis_id"]
