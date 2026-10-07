"""Bounded real r67 public component regression; no task-success assertion."""
import copy
import json
from pathlib import Path
import pytest
from test_brain_clearance_prefix import reconstruct

FIXTURE=Path(__file__).parent/'fixtures/run_20261007T224158_r67_public.json'
def source():return json.loads(FIXTURE.read_text())
def rebuilt(data=None):
    mem,_=reconstruct(273,data or source())
    return mem,copy.deepcopy(mem._semantic.frames[273])

def test_real_r67_contiguous_measured_curved_prefix_allows_bounded_return_attempt():
    mem,frame=rebuilt()
    support=mem.observed_road_return_support(frame)
    assert support is not None
    assert support['before_observation']==270 and support['after_observation']==272
    assert support['target_anchor']['observation_index']==270
    assert support['max_travel_cm']==pytest.approx(60.6)
    assert [s['segment_id'] for s in support['observed_segments']]==['road-segment-270-271','road-segment-271-272']
    # The first curved command travelled 40.6 cm with only a 9.48 cm chord.
    assert support['observed_segments'][0]['measured_cm']<10
    assert mem.passage_blocked(frame,-101.3) is not None
    before=mem.road_evidence()
    mem.observed_road_return_support(frame)
    assert mem.road_evidence()==before  # Proposal never records a successful return.

@pytest.mark.parametrize('bad',['unknown','unsent','basic','no_root','gap','reverse_blocked',
    'missing_frame','stale_frame','tick','distance','elapsed','holding','offroad','missing_reverse','edge_version','different_endpoint','rejected','collision','receipt_error'])
def test_unproved_chain_does_not_authorize_return(bad):
    data=source()
    if bad in ['missing_frame','stale_frame','tick','distance','elapsed','holding','offroad']:
        row=next(o for o in data['observations'] if o['observation_index']==271)
        motion=next(m for m in data['motions'] if m['after_observation']==271)
        if bad=='missing_frame':row['observation'].pop('frameId')
        if bad=='stale_frame':row['observation']['frameId']=270
        if bad=='tick':row['road']['tick']-=1
        if bad=='distance':motion['actuator_result']['distanceCm']+=2
        if bad=='elapsed':motion['actuator_result']['elapsedTicks']-=1
        if bad=='holding':row['holding']['holding']=True
        if bad=='offroad':row['road']['onRoad']=False
    mem,frame=rebuilt(data)
    part=mem._road_segments.get('road-segment-270-271')
    if bad=='rejected':part['motion']['actuator_result']['accepted']=False
    if bad=='collision':part['motion']['actuator_result']['stoppedBy']='collision'
    if bad=='receipt_error':part['motion']['actuator_result']['error']='unknown'
    if bad=='unknown':part['motion']['outcome_unknown']=True
    if bad=='unsent':part['motion']['motion_not_sent']=True
    if bad=='basic':part['execution']['kind']='basic_translation'
    if bad=='no_root':part['departure']['at_node']=False
    if bad=='gap':part['after_observation']=270
    if bad=='missing_reverse':mem._approach_edges[tuple(part['arrival']['position_m'])].pop(tuple(part['departure']['position_m']))
    if bad=='edge_version':mem._approach_edges[tuple(part['arrival']['position_m'])][tuple(part['departure']['position_m'])]['segment_version']='unknown'
    if bad=='different_endpoint':part['arrival']['position_m'][0]+=.001
    if bad=='reverse_blocked':
        before=copy.deepcopy(frame);before['odometry']['headingDeg']+=180
        after=copy.deepcopy(before);after['observation_index']+=1
        mem.remember_passage_failure(before,after,{'method':'follow_road','actuator_result':{'accepted':True,'stoppedBy':'front_clearance','distanceCm':0}})
    assert mem.observed_road_return_support(frame) is None

@pytest.mark.parametrize('field',['distanceCm','rightCm','headingDeg'])
def test_intermediate_static_observation_cannot_hide_unmeasured_motion(field):
    mem,frame=rebuilt()
    final=copy.deepcopy(frame);final['observation_index']=274;final['observation']['frameId']=274
    mem.update(final['odometry'],final['road'],274);mem.observe_traversal(final)
    mem._semantic.frames[273]['odometry'][field]+=1
    assert mem.observed_road_return_support(final) is None
