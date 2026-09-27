"""Observed road return is independent of a usable confirmation viewpoint.

Synthetic sensor/actuator linkage uses real Perception, WM, RoadMemory, Actions
and the frozen normalizeCommand. It is not a platform run or task acceptance.
"""
import copy
import math

import pytest

from autonomous_brain.navigation import RoadMemory
from test_brain_grab_authorization import AuthorizationRuntime, actual_grabs
from test_brain_route_contract import normalize


class RoadAuthorizationRuntime(AuthorizationRuntime):
    def __init__(self, *, near_field=True, recovery_fault=None, leave_road=True):
        self.road_boundary = math.inf
        self.road_ledger_ready = False
        self.recovery_fault = recovery_fault
        self.inverse_attempts = 0
        super().__init__()
        if near_field:
            target = self.perception.confirmed(self.object_id)
            distance = target['position_m']['z'] * 100 - self.forward - 28
            self.actions.move('forward', {'distanceCm': distance, 'speed': 30})
        self.entry = copy.deepcopy(self.snapshot['odometry'])
        self.road_boundary = self.forward + .1 if leave_road else math.inf
        self.roads = RoadMemory()
        self.road_ledger_ready = True
        self.roads.update(self.snapshot['odometry'], self.snapshot['road'], self.frame)
        self.roads.observe_traversal(self.snapshot)
        self.fault = 'competition' if near_field else 'approach_stale'
        self.triggered = False
        self.commands_before_pick = len(self.bridge_records)

    def call(self, method, params):
        normalize(method, params)
        if method == 'backward':
            self.inverse_attempts += 1
            if self.recovery_fault == 'unknown':
                super().call(method, params)
                self.bridge_records[-1].update(terminal=None,
                    submission={'status': 202, 'body': {'status': 'queued'}})
                raise ConnectionError('synthetic_return_ack_unknown')
            if self.recovery_fault == 'partial':
                original = (self.right, self.forward, self.travelled)
                result = super().call(method, params)
                self.right = original[0] + (self.right - original[0]) / 2
                self.forward = original[1] + (self.forward - original[1]) / 2
                self.travelled = original[2] + (self.travelled - original[2]) / 2
                return result
        return super().call(method, params)

    def observe(self, *, motion=None):
        super().observe(motion=motion)
        # A public sensor region, not a precise-endpoint script: any position
        # beyond the road boundary is off-road, including partial returns.
        self.snapshot['road']['onRoad'] = self.forward <= self.road_boundary
        self.bridge_records[-3]['terminal']['result'] = copy.deepcopy(self.snapshot['road'])
        if self.road_ledger_ready:
            self.roads.update(self.snapshot['odometry'], self.snapshot['road'], self.frame)
            self.roads.observe_traversal(self.snapshot,
                dict(motion, after_observation=self.frame) if motion else None)
        self.observations[-1] = copy.deepcopy(self.snapshot)
        return self.snapshot


def test_near_field_identity_refusal_returns_measured_path_without_confirmed_view():
    r = RoadAuthorizationRuntime()
    assert r.perception.confirmed(r.object_id)
    detected = r.perception.visible(r.object_id)
    assert detected and detected['raw_distance_cm'] < 40
    assert not detected['fed_to_world_model']
    result = r.pick()
    evidence = result['evidence']
    assert not result['success'] and result['reason'] == 'grab_identity_competition'
    assert actual_grabs(r) == [] and r.held_object_id is None and r.pending_grasp is None
    assert evidence['authorization_recovery']['reason'] == 'no_recorded_confirmed_view'
    assert any(row['before_on_road'] and not row['after_on_road'] for row in evidence['pick_trajectory'])
    assert evidence['road_return']['success'], evidence['road_return']
    assert evidence['road_return']['physical_on_road']
    assert evidence['road_return']['map_reconnected']
    assert r.inverse_attempts >= 1
    assert abs(r.forward - r.entry['forwardCm']) <= .2
    assert abs(r.right - r.entry['rightCm']) <= .2
    assert r.heading == r.entry['headingDeg']
    assert not r.perception.action_evidence()


def test_no_confirmed_view_does_not_misreport_already_connected_road_as_failed_return():
    r = RoadAuthorizationRuntime(leave_road=False)
    result = r.pick()
    assert not result['success'] and actual_grabs(r) == []
    assert result['evidence']['authorization_recovery']['reason'] == 'no_recorded_confirmed_view'
    assert result['evidence']['road_return']['success']
    assert result['evidence']['road_return']['reason'] == 'already_on_observed_road'
    assert r.inverse_attempts == 0


def test_unrecorded_pose_change_breaks_road_chain_and_never_authorizes_inverse():
    r = RoadAuthorizationRuntime()
    trajectory = []
    r.actions.manipulation_move('forward', {'distanceCm': 6, 'speed': 30}, trajectory, 'fixture')
    r.right += 1  # Next public odometry exposes displacement without a command.
    r.observe()
    result = r.actions.return_place_path(trajectory)
    assert not result['success'] and result['reason'] == 'road_reconnection_motion_evidence_unresolved'
    assert r.inverse_attempts == 0 and not result['map_reconnected']
    assert actual_grabs(r) == []


@pytest.mark.parametrize('fault', ['partial', 'unknown'])
def test_failed_confirmed_view_inverse_is_not_restarted_as_whole_road_return(fault):
    # Starts in-window, so Actions genuinely records valid_view before losing
    # authorization. A failed inverse must not be hidden by another fallback.
    r = RoadAuthorizationRuntime(near_field=False, recovery_fault=fault)
    assert r.perception.visible(r.object_id)['fed_to_world_model']
    if fault == 'unknown':
        with pytest.raises(ConnectionError) as caught:
            r.pick()
        evidence = caught.value.action_evidence
        assert any(row.get('outcome_unknown') for row in evidence['pick_trajectory'])
    else:
        result = r.pick()
        evidence = result['evidence']
        assert not result['success']
        assert not evidence['authorization_recovery']['success']
        assert any(not row.get('motion_verification', {}).get('motion_verified')
                   for row in evidence['pick_trajectory'])
    assert r.inverse_attempts == 1
    assert not r.roads.reconnection_state()['map_reconnected']
    assert actual_grabs(r) == [] and not r.perception.action_evidence()
