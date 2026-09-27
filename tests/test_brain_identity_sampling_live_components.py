"""Identity sampling through public pixels, real WM and normalized movement.

This is a synthetic component diagnostic, not a platform task result. Scene
geometry renders sensor boxes only; no identities or coordinates enter Actions.
"""
from test_brain_confirmation_sampling import sampling_runtime, sample


def test_confirmed_competitor_is_sampled_but_new_hit_alone_does_not_resolve_identity():
    r = sampling_runtime(target=(8, 96))
    old = r.perception.objects()[0]["id"]
    # The first visible candidate disappears long enough for the actual WM to
    # retain it as LOST. A nearby candidate is then observed independently.
    render_pixels = r.bridge.pixels
    r.bridge.pixels = lambda: []
    r.bridge.seconds = 200
    r.observe()
    assert r.perception.get_object(old)["state"] == "LOST"
    r.bridge.pixels = render_pixels
    r.bridge.target = (0, 96)
    r.observe()
    for _ in range(2):
        r.actions.move("forward", {"distanceCm": 15.2, "speed": 30})

    current = next(o for o in r.perception.objects() if o["state"] == "CONFIRMED")
    oid = current["id"]
    assert oid != old and current["hit_count"] == 3
    selected = r.snapshot["perception"]["detections"][0]["discovery_id"]
    target = r.perception.discovery_target(selected)
    assert target["identity_resolution_required"] is True
    assert target["identity_competitor_ids"] == [old]
    assert target["sampling_allowed"] is True
    assert target["current_confirmation_corroborated"] is False
    before_calls, before_observation = len(r.bridge.calls), r.observation_count

    outcome = sample(r, selected)

    # SensorBridge sends every motor command through the frozen platform's
    # normalizeCommand; Runtime.observe updates the real RoadMemory and WM.
    commands = r.bridge.calls[before_calls:]
    assert commands == [("follow_road", {"distanceCm": 15.5, "speed": 50})]
    proof = outcome["evidence"]["confirmation_sampling"]
    assert proof["identity_resolution_required"] is True
    assert proof["initial_hit_count"] == 3 and proof["final_hit_count"] == 4
    assert proof["independent_hits_added"] == 1
    assert proof["travelled_cm"] == 15.5
    assert len(proof["steps"]) == 1
    step = proof["steps"][0]
    assert step["after_observation"] > step["before_observation"] >= before_observation
    assert step["measured_displacement_cm"] >= 15
    assert r.observation_count > step["after_observation"]
    assert r.motions[-1]["method"] == "follow_road"
    assert r.roads.road_segment_records()

    # Extra hits cannot replace the resolver's original-pixel identity proof.
    assert outcome["success"] is False
    assert outcome["reason"] == "confirmation_no_safe_independent_viewpoint"
    assert proof["confirmed_object_id"] is None
    assert not proof.get("identity_resolution_reason")
    assert r.perception.get_object(old)["state"] == "LOST"
    context = r.perception.grasp_identity_context(oid)
    assert context["verified_resolutions"] == []
    assert {row["object_id"]: row["canonical_object_id"]
            for row in context["canonical_mappings"]}[old] == old
    assert r.perception.check_grasp_identity(oid, r.snapshot)["reason"] == "grab_identity_competition"
    assert not any(method in {"grab", "release"} for method, _ in r.bridge.calls)
