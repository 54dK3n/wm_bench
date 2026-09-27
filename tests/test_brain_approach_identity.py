"""Read-only pre-approach identity uses the unchanged physical-grab gates."""
import copy

from test_brain_recovery_discovery import runtime, publish, see_world, world_ball


def confirmed_scene(*, old_x=None, old_count=1):
    r = runtime()
    old_ids = []
    if old_x is not None:
        publish(r, items=[world_ball(old_x, 80) for _ in range(old_count)])
        old_ids = [row["id"] for row in r.perception.objects()]
        r.bridge.seconds = 20
        publish(r)
        assert all(r.perception.get_object(oid)["state"] == "LOST" for oid in old_ids)
    for forward in (0, 16, 32):
        see_world(r, 0, 80, forward=forward)
    oid = next(row["id"] for row in r.perception.objects() if row["state"] == "CONFIRMED")
    return r, oid, old_ids


def test_identity_check_does_not_apply_final_geometry_or_register_grab():
    r, oid, _ = confirmed_scene()
    before = copy.deepcopy(r.perception.objects())
    identity = r.perception.check_grasp_identity(oid, r.snapshot)
    assert identity["authorized"] is True
    assert r.perception._grab_authorizations == {}
    assert r.perception.objects() == before
    command = {"before_observation": r.snapshot["observation_index"],
               "bridge_sequence": 7, "bridge_request_id": "brain-000007"}
    full = r.perception.authorize_grab(oid, r.snapshot, command)
    assert full["reason"] == "grab_geometry_not_authorized"
    assert r.perception._grab_authorizations == {}


def test_lost_competitor_is_retained_before_movement_and_full_context_is_not_truncated():
    r, oid, old = confirmed_scene(old_x=8, old_count=14)
    check = r.perception.check_grasp_identity(oid, r.snapshot)
    assert check["reason"] == "grab_identity_competition"
    assert set(check["candidate_ids_by_detection"][0]) == set(old + [oid])
    context = r.perception.grasp_identity_context(oid)
    assert context["candidate_ids_by_detection"] == check["candidate_ids_by_detection"]
    assert set(context["related_object_ids"]) == set(old + [oid])
    assert not context["verified_resolutions"]
    assert all(row["object_id"] == row["canonical_object_id"] for row in context["canonical_mappings"])
    assert r.perception._grab_authorizations == {}


def test_confirmed_competing_target_offers_specific_identity_sampling_without_claiming_confirmation():
    r, oid, old = confirmed_scene(old_x=8)
    discovery = r.snapshot["perception"]["detections"][0]["discovery_id"]
    target = r.perception.discovery_target(discovery)
    assert target["associated_object"]["id"] == oid
    assert target["identity_resolution_required"] is True
    assert target["identity_competitor_ids"] == old
    assert target["sampling_allowed"] is True
    assert target["current_confirmation_corroborated"] is False
    assert target["current_confirmation_evidence"]["unique_current_pixels"] is True
    assert r.perception.check_grasp_identity(oid, r.snapshot)["authorized"] is False
    # A later uniquely observed view need not already resolve the first source
    # pixels: obtaining that evidence is precisely this sampling intention.
    see_world(r, 12, 80, forward=32)
    current = r.snapshot["perception"]["detections"][0]
    target = r.perception.discovery_target(current["discovery_id"])
    assert target["current_confirmation_evidence"]["source_pixels_supported"] is False
    assert target["current_confirmation_evidence"]["unique_current_pixels"] is True
    assert target["identity_resolution_required"] and target["sampling_allowed"]
    assert not target["current_confirmation_corroborated"]
    assert not r.perception.check_grasp_identity(oid, r.snapshot)["authorized"]


def test_new_frame_without_independent_hit_does_not_change_stable_identity_context():
    r, oid, _ = confirmed_scene(old_x=8)
    before = r.perception.grasp_identity_context(oid)
    see_world(r, 0, 80, forward=32)
    after = r.perception.grasp_identity_context(oid)
    for key in ("candidate_ids_by_detection", "target_candidate_relations", "canonical_mappings",
                "verified_resolutions", "accepted_independent_hit_poses"):
        assert after[key] == before[key], key
    assert r.perception.check_grasp_identity(oid, r.snapshot)["authorized"] is False


def test_existing_resolver_provides_verified_mapping_without_deleting_lost_history():
    r, oid, old = confirmed_scene(old_x=0)
    context = r.perception.grasp_identity_context(oid)
    assert {row["object_id"]: row["canonical_object_id"] for row in context["canonical_mappings"]}[old[0]] == oid
    proofs = [row for row in context["verified_resolutions"] if row["previous_object_id"] == old[0]]
    assert proofs and all(len(row["support_refs"]) >= 2 for row in proofs)
    assert all(row["rule"] == "independent_views_original_pixels_unique_identity/v1" for row in proofs)
    assert r.perception.get_object(old[0])["state"] == "LOST"
    assert r.perception.check_grasp_identity(oid, r.snapshot)["authorized"] is True


def test_identity_check_still_requires_current_snapshot_empty_gripper_and_unique_pixels():
    r, oid, _ = confirmed_scene()
    stale = copy.deepcopy(r.snapshot)
    stale["simulation_seconds"] -= .1
    assert r.perception.check_grasp_identity(oid, stale)["reason"] == "grab_observation_not_current"
    occupied = copy.deepcopy(r.snapshot)
    occupied["holding"]["holding"] = True
    assert r.perception.check_grasp_identity(oid, occupied)["reason"] == "gripper_not_observed_empty"
    publish(r, forward=32, items=[world_ball(0, 80, forward=32)] * 2)
    assert r.perception.check_grasp_identity(oid, r.snapshot)["authorized"] is False
