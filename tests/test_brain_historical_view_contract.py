"""Navigation-only LOST capability; historical transcripts keep their guards."""
import copy

import pytest

from autonomous_brain.llm import ActionValidationError, validate_action


V25 = "autonomous-brain-llm/v25"


def state():
    return {"objects": [{"id": "historical-red", "status": "LOST",
        "ever_confirmed": True, "historical_view_revisit": {
            "schema": "historical-view-revisit/v1", "available": True,
            "navigation_only": True, "requires_fresh_identity": True,
            "source_observation": 12, "frame_id": "12"}}],
        "robot": {"holding": False, "on_road": True,
                  "held_object_id": None, "pending_grasp_object_id": None}}


def action(name="go_to"):
    return {"action": name, "params": {"object_id": "historical-red"}}


def test_current_contract_only_allows_navigation_and_does_not_change_state():
    current = state()
    before = copy.deepcopy(current)
    assert validate_action(action(), current, transcript_version=V25) == action()
    assert current == before
    with pytest.raises(ActionValidationError, match="pick requires a CONFIRMED"):
        validate_action(action("pick"), current, transcript_version=V25)


@pytest.mark.parametrize("version", ["autonomous-brain-llm/v19",
    "autonomous-brain-llm/v22", "autonomous-brain-llm/v23", "autonomous-brain-llm/v24"])
def test_recorded_versions_never_gain_the_new_lost_exception(version):
    with pytest.raises(ActionValidationError, match="go_to requires a CONFIRMED"):
        validate_action(action(), state(), transcript_version=version)


@pytest.mark.parametrize("section,key,value", [
    ("object", "status", "STALE"), ("object", "status", "TENTATIVE"),
    ("object", "status", "HELD"), ("object", "status", "DELIVERED"),
    ("object", "ever_confirmed", False), ("object", "historical_view_revisit", None),
    ("capability", "available", False), ("capability", "available", 1),
    ("capability", "schema", "unverified/v1"),
    ("capability", "navigation_only", False),
    ("capability", "requires_fresh_identity", False),
    ("capability", "source_observation", 0),
    ("capability", "source_observation", True),
    ("capability", "frame_id", ""), ("capability", "frame_id", 12),
    ("robot", "holding", True), ("robot", "holding", None),
    ("robot", "on_road", False), ("robot", "held_object_id", "other"),
    ("robot", "pending_grasp_object_id", "historical-red"),
])
def test_missing_or_unsafe_capability_never_opens_lost_navigation(section, key, value):
    current = state()
    target = (current["robot"] if section == "robot" else
              current["objects"][0]["historical_view_revisit"] if section == "capability"
              else current["objects"][0])
    target[key] = value
    with pytest.raises(ActionValidationError, match="go_to requires a CONFIRMED"):
        validate_action(action(), current, transcript_version=V25)


def test_runtime21_keeps_the_strict_delivery_contract_and_future_is_unknown():
    from tools.brain_evidence_audit import RUNTIME_EVIDENCE_CAPABILITIES, runtime_evidence_capability
    assert (RUNTIME_EVIDENCE_CAPABILITIES["autonomous-brain-runtime/v21"]
            is RUNTIME_EVIDENCE_CAPABILITIES["autonomous-brain-runtime/v20"])
    assert runtime_evidence_capability({"runtime_version": "autonomous-brain-runtime/v23"}) == (
        None, "runtime_evidence_version_unsupported")


@pytest.mark.parametrize("field,failure", [(None, None),
    ("grasp_chain", "pick_command_identity_confirmation_chain_missing"),
    ("command_ref", "delivery_release_command_reference_invalid")])
def test_runtime21_audits_original_action_chain_without_fallback(field, failure):
    from test_brain_pending_grasp_audit import chain
    from test_brain_evidence_capabilities import remove_contract
    from tools.brain_evidence_audit import audit_observed_ledger
    runtime = chain(False)
    data = ({"runtime_version": "autonomous-brain-runtime/v21",
             "action_evidence": runtime.perception.action_evidence(),
             "final_objects": runtime.perception.objects()},
            runtime.observations, runtime.rounds, runtime.bridge_records, runtime.records)
    if field:
        remove_contract(data, field)
    audited = audit_observed_ledger(*data)
    if failure:
        assert failure in audited["failures"]
        assert not any(item["verified"] for item in audited["deliveries"])
    else:
        assert audited["failures"] == []
        assert len(audited["picks"]) == len(audited["deliveries"]) == 1
        assert audited["picks"][0]["verified"] is True
        assert audited["deliveries"][0]["verified"] is True
