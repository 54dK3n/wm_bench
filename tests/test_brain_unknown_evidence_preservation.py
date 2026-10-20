"""Unknown receipt diagnostics must not replace or interrupt the original error.

Public suffix geometry is replayed through synthetic actuator callbacks. No
controller action or platform result is implied by these tests.
"""
import copy

import pytest

from autonomous_brain import confirmation_sampling as sampling
from test_brain_sampling_basic_return import runtime_fixture, known_unsent_rejection


@pytest.mark.parametrize("previous", [None, [], {"existing_diagnostic":"keep"}])
@pytest.mark.parametrize("entry", ["move", "known_unsent_basic_return"])
def test_unknown_receipt_preserves_error_single_send_recovery_and_reconcile(previous, entry):
    runtime, actions, calls, motions, observations, _ = runtime_fixture()
    proof = sampling.observed_basic_return_support(actions)
    assert proof is not None
    error = ConnectionError("synthetic executed backward with unknown receipt")
    error.action_evidence = copy.deepcopy(previous)
    original_call = runtime.bridge.call
    reconciled = []
    original_reconcile = actions.reconcile_uncertain_holding
    old_segments = copy.deepcopy(runtime.roads._road_segments)

    def unknown_call(method, params):
        original_call(method, params)
        raise error

    def reconcile(before, method, evidence):
        reconciled.append((method, copy.deepcopy(evidence)))
        return original_reconcile(before, method, evidence)

    runtime.bridge.call = unknown_call
    actions.reconcile_uncertain_holding = reconcile
    with pytest.raises(ConnectionError) as caught:
        if entry == "move":
            actions.move("backward", proof["params"])
        else:
            actions.return_after_known_road_rejection(known_unsent_rejection())
    assert caught.value is error
    assert len(calls) == 1 and calls[0][0] == "backward"
    assert observations == [None], "Exactly one read-only observation; never resend"
    assert len(motions) == 1 and motions[0]["outcome_unknown"] is True
    assert len(reconciled) == 1 and reconciled[0][0] == "backward"
    assert reconciled[0][1]["outcome_unknown"] is True
    evidence = error.action_evidence
    assert evidence["outcome_unknown"] is True
    uncertain = evidence["uncertain_motion"]
    assert uncertain["method"] == "backward"
    assert uncertain["bridge_request_id"] == motions[0]["bridge_request_id"]
    assert uncertain["before_observation"] == motions[0]["before_observation"]
    assert uncertain["after_observation"] == motions[0]["after_observation"]
    if isinstance(previous, dict):
        assert evidence["existing_diagnostic"] == "keep"
    if entry == "known_unsent_basic_return":
        assert evidence["pre_motion_rejection"]["evidence"]["motion_not_sent"] is True
        assert evidence["recorded_basic_return"]["method"] == "backward"
        # The original forward rejection remains separate from this dispatched
        # backward unknown; it must not overwrite the actual uncertain method.
        assert uncertain["method"] != "forward"
    assert runtime.roads._road_segments == old_segments


@pytest.mark.parametrize("previous", [None, [], {"existing_diagnostic":"keep"}])
def test_basic_return_outer_catch_preserves_original_nonmapping_diagnostics(previous):
    runtime, actions, calls, motions, observations, _ = runtime_fixture()
    error = RuntimeError("synthetic return preparation error")
    error.action_evidence = copy.deepcopy(previous)

    def fail(rejected, proof):
        assert proof["method"] == "backward"
        raise error

    actions.return_along_observed_basic_suffix = fail
    with pytest.raises(RuntimeError) as caught:
        actions.return_after_known_road_rejection(known_unsent_rejection())
    assert caught.value is error
    assert calls == motions == observations == []
    assert error.action_evidence["pre_motion_rejection"]["evidence"]["motion_not_sent"] is True
    assert error.action_evidence["recorded_basic_return"]["method"] == "backward"
    if isinstance(previous, dict):
        assert error.action_evidence["existing_diagnostic"] == "keep"
