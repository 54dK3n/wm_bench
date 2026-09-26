"""Explore result meanings use real RoadMemory, public sensors and legal commands."""
import copy

import pytest

from test_brain_observed_routes import frame, runtime
from test_brain_route_contract import normalize


def semantic_runtime(monkeypatch,tmp_path,movements,**kwargs):
    r=runtime(monkeypatch,tmp_path,movements,**kwargs)
    calls=[]
    original=r.bridge.call
    def legal(method,params=None):
        if method in {'turn','forward','backward','follow_road','take_exit'}:
            normalize(method,params or {})
            calls.append((method,copy.deepcopy(params)))
        return original(method,params)
    r.bridge.call=legal
    return r,calls


def test_next_junction_requires_new_complete_trip_between_confirmed_semantic_nodes(monkeypatch,tmp_path):
    r,calls=semantic_runtime(monkeypatch,tmp_path,[
        ('take_exit',frame(20,20,10),{'accepted':True,'stoppedBy':'entered_road','distanceCm':20}),
        ('follow_road',frame(40,40,20,exits=(180,)),{'accepted':True,'stoppedBy':'junction','distanceCm':20})])
    result=r.actions.explore(0)
    assert result['success'] and result['reason']=='next_junction_observed'
    progress=result['evidence']['road_progress']
    assert progress['different_node_verified']
    assert progress['start_node_id']!=progress['end_node_id']
    assert progress['arrival_traversal_ids']==['traversal-1']
    assert [m for m,_ in calls]==['take_exit','follow_road']


def test_one_cm_translation_between_same_profile_nodes_is_not_next_junction(monkeypatch,tmp_path):
    r,calls=semantic_runtime(monkeypatch,tmp_path,[
        ('take_exit',frame(1,1,10,exits=(0,)),{'accepted':True,'stoppedBy':'entered_road','distanceCm':1})])
    result=r.actions.explore(0)
    assert not result['success'] and result['reason']=='junction_identity_unresolved'
    assert not r.roads.traversal_records()
    assert result['evidence']['road_progress']['net_displacement_cm']==1
    assert len(calls)==1


def test_starting_midroad_cannot_turn_an_unselected_arrival_into_completed_exit(monkeypatch,tmp_path):
    r,calls=semantic_runtime(monkeypatch,tmp_path,[
        ('follow_road',frame(20,20,10,exits=(180,)),{'accepted':True,'stoppedBy':'junction','distanceCm':20})],exits=())
    result=r.actions.explore()
    assert not result['success'] and result['reason']=='road_node_observed_without_completed_traversal'
    assert result['evidence']['road_progress']['arrival_traversal_ids']==[]
    assert len(calls)==1


def test_returning_to_same_anchor_does_not_claim_a_different_junction(monkeypatch,tmp_path):
    r,calls=semantic_runtime(monkeypatch,tmp_path,[
        ('take_exit',frame(20,20,10),{'accepted':True,'stoppedBy':'entered_road','distanceCm':20}),
        ('follow_road',frame(0,40,20,heading=-180,exits=(180,)),
         {'accepted':True,'stoppedBy':'junction','distanceCm':20})])
    result=r.actions.explore(0)
    assert not result['success'] and result['reason']=='same_junction_reobserved'
    progress=result['evidence']['road_progress']
    assert progress['start_node_id']==progress['end_node_id']
    assert progress['net_displacement_cm']==0 and progress['odometer_travel_cm']==40
    assert progress['arrival_traversal_ids']==[] and len(calls)==2


@pytest.mark.parametrize('category,state,reason',[
    ('red-ball','TENTATIVE','target_objects_observed'),('red-ball','CONFIRMED','target_objects_confirmed'),
    ('blue-ball','CONFIRMED','other_objects_confirmed')])
def test_target_evidence_and_exit_entry_are_distinct_from_arrival(monkeypatch,tmp_path,category,state,reason):
    r,calls=semantic_runtime(monkeypatch,tmp_path,[
        ('take_exit',frame(20,20,10),{'accepted':True,'stoppedBy':'entered_road','distanceCm':20})])
    original=r.bridge.call
    objects=[]
    r.perception.objects=lambda:copy.deepcopy(objects)
    def reveal(method,params=None):
        result=original(method,params)
        if method=='take_exit':
            objects.append({'id':'new-1','category':category,'state':state})
        return result
    r.bridge.call=reveal
    result=r.actions.explore(0)
    assert result['success'] and result['reason']==reason
    progress=result['evidence']['road_progress']
    assert progress['status']=='exit_entered' and not progress['different_node_verified']
    target=result['evidence']['target_progress']
    assert target['new_target_object_ids']==(['new-1'] if category=='red-ball' else [])
    assert target['new_other_object_ids']==(['new-1'] if category!='red-ball' else [])
    assert len(calls)==1 and not r.roads.traversal_records()


def test_trip_started_in_an_earlier_action_can_finish_during_explore(monkeypatch,tmp_path):
    r,calls=semantic_runtime(monkeypatch,tmp_path,[
        ('take_exit',frame(20,20,10),{'accepted':True,'stoppedBy':'entered_road','distanceCm':20}),
        ('follow_road',frame(40,40,20,exits=(180,)),{'accepted':True,'stoppedBy':'junction','distanceCm':20})])
    r.actions.take_observed_exit(0)
    r.round=2
    r.observe()
    result=r.actions.explore()
    progress=result['evidence']['road_progress']
    assert result['success'] and result['reason']=='next_junction_observed'
    assert progress['start_node_id'] is None and progress['end_node_id'] is not None
    assert progress['new_traversal_ids']==progress['arrival_traversal_ids']==['traversal-1']
    assert len(calls)==2


def test_a_previous_completed_trip_cannot_be_reused_as_new_arrival(monkeypatch,tmp_path):
    r,_=semantic_runtime(monkeypatch,tmp_path,[
        ('take_exit',frame(20,20,10),{'accepted':True,'stoppedBy':'entered_road','distanceCm':20}),
        ('follow_road',frame(40,40,20,exits=(180,)),{'accepted':True,'stoppedBy':'junction','distanceCm':20})])
    assert r.actions.explore(0)['success']
    start=copy.deepcopy(r.snapshot)
    prior={t['id'] for t in r.roads.road_evidence()['traversals']}
    r.observe()
    result=r.actions._semantic_explore_result(r.actions.result(True,'next_junction_observed'),
        start,prior,set(),set())
    assert not result['success'] and result['reason']=='same_junction_reobserved'
    assert result['evidence']['road_progress']['arrival_traversal_ids']==[]


def test_complete_same_node_loop_is_progress_and_never_a_different_node(monkeypatch,tmp_path):
    r,calls=semantic_runtime(monkeypatch,tmp_path,[
        ('take_exit',frame(5,5,10),{'accepted':True,'stoppedBy':'entered_road','distanceCm':5}),
        ('follow_road',frame(0,20,20,heading=90,exits=(-90,-180)),
         {'accepted':True,'stoppedBy':'junction','distanceCm':15})],exits=(0,-90))
    result=r.actions.explore(0)
    assert result['success'] and result['reason']=='same_junction_progress_observed'
    progress=result['evidence']['road_progress']
    assert progress['start_node_id']==progress['end_node_id']
    assert not progress['different_node_verified'] and progress['arrival_traversal_ids']==['traversal-1']
    assert progress['net_displacement_cm']==0 and progress['odometer_travel_cm']==20
    assert len(calls)==2


def test_boundary_probe_is_reclassified_using_its_complete_real_trip(monkeypatch,tmp_path):
    r,calls=semantic_runtime(monkeypatch,tmp_path,[
        ('take_exit',frame(20,20,10),{'accepted':True,'stoppedBy':'entered_road','distanceCm':20}),
        ('follow_road',frame(20.5,20.5,11),{'accepted':True,'stoppedBy':'junction','distanceCm':.5}),
        ('forward',frame(24.5,24.5,15,exits=(180,)),{'completed':True})])
    result=r.actions.explore(0)
    assert result['success'] and result['reason']=='next_junction_observed'
    assert result['evidence']['road_progress']['arrival_traversal_ids']==['traversal-1']
    assert result['evidence']['junction_recovery']['requested_total_cm']==4
    assert [m for m,_ in calls]==['take_exit','follow_road','forward']


def test_boundary_probe_without_departure_proof_retains_unknown_connection(monkeypatch,tmp_path):
    r,calls=semantic_runtime(monkeypatch,tmp_path,[
        ('follow_road',frame(.5,.5,1),{'accepted':True,'stoppedBy':'junction','distanceCm':.5}),
        ('forward',frame(4.5,4.5,5,exits=(180,)),{'completed':True})],exits=())
    result=r.actions.explore()
    assert not result['success'] and result['reason']=='road_node_observed_without_completed_traversal'
    assert result['evidence']['road_progress']['arrival_traversal_ids']==[]
    assert result['evidence']['junction_recovery']['requested_total_cm']==4
    assert [m for m,_ in calls]==['follow_road','forward']


@pytest.mark.parametrize('invalid', ['stale_frame','rejected_motion'])
def test_invalid_arrival_evidence_cannot_claim_next_node(monkeypatch,tmp_path,invalid):
    r,calls=semantic_runtime(monkeypatch,tmp_path,[
        ('take_exit',frame(20,20,10),{'accepted':True,'stoppedBy':'entered_road','distanceCm':20}),
        ('follow_road',frame(40,40,20,exits=(180,)),
         {'accepted':invalid!='rejected_motion','stoppedBy':'junction','distanceCm':20})])
    original=r.bridge.call
    def corrupt(method,params=None):
        if invalid=='stale_frame' and method=='observe' and r.bridge.current['odometry']['tick']==20:
            r.bridge.frame_index-=1
        return original(method,params)
    r.bridge.call=corrupt
    if invalid=='stale_frame':
        from autonomous_brain.actions import ObservedMotionFailure
        # Public execute catches this failure; the direct primitive must abort
        # before the explore result classifier can claim an arrival.
        with pytest.raises(ObservedMotionFailure) as failure:
            r.actions.explore(0)
        assert failure.value.evidence['frame_fresh'] is False
        assert not r.roads.traversal_records()
    else:
        result=r.actions.explore(0)
        assert not result['success'] and result['reason']!='next_junction_observed'
        assert not result['evidence']['road_progress']['different_node_verified']
        assert result['evidence']['road_progress']['arrival_traversal_ids']==[]
    assert len(calls)==2


def test_no_junction_or_target_keeps_original_twelve_step_budget(monkeypatch,tmp_path):
    r,calls=semantic_runtime(monkeypatch,tmp_path,[
        ('follow_road',frame(i*20,i*20,i),{'accepted':True,'stoppedBy':'max_distance','distanceCm':20})
        for i in range(1,13)],exits=())
    result=r.actions.explore()
    assert result['reason']=='bounded_road_segment_observed'
    progress=result['evidence']['road_progress']
    assert progress['status']=='road_segment_progress' and not progress['different_node_verified']
    assert progress['arrival_traversal_ids']==[]
    assert len(calls)==12 and sum(p['distanceCm'] for _,p in calls)==240
