"""Real public r186 cue window; mutation checks are component tests, not runs."""
import ast
import copy
import inspect
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain import confirmation_sampling as sampling
from autonomous_brain.road_evidence import RoadEvidence


FIXTURE=Path(__file__).parent/'fixtures/run_20261018T104814Z_r186_localized_cue_public.json'


def window():
    return json.loads(FIXTURE.read_text())['window']


def observed_window(data,**kw):
    actions=SimpleNamespace(r=SimpleNamespace(roads=SimpleNamespace(
        observation_records=lambda first,last:copy.deepcopy(data))))
    return sampling._observed_motion_window(actions,860,data['observations'][-1],**kw)


def test_r186_known_clearance_prefix_only_extends_navigation_cue_continuity():
    data=window()
    frames={f['observation_index']:f for f in data['observations']}
    motion=next(m for m in data['motions'] if m['after_observation']==883)
    assert not RoadEvidence.step_valid(frames[882],frames[883],motion)
    assert RoadEvidence.clearance_stop_localized(frames[882],frames[883],motion)
    assert observed_window(data) is None
    assert observed_window(data,allow_localized_stop=False) is None
    assert observed_window(data,allow_localized_stop=True) is not None


@pytest.mark.parametrize('case',[
    'unknown_execution','motion_not_sent','missing_receipt','missing_request_id',
    'ack_not_accepted','ack_error','ack_ticks','ack_distance','collision',
    'holding_changed','holding_unknown','offroad','sensor_tick','road_tick',
    'stale_frame','front_not_localized','no_fresh_exit','missing_motion',
    'missing_observation','duplicate_motion','zero_translation',
])
def test_localized_cue_window_keeps_every_evidence_guard(case):
    data=window();fs={f['observation_index']:f for f in data['observations']}
    motion=next(m for m in data['motions'] if m['after_observation']==883)
    if case=='unknown_execution':motion['outcome_unknown']=True
    elif case=='motion_not_sent':motion['motion_not_sent']=True
    elif case=='missing_receipt':del motion['actuator_result']
    elif case=='missing_request_id':del motion['bridge_request_id']
    elif case=='ack_not_accepted':motion['actuator_result']['accepted']=False
    elif case=='ack_error':motion['actuator_result']['error']='unknown'
    elif case=='ack_ticks':motion['actuator_result']['elapsedTicks']=141
    elif case=='ack_distance':motion['actuator_result']['distanceCm']=30
    elif case=='collision':motion['actuator_result']['stoppedBy']='collision'
    elif case=='holding_changed':fs[883]['holding']['holding']=True
    elif case=='holding_unknown':del fs[883]['holding']
    elif case=='offroad':fs[883]['road']['onRoad']=False
    elif case=='sensor_tick':fs[883]['observation']['tick']-=1
    elif case=='road_tick':fs[883]['road']['tick']-=1
    elif case=='stale_frame':fs[883]['observation']['frameId']=fs[882]['observation']['frameId']
    elif case=='front_not_localized':fs[883]['road']['frontClearanceCm']=2
    elif case=='no_fresh_exit':fs[882]['road']['exits']=[]
    elif case=='missing_motion':data['motions'].remove(motion)
    elif case=='missing_observation':data['observations'].remove(fs[883])
    elif case=='duplicate_motion':data['motions'].append(copy.deepcopy(motion))
    elif case=='zero_translation':
        fs[883]['odometry'].update({k:fs[882]['odometry'][k]
            for k in ('rightCm','forwardCm','distanceCm')})
        motion['actuator_result']['distanceCm']=0
    else:raise AssertionError(case)
    assert observed_window(data,allow_localized_stop=True) is None


def test_reverse_support_and_restore_keep_strict_window_scope():
    # This complements their execution regressions: neither caller may opt
    # into the navigation-only exception in a future refactor.
    for function in (sampling._recorded_translation_support,sampling._restore_plan):
        calls=[n for n in ast.walk(ast.parse(inspect.getsource(function)))
            if isinstance(n,ast.Call) and isinstance(n.func,ast.Name)
            and n.func.id=='_observed_motion_window']
        assert len(calls)==1
        assert all(k.arg!='allow_localized_stop' for k in calls[0].keywords)
