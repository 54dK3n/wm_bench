"""Closed sensor feedback through real Perception/WM/Runtime/Actions.

Synthetic scene geometry is used only to render public boxes in this fixture;
no object identity or scene position is passed to the robot implementation.
Every motor command passes the actual frozen platform normalizer.
"""
import copy
import math
from types import SimpleNamespace

import pytest

from autonomous_brain import run
from autonomous_brain.actions import Actions
from autonomous_brain.navigation import RoadMemory, wrap
from autonomous_brain.perception import Perception, RANGE_CAL
from autonomous_brain.task import parse_task
from test_brain_perception import CAMERA, ball
from test_brain_route_contract import normalize


class SensorBridge:
    def __init__(self, *, target=(0, 88), at_node=False, mode=None):
        self.target = target
        self.x = self.z = self.heading = self.travel = self.seconds = 0.
        self.tick = self.frame = 0
        self.max_seconds = 1200
        self.at_node, self.mode = at_node, mode
        self.calls = []

    def pixels(self):
        if self.mode == 'occluded' and self.calls:
            return []
        if self.mode == 'post_occluded' and len(self.calls)>=2 and self.frame>=4:
            return []
        dx, dz = self.target[0]-self.x, self.target[1]-self.z
        h = math.radians(self.heading)
        right = math.cos(h)*dx + math.sin(h)*dz
        forward = -math.sin(h)*dx + math.cos(h)*dz - RANGE_CAL['L_cm']
        if forward <= 0:
            return []
        beta = math.atan2(right, forward)
        if abs(math.degrees(beta)) > 37:
            return []
        reading = (math.hypot(right,forward)-RANGE_CAL['a_cm'])*math.cos(beta)/RANGE_CAL['k']
        rows = [ball(reading,bearing=math.degrees(beta))]
        competing = self.mode == 'competing' or (self.mode == 'late_competing' and len(self.calls)>=2)
        return rows * 2 if competing else rows

    def call(self, method, params=None):
        if method == 'odometry':
            self.frame += 1
            return {'tick':self.tick,'rightCm':self.x,'forwardCm':self.z,
                    'headingDeg':self.heading,'distanceCm':self.travel}
        if method == 'local_road':
            return {'tick':self.tick,'onRoad':True,'atNode':self.at_node,
                    'atJunction':self.at_node,'exits':[{'angleDeg':0}] if self.at_node else [],
                    'headingErrorDeg':15 if self.mode=='turn_only' else 0,'frontClearanceCm':100,
                    'leftClearanceCm':10,'rightClearanceCm':10}
        if method == 'holding':return {'holding':False}
        if method == 'observe':
            return {'frameId':str(self.frame),'tick':self.tick,'width':640,'height':480,
                    'detections':self.pixels()}
        normalized = normalize(method,params)
        self.calls.append((method,copy.deepcopy(normalized)))
        self.tick += 1
        self.seconds += .1
        if self.mode == 'unknown':raise ConnectionError('synthetic unknown motion receipt')
        if method == 'turn':
            self.heading = wrap(self.heading+params['angleDeg'])
        else:
            amount = params.get('distanceCm',30)
            if self.mode == 'stationary':amount=0
            if self.mode == 'overshoot':amount=45
            if self.mode == 'curve' and method == 'follow_road':
                self.heading=wrap(self.heading+8)
            theta=math.radians(self.heading)
            sign=-1 if method=='backward' else 1
            self.x -= sign*amount*math.sin(theta)
            self.z += sign*amount*math.cos(theta)
            self.travel += amount
            if self.mode=='budget_overshoot' and len(self.calls)>=2:
                self.travel=121
        return {'accepted':True,'completed':True,'stoppedBy':'max_distance',
                'distanceCm':params.get('distanceCm',30)}


def sampling_runtime(**options):
    r=run.Runtime.__new__(run.Runtime)
    r.config={'task':'把两个红球送到绿色存放区'}
    r.task_spec=parse_task(r.config['task'])
    r.round=1;r.observation_count=0;r.recent=[]
    r.held_object_id=r.pending_grasp=None
    r.perception=Perception(CAMERA);r.roads=RoadMemory();r.bridge=SensorBridge(**options)
    r.trace=[];r.motions=[]
    r.observation_log=SimpleNamespace(write=lambda row:r.trace.append(copy.deepcopy(row)))
    r.motion_log=SimpleNamespace(write=lambda row:r.motions.append(copy.deepcopy(row)))
    r.actions=Actions(r);r.observe()
    return r


def discovery_id(r):
    return r.perception.discovery_evidence()['records'][0]['hypothesis_id']


def sample(r, selected=None):
    return r.actions.execute({'action':'explore','params':{'discovery_id':selected or discovery_id(r)}})


@pytest.mark.parametrize('at_node',[False,True])
def test_one_discovery_becomes_confirmed_via_real_sensor_motion_feedback(at_node):
    r=sampling_runtime(at_node=at_node)
    first=r.perception.objects()[0]
    assert first['state']=='TENTATIVE' and first['hit_count']==1
    result=sample(r)
    assert result['success'],result
    final=r.perception.get_object(first['id'])
    assert final['state']=='CONFIRMED' and final['hit_count']>=3
    poses=final['hit_poses']
    assert all(math.hypot(a['x_m']-b['x_m'],a['z_m']-b['z_m'])>=.15
               for i,a in enumerate(poses) for b in poses[:i])
    assert r.bridge.calls and not any(m in {'grab','release'} for m,p in r.bridge.calls)
    assert all(m!='take_exit' for m,p in r.bridge.calls), 'Unbounded exit travel can skip the window'
    assert result['evidence']['confirmation_sampling']['confirmed_object_id']==first['id']


@pytest.mark.parametrize('mode',['occluded','stationary','overshoot','competing'])
def test_bad_new_frames_do_not_manufacture_confirmation(mode):
    r=sampling_runtime(mode=mode)
    result=sample(r)
    assert not result['success'],result
    assert all(o['state']!='CONFIRMED' for o in r.perception.objects())
    assert len(r.bridge.calls)<=12
    if mode=='competing':assert r.bridge.calls==[]


def test_curved_road_is_reobserved_and_does_not_use_a_straight_assumption():
    r=sampling_runtime(mode='curve')
    result=sample(r)
    assert result['success'],result
    assert r.perception.objects()[0]['state']=='CONFIRMED'
    assert any(m=='follow_road' for m,p in r.bridge.calls)


def test_near_window_requires_observed_reverse_path_not_blind_backward():
    r=sampling_runtime(target=(0,48))
    result=sample(r)
    assert not result['success']
    assert result['reason']=='confirmation_no_safe_independent_viewpoint'
    assert r.bridge.calls==[]


def test_near_window_can_use_previously_observed_straight_road_to_sample():
    r=sampling_runtime(target=(0,82))
    selected=discovery_id(r)
    r.actions.move('forward',{'distanceCm':34,'speed':30})
    assert r.perception.objects()[0]['hit_count']==2
    result=sample(r,selected)
    assert result['success'],result
    assert r.perception.objects()[0]['state']=='CONFIRMED'
    assert any(m=='backward' for m,p in r.bridge.calls)


def test_no_safe_margin_between_two_hit_poses_does_not_invent_a_third():
    r=sampling_runtime(target=(0,78))
    selected=discovery_id(r)
    r.actions.move('forward',{'distanceCm':30,'speed':30})
    result=sample(r,selected)
    assert not result['success']
    assert result['reason']=='confirmation_no_safe_independent_viewpoint'
    assert r.perception.objects()[0]['hit_count']==2
    assert len(r.bridge.calls)==1


def test_actual_travel_over_sampler_budget_cannot_report_success():
    r=sampling_runtime(mode='budget_overshoot')
    result=sample(r)
    assert not result['success']
    proof=result['evidence']['confirmation_sampling']
    assert proof['travelled_cm']==121
    assert result['reason']=='confirmation_actual_travel_budget_exceeded'


def test_unknown_motion_is_not_resent():
    r=sampling_runtime(mode='unknown')
    with pytest.raises(ConnectionError) as error:sample(r)
    assert len(r.bridge.calls)==1
    assert len(error.value.action_evidence['confirmation_sampling']['steps'])==1


def test_outside_window_discovery_must_get_three_real_hits_after_approach():
    r=sampling_runtime(target=(0,106))
    selected=discovery_id(r)
    assert not r.perception.objects()
    result=sample(r,selected)
    assert result['success'],result
    proof=result['evidence']['confirmation_sampling']
    assert proof['initial_hit_count']==0 and proof['final_hit_count']>=3
    assert len(r.bridge.calls)>=3


def test_rotations_and_new_frames_alone_do_not_create_a_confirmation_hit():
    r=sampling_runtime(mode='turn_only')
    result=sample(r)
    assert not result['success']
    assert r.bridge.calls and all(method=='turn' for method,params in r.bridge.calls)
    assert all(o['hit_count']<=1 for o in r.perception.objects())


@pytest.mark.parametrize('mode',['post_occluded','late_competing'])
def test_final_confirmation_requires_fresh_unique_visible_support(mode):
    r=sampling_runtime(mode=mode)
    result=sample(r)
    assert not result['success'],result


def test_tentative_target_still_cannot_go_to_or_pick():
    for name in ('go_to','pick'):
        r=sampling_runtime();oid=r.perception.objects()[0]['id']
        result=r.actions.execute({'action':name,'params':{'object_id':oid}})
        assert not result['success'] and r.bridge.calls==[]


@pytest.mark.parametrize('lateral_cm',[1.,0.])
def test_reverse_requires_collinear_continuous_recorded_road(lateral_cm):
    from autonomous_brain.confirmation_sampling import _reverse_support
    r=sampling_runtime(target=(0,150))
    r.actions.move('forward',{'distanceCm':100,'speed':30})
    # A fresh pose near the interior of an old segment is not a proven route
    # from that segment's arrival. It cannot authorize an unrecorded reverse.
    r.bridge.x=lateral_cm;r.bridge.z=80;r.observe()
    assert _reverse_support(r.actions,15.5) is None
