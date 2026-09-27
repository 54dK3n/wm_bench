"""Runtime-declared contracts at the complete public-evidence audit entry point.

The control trace is produced by real Perception/WM and Actions with synthetic
public sensors and actuators. These are function audits, not evaluate_run runs.
"""
import copy

import pytest

from test_brain_pending_grasp_audit import chain
from tools.brain_evidence_audit import audit_observed_ledger, audit_unknown_discoveries


MODERN = ("v15", "v16", "v17", "v18")
LEGACY = tuple(f"v{i}" for i in range(1, 15))
MISSING = object()


@pytest.fixture(scope="module")
def real_action_trace():
    runtime = chain(False)
    return ({"action_evidence": runtime.perception.action_evidence(),
             "final_objects": runtime.perception.objects()},
            runtime.observations, runtime.rounds, runtime.bridge_records, runtime.records)


def trace_with_version(trace, version):
    data = copy.deepcopy(trace)
    if version is not MISSING:
        data[0]["runtime_version"] = "autonomous-brain-runtime/" + version
    return data


def remove_contract(data, field):
    """Keep event/round claims mutually consistent: only the contract is lost."""
    summary, _, rounds, _, _ = data
    if field in {"grasp_chain", "both"}:
        summary["action_evidence"][0]["evidence"].pop("grasp_chain")
        rounds[0]["result"]["evidence"].pop("grasp_confirmation", None)
    if field in {"command_ref", "both"}:
        for event in summary["action_evidence"]:
            if "release_observation" in event.get("evidence", {}):
                event["evidence"]["release_observation"].pop("command_ref", None)
        rounds[1]["result"]["evidence"]["release_observation"].pop("command_ref")


@pytest.mark.parametrize("version", MODERN)
def test_supported_modern_runtime_accepts_complete_real_actions_chain(real_action_trace, version):
    result = audit_observed_ledger(*trace_with_version(real_action_trace, version))
    assert result["failures"] == []
    assert len(result["picks"]) == len(result["deliveries"]) == 1
    assert result["picks"][0]["verified"] is True
    assert result["deliveries"][0]["verified"] is True


@pytest.mark.parametrize("version", MODERN)
@pytest.mark.parametrize("field,failure", [
    ("grasp_chain", "pick_command_identity_confirmation_chain_missing"),
    ("command_ref", "delivery_release_command_reference_invalid"),
    ("both", "pick_command_identity_confirmation_chain_missing"),
])
def test_modern_runtime_cannot_fall_back_when_command_contract_is_deleted(real_action_trace, version, field, failure):
    data = trace_with_version(real_action_trace, version)
    remove_contract(data, field)
    result = audit_observed_ledger(*data)
    assert failure in result["failures"]
    assert not any(row["verified"] for row in result["deliveries"])


@pytest.mark.parametrize("version", MODERN + ("v19", MISSING))
@pytest.mark.parametrize("fault", ["grab-reference", "release-reference", "duplicate-grab-event", "duplicate-request-id", "grab-motion-deleted"])
def test_modern_runtime_rejects_conflicting_or_reused_commands(real_action_trace, version, fault):
    data = trace_with_version(real_action_trace, version)
    summary, _, rounds, bridge, _ = data
    place = next(event for event in summary["action_evidence"] if event["action"] == "place")
    if fault == "grab-reference":
        proof = summary["action_evidence"][0]["evidence"]["grasp_chain"]
        proof["grab"]["bridge_request_id"] = place["evidence"]["release_observation"]["command_ref"]["bridge_request_id"]
        rounds[0]["result"]["evidence"]["grasp_confirmation"] = copy.deepcopy(proof)
    elif fault == "release-reference":
        reference = place["evidence"]["release_observation"]["command_ref"]
        reference["bridge_request_id"] = reference["grasp_request_id"]
        rounds[1]["result"]["evidence"]["release_observation"]["command_ref"] = copy.deepcopy(reference)
    elif fault == "duplicate-grab-event":
        summary["action_evidence"].insert(1, copy.deepcopy(summary["action_evidence"][0]))
    elif fault == "duplicate-request-id":
        bridge.append(copy.deepcopy(next(call for call in bridge if call["request"]["method"] == "grab")))
    else:
        data[-1][:] = [motion for motion in data[-1] if motion["method"] != "grab"]
    result = audit_observed_ledger(*data)
    assert result["failures"]
    if version not in MODERN:
        assert not any(row["verified"] for row in result["picks"] + result["deliveries"])
    elif fault == "duplicate-grab-event":
        assert [row["verified"] for row in result["picks"]] == [True, False]
    elif fault == "release-reference":
        assert result["deliveries"][0]["verified"] is False
    else:
        assert result["picks"][0]["verified"] is False


@pytest.mark.parametrize("version", [MISSING, "v19", "v100", "v015", "v17-extra", "V17", ""])
@pytest.mark.parametrize("field", [None, "grasp_chain", "command_ref"])
def test_missing_or_unknown_runtime_never_infers_a_legacy_contract(real_action_trace, version, field):
    data = trace_with_version(real_action_trace, version)
    if field:
        remove_contract(data, field)
    result = audit_observed_ledger(*data)
    expected = "runtime_evidence_version_missing" if version is MISSING else "runtime_evidence_version_unsupported"
    assert expected in result["failures"]
    assert not any(row["verified"] for row in result["picks"] + result["deliveries"])


@pytest.mark.parametrize("version", LEGACY)
def test_explicit_legacy_version_preserves_only_existing_same_action_path(real_action_trace, version):
    data = trace_with_version(real_action_trace, version)
    remove_contract(data, "grasp_chain")
    remove_contract(data, "command_ref")
    result = audit_observed_ledger(*data)
    assert result["failures"] == []
    assert result["picks"][0]["legacy_same_action"] is True
    assert result["picks"][0]["verified"] is True
    data[-1][:] = [motion for motion in data[-1] if motion["method"] != "grab"]
    assert "pick_ledger_missing_holding_observation" in audit_observed_ledger(*data)["failures"]


@pytest.mark.parametrize("version", MODERN + ("v14",))
def test_authorized_claim_cannot_override_stale_original_grab_identity(real_action_trace, version):
    data = trace_with_version(real_action_trace, version)
    summary, observations, rounds, _, _ = data
    proof = summary["action_evidence"][0]["evidence"]["grasp_chain"]
    proof["grab"]["authorized"] = True
    rounds[0]["result"]["evidence"]["grasp_confirmation"] = copy.deepcopy(proof)
    before = observations[proof["grab"]["before_observation"] - 1]
    next(obj for obj in before["objects"] if obj["id"] == proof["object_id"])["state"] = "STALE"
    result = audit_observed_ledger(*data)
    assert "pick_command_identity_confirmation_chain_invalid" in result["failures"]
    assert result["picks"][0]["verified"] is False


@pytest.mark.parametrize("version", MODERN)
def test_modern_discovery_cannot_fall_back_to_v1_ledger(version):
    summary = {"runtime_version": "autonomous-brain-runtime/" + version,
               "discovery_evidence": {"schema": "brain-discovery-evidence/v1", "unresolved": []}}
    assert "discovery_v2_ledger_missing" in audit_unknown_discoveries(summary, [])["failures"]


@pytest.mark.parametrize("version", LEGACY)
def test_explicit_legacy_discovery_preserves_v1_ledger(version):
    summary = {"runtime_version": "autonomous-brain-runtime/" + version,
               "discovery_evidence": {"schema": "brain-discovery-evidence/v1", "unresolved": []}}
    assert audit_unknown_discoveries(summary, [])["failures"] == []


@pytest.mark.parametrize("schema", ["brain-discovery-evidence/v1", "brain-discovery-evidence/v2"])
@pytest.mark.parametrize("version", [MISSING, "v19"])
def test_unknown_discovery_runtime_does_not_infer_capabilities(schema, version):
    summary = {"discovery_evidence": {"schema": schema, "unresolved": [], "records": [], "resolutions": []}}
    if version is not MISSING:
        summary["runtime_version"] = "autonomous-brain-runtime/" + version
    result = audit_unknown_discoveries(summary, [])
    expected = "runtime_evidence_version_missing" if version is MISSING else "runtime_evidence_version_unsupported"
    assert expected in result["failures"]


@pytest.mark.parametrize("version", [None, 17, True, [], {"version": "v17"}])
def test_malformed_runtime_declaration_is_rejected_without_type_coercion(real_action_trace, version):
    data = copy.deepcopy(real_action_trace)
    data[0]["runtime_version"] = version
    result = audit_observed_ledger(*data)
    expected = "runtime_evidence_version_missing" if version is None else "runtime_evidence_version_unsupported"
    assert result["failures"] == [expected]
    assert result["picks"] == result["deliveries"] == []


@pytest.mark.parametrize("version", ["v1", "v14"])
def test_legacy_contract_does_not_allow_cross_action_confirmation_without_chain(version):
    runtime = chain(True)
    data = trace_with_version(({"action_evidence": runtime.perception.action_evidence(),
        "final_objects": runtime.perception.objects()}, runtime.observations,
        runtime.rounds, runtime.bridge_records, runtime.records), version)
    remove_contract(data, "both")
    result = audit_observed_ledger(*data)
    assert "pick_ledger_missing_holding_observation" in result["failures"]
    assert not any(row["verified"] for row in result["picks"] + result["deliveries"])


@pytest.mark.parametrize("version", MODERN)
def test_modern_delayed_confirmation_keeps_original_actual_grab_reference(version):
    runtime = chain(True)
    data = trace_with_version(({"action_evidence": runtime.perception.action_evidence(),
        "final_objects": runtime.perception.objects()}, runtime.observations,
        runtime.rounds, runtime.bridge_records, runtime.records), version)
    result = audit_observed_ledger(*data)
    assert result["failures"] == []
    pick = result["picks"][0]
    assert pick["verified"] and pick["grab"]["round"] < pick["confirmation"]["round"]
    assert result["deliveries"][0]["release_command_ref"]["grasp_request_id"] == pick["grab"]["bridge_request_id"]


@pytest.mark.parametrize("version", MODERN)
def test_modern_runtime_accepts_independently_verified_v2_discovery(version):
    from test_brain_discovery_lifecycle_audit import observed_trace
    data = observed_trace()
    data[0]["runtime_version"] = "autonomous-brain-runtime/" + version
    assert audit_unknown_discoveries(*data)["failures"] == []


@pytest.mark.parametrize("fault", ["missing-authorization", "boolean-only", "old-frame", "false-geometry",
    "raw-deletion", "duplicate-detection", "competing-object", "wrong-command"])
def test_v18_grab_authorization_is_recomputed_from_original_public_evidence(real_action_trace, fault):
    data = trace_with_version(real_action_trace, "v18")
    summary, observations, rounds, bridge, _ = data
    chain = summary["action_evidence"][0]["evidence"]["grasp_chain"]
    proof = chain["grab"]["authorization"]
    source = observations[chain["grab"]["before_observation"] - 1]
    if fault == "missing-authorization":
        del chain["grab"]["authorization"]
    elif fault == "boolean-only":
        chain["grab"]["authorization"] = {"authorized": True}
    elif fault == "old-frame":
        proof["frame_id"] = str(int(proof["frame_id"]) - 1)
    elif fault == "false-geometry":
        proof["remembered_distance_cm"] = 1
    elif fault == "wrong-command":
        proof["command_ref"]["bridge_request_id"] = "brain-000001"
    elif fault == "competing-object":
        rival = copy.deepcopy(proof["object"])
        rival.update(id="other-current-candidate", state="TENTATIVE", hit_count=1)
        source["objects"].append(rival)
    else:
        selected = proof["detection_index"]
        if fault == "raw-deletion":
            source["observation"]["detections"].pop(selected)
            source["perception"]["detections"].pop(selected)
            proof["detections"].pop(selected)
        else:
            source["observation"]["detections"].append(copy.deepcopy(source["observation"]["detections"][selected]))
            duplicate = copy.deepcopy(source["perception"]["detections"][selected])
            duplicate["track_id"] = None
            source["perception"]["detections"].append(duplicate)
            proof["detections"].append(copy.deepcopy(duplicate))
            # A self-consistent claimed matrix hides the second candidate; the
            # audit must reconstruct it from pixels, rather than trust it.
            proof["candidate_ids_by_detection"].append([])
        source["perception"]["raw_observation"] = copy.deepcopy(source["observation"])
        for call in bridge:
            if call["request"]["method"] == "observe" and call["terminal"]["result"]["frameId"] == source["observation"]["frameId"]:
                call["terminal"]["result"] = copy.deepcopy(source["observation"])
    rounds[0]["result"]["evidence"]["grasp_confirmation"] = copy.deepcopy(chain)
    result = audit_observed_ledger(*data)
    assert "pick_command_identity_confirmation_chain_invalid" in result["failures"]
    assert result["picks"][0]["verified"] is False


def test_v17_historical_chain_keeps_its_original_contract_without_authorization(real_action_trace):
    data = trace_with_version(real_action_trace, "v17")
    chain = data[0]["action_evidence"][0]["evidence"]["grasp_chain"]
    chain["grab"].pop("authorization")
    data[2][0]["result"]["evidence"]["grasp_confirmation"] = copy.deepcopy(chain)
    assert audit_observed_ledger(*data)["failures"] == []


def test_v18_legal_target_with_unrelated_raw_box_excluded_from_world_model():
    from test_brain_grab_authorization import AuthorizationRuntime
    from test_brain_perception import ball
    runtime = AuthorizationRuntime()
    update = runtime.perception.update
    def with_unfed_blue(observation, odometry, **kwargs):
        if not runtime.holding and not runtime.released:
            blue = ball(100, bearing=30)
            blue.update(category="blue-ball", confidence=.01)
            observation["detections"].append(blue)
        return update(observation, odometry, **kwargs)
    runtime.perception.update = with_unfed_blue
    assert runtime.pick()["success"]
    assert runtime.execute({"action": "place", "params": {}})["success"]
    data = trace_with_version(({"action_evidence": runtime.perception.action_evidence(),
        "final_objects": runtime.perception.objects()}, runtime.observations,
        runtime.rounds, runtime.bridge_records, runtime.records), "v18")
    proof = data[0]["action_evidence"][0]["evidence"]["grasp_chain"]["grab"]
    source = data[1][proof["before_observation"] - 1]
    blue = [d for d in source["perception"]["detections"] if d["category"] == "blue-ball"]
    assert len(blue) == 1 and blue[0]["fed_to_world_model"] is False
    assert blue[0]["track_id"] is None
    assert not any(obj["category"] == "blue-ball" for obj in source["objects"])
    assert audit_observed_ledger(*data)["failures"] == []
