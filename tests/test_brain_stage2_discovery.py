"""Persistent discovery obligations use public pixels, never hidden targets."""
import copy

import pytest

from test_brain_perception import CAMERA, Perception, ball, observe, grasp_evidence, placement_evidence


def delivered_perception(category='red-ball'):
    p = Perception(CAMERA)
    for frame,forward in enumerate((0,16,32),1):
        observe(p,frame,forward,items=[ball(80-forward,category=category)])
    oid = next(row['id'] for row in p.objects() if row['category']==category)
    proof = grasp_evidence(p,oid,time=1)
    proof['post_observation'] = p.last_evidence['frame_id']
    assert p.mark_picked(oid,holding=True,original_position_absent=True,
                         simulation_time_s=1,evidence=proof)
    if category=='red-ball':
        evidence = placement_evidence(p,oid)
    else:
        zone = {'category':'storage-zone','source':'storage-ground-pixels','confidence':1,
                'bbox':{'x':240,'y':230,'w':160,'h':100}}
        current = observe(p,4,time=2,items=[ball(60,category=category),zone])
        witness,storage = current['detections']
        evidence = {'holding':False,'candidate_witnesses':1,
            'release_observation':{'frame_id':'4','simulation_time_s':2,'preexisting_ball_ids':[]},
            'placement':{'ball_track_id':witness['track_id'],'ball_category':category,
                'ball_position_m':witness['position_m'],'ball_bbox':witness['bbox'],
                'storage_bbox':storage['bbox'],'frame_id':'4'}}
    assert p.mark_delivered(oid,holding=False,ball_in_storage=True,simulation_time_s=2,evidence=evidence)
    return p,oid


def current_public_frame(p,*,frame=5,source_index=71,items=None,forward=30,time=3):
    raw = {'frameId':str(frame),'tick':frame,'width':640,'height':480,
           'detections':items if items is not None else [ball(30,bearing=-3),ball(30,bearing=3)]}
    odo = {'rightCm':0,'forwardCm':forward,'headingDeg':0,'distanceCm':forward,'tick':frame}
    result = p.update(raw,odo,simulation_time_s=time,round_index=10,
                      observation_index=source_index)
    return raw,result


def test_two_unadmitted_red_boxes_keep_distinct_source_obligations_without_wm_admission():
    p,old = delivered_perception()
    raw,current = current_public_frame(p)
    assert all(d.get('identity_ambiguity') and d.get('track_id') is None
               and d['fed_to_world_model'] is False for d in current['detections'])
    assert len([row for row in p.objects() if row['category']=='red-ball'])==1
    ledger = p.discovery_evidence()
    assert ledger['schema']=='brain-discovery-evidence/v2'
    assert len(ledger['unresolved'])==2
    assert len({row['id'] for row in ledger['unresolved']})==2
    for index,row in enumerate(ledger['unresolved']):
        assert row['frame_id']=='5' and row['observation_index']==71
        assert row['tick']==5 and row['round']==10 and row['simulation_time_s']==3
        assert row['detection_index']==index and row['bbox']==raw['detections'][index]['bbox']
        assert row['candidate_ids']==[old]
        assert row['identity_ambiguity']==current['detections'][index]['identity_ambiguity']
        assert row['reason']==row['identity_ambiguity']['reason']
        assert row['admission_reason']=='outside_demo_memory_window'


def test_empty_frames_and_all_candidates_delivered_do_not_discharge_two_box_conflict():
    p,old = delivered_perception()
    current_public_frame(p)
    before = p.discovery_evidence()
    assert p.get_object(old)['state']=='DELIVERED'
    current_public_frame(p,frame=6,source_index=72,time=3.1,items=[])
    current_public_frame(p,frame=7,source_index=73,time=9,items=[])
    assert p.discovery_evidence()==before


def test_repeated_geometry_keeps_original_source_rows_instead_of_rewriting_by_frame_number():
    p,_ = delivered_perception()
    current_public_frame(p)
    before = p.discovery_evidence()['unresolved']
    current_public_frame(p,frame=6,source_index=72,time=3.1)
    after = p.discovery_evidence()['unresolved']
    assert len(after)==4 and after[:2]==before
    assert {(d['frame_id'],d['detection_index']) for d in after}=={('5',0),('5',1),('6',0),('6',1)}


def test_discovery_query_is_detached_and_missing_original_index_is_reported_honestly():
    p,_ = delivered_perception()
    current_public_frame(p,source_index=None)
    first = p.discovery_evidence()
    assert all(d['observation_index'] is None and d['perception_observation_index']>0
               for d in first['unresolved'])
    snapshot = copy.deepcopy(first)
    first['unresolved'][0]['bbox']['x']=-999
    first['unresolved'][0]['candidate_ids'].clear()
    first['unresolved'].pop()
    assert p.discovery_evidence()==snapshot


@pytest.mark.parametrize('case',['blue_ambiguity','admitted_red_ambiguity','isolated_old_red','no_old_identity'])
def test_every_unexplained_red_has_an_obligation_without_changing_admission(case):
    if case=='blue_ambiguity':
        p,_ = delivered_perception('blue-ball')
        items = [ball(30,bearing=-3,category='blue-ball'),ball(30,bearing=3,category='blue-ball')]
        _,current = current_public_frame(p,items=items)
        assert all(d.get('identity_ambiguity') for d in current['detections'])
    elif case=='admitted_red_ambiguity':
        p,_ = delivered_perception()
        _,current = current_public_frame(p,forward=0,items=[ball(60,bearing=-3),ball(60,bearing=3)])
        assert all(d['fed_to_world_model'] and d.get('identity_ambiguity') for d in current['detections'])
    elif case=='isolated_old_red':
        p,old = delivered_perception()
        _,current = current_public_frame(p,items=[ball(30)])
        assert current['detections'][0]['known_delivered_object_id']==old
    else:
        p = Perception(CAMERA)
        _,current = current_public_frame(p)
        assert all(not d.get('identity_ambiguity') for d in current['detections'])
    if case in {'admitted_red_ambiguity', 'no_old_identity'}:
        # Recovery v2 records ordinary red discoveries as well as ambiguity;
        # admission alone does not resolve a competing identity assignment.
        assert len(p.discovery_evidence()['unresolved'])==2
    else:
        assert p.discovery_evidence()['unresolved']==[]


def test_later_isolated_old_label_does_not_explain_the_earlier_second_box():
    p,old = delivered_perception()
    current_public_frame(p)
    before = p.discovery_evidence()
    _,later = current_public_frame(p,frame=6,source_index=72,time=3.1,items=[ball(30)])
    assert later['detections'][0]['known_delivered_object_id']==old
    later_ledger=p.discovery_evidence()
    assert later_ledger['unresolved']==before['unresolved']
    assert later_ledger['records'][:len(before['records'])]==before['records']
    assert later_ledger['resolutions']==before['resolutions']==[]
