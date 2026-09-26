"""Route execution uses the actual frozen platform parameter normalizer."""
import copy
import json
import math
from pathlib import Path
import subprocess
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import RoadMemory, position, wrap
from test_brain_navigation_reposition import sensor
from test_brain_route_evidence import curve_runtime

ROOT=Path(__file__).resolve().parents[1]
CONTRACT=ROOT/'workspaces/guangyang-platform/projects/car-python/robot-bridge-contract.js'


def normalize(method, params):
    command={'requestId':'synthetic-command','method':method,'params':params}
    process=subprocess.run(['node','-e',
        'const fs=require("fs"),c=require(process.argv[1]);process.stdout.write(JSON.stringify(c.normalizeCommand(JSON.parse(fs.readFileSync(0,"utf8")))));',
        str(CONTRACT)],input=json.dumps(command),text=True,capture_output=True)
    assert process.returncode==0, 'Actual frozen normalizeCommand rejected '+json.dumps(command)
    return json.loads(process.stdout)['params']


def straight_runtime(lengths, *, blocked=False, junction_after=None):
    row=sensor(1,(0,0)); calls=[]; motions=[]; camera={}
    points=[[0,0]];segments=[];cursor=0.
    for index,length in enumerate(lengths):
        end=cursor+length/100
        segments.append({'segment_id':str(index),'travelled_cm':length,'direction':'forward',
            'departure':{'position_m':[0,cursor],'travel_heading_deg':0,'at_node':index>0 and index-1==junction_after},
            'arrival':{'position_m':[0,end],'travel_heading_deg':0,'at_node':index==junction_after}})
        points.append([0,end]);cursor=end
    candidate={'position_m':points[-1],'path':points,'segments':segments,'route_version':'synthetic-public-trace'}
    target={'id':'red','category':'red-ball','state':'CONFIRMED','position_m':{'x':0,'z':cursor+.3}}
    roads=RoadMemory()
    roads.approach_candidates=lambda *a,**k:[copy.deepcopy(candidate)]
    runtime=SimpleNamespace(snapshot=row,round=1,roads=roads,
        bridge=SimpleNamespace(seconds=0,max_seconds=1200),motion_log=SimpleNamespace(write=motions.append),
        perception=SimpleNamespace(objects=lambda:[target],get_object=lambda _:target,
            confirmed=lambda _:target,visible=lambda _:camera))
    def refresh():
        row['road'].update(atNode=junction_after is not None and abs(row['odometry']['forwardCm']/100-points[junction_after+1][1])<1e-8,
            frontClearanceCm=.1 if blocked else 100,headingErrorDeg=0)
        camera.update(category='red-ball',track_id='red',frame_id=row['observation']['frameId'],
            distance_cm=(target['position_m']['z']-position(row['odometry'])[1])*100,bearing_deg=0)
        row['perception']['detections']=[camera]
    def call(method,params):
        normalized=normalize(method,params);calls.append((method,copy.deepcopy(normalized)))
        if method=='turn':row['odometry']['headingDeg']=wrap(row['odometry']['headingDeg']+params['angleDeg'])
        else:
            length=params['distanceCm'];assert method in {'forward','follow_road'}
            row['odometry']['forwardCm']+=length;row['odometry']['distanceCm']+=length
        return {'accepted':True,'completed':True}
    def observe(*,motion=None):
        row['observation_index']+=1;row['odometry']['tick']+=1
        row['observation']={'frameId':str(row['observation_index']),'tick':row['odometry']['tick']}
        refresh()
    runtime.bridge.call=call;runtime.observe=observe;refresh()
    return runtime,candidate,calls,motions


def test_thirty_then_six_does_not_consume_first_leg_at_twenty_or_send_illegal_follow():
    runtime,candidate,calls,_=straight_runtime([30,6])
    reached,reason,steps=Actions(runtime)._follow_approach_path(candidate,[20])
    assert reached,reason
    assert calls==[('follow_road',{'distanceCm':20,'speed':50}),('follow_road',{'distanceCm':10,'speed':50}),
                   ('forward',{'distanceCm':6,'speed':30})]
    assert 'completed_segment_ids' not in steps[0]
    assert steps[1]['completed_segment_ids']==['0'] and steps[2]['completed_segment_ids']==['1']
    assert all(s.get('historical_arc_retraced') for s in steps if s.get('completed_segment_ids'))
    assert runtime.snapshot['odometry']['distanceCm']==pytest.approx(36)


@pytest.mark.parametrize('lengths',[[6],[4,4],[6,3],[2,2,2],[6,6],[3,3,6],[20,20],[30,6],[6,20],[3,3,30],[6,500]])
def test_complete_reposition_uses_legal_commands_and_fresh_original_visual_gate(lengths):
    runtime,_,calls,_=straight_runtime(lengths)
    actions=Actions(runtime)
    outcome=actions._road_reposition('red',actions.result(False,'requires_reposition'),[30])
    assert outcome['success'],outcome
    attempt=outcome['evidence']['road_reposition']['attempts'][0]
    assert attempt['reached'] and attempt['approach_observation']>attempt['steps'][-1]['after_observation']
    assert 25<=outcome['evidence']['detection']['distance_cm']<=40
    assert sum(p['distanceCm'] for method,p in calls if method!='turn')==pytest.approx(sum(lengths))


@pytest.mark.parametrize('lengths',[[4,4],[6,3],[2,2,2]])
def test_subten_aggregate_has_one_matching_endpoint_budget_and_command(lengths):
    runtime,candidate,calls,_=straight_runtime(lengths)
    budget=[1]
    reached,reason,steps=Actions(runtime)._follow_approach_path(candidate,budget)
    assert reached,reason
    assert budget==[0]
    assert calls==[('forward',{'distanceCm':sum(lengths),'speed':30})]
    assert steps[0]['execution_plan']['remaining_arc_cm']==sum(lengths)
    assert steps[0]['completed_segment_ids']==[str(i) for i in range(len(lengths))]


@pytest.mark.parametrize('lengths',[[4,4],[6,3],[2,2,2]])
def test_subten_aggregate_cannot_bypass_fresh_clearance_or_zero_budget(lengths):
    runtime,candidate,calls,_=straight_runtime(lengths,blocked=True)
    reached,reason,steps=Actions(runtime)._follow_approach_path(candidate,[1])
    assert not reached and reason=='reposition_short_segment_no_safe_legal_motion'
    assert calls==[] and steps==[]
    runtime,candidate,calls,_=straight_runtime(lengths)
    reached,reason,steps=Actions(runtime)._follow_approach_path(candidate,[0])
    assert not reached and reason=='reposition_motion_budget_exhausted'
    assert calls==[] and steps==[]


def test_subten_aggregate_stops_at_internal_junction_without_silent_consumption():
    runtime,candidate,calls,_=straight_runtime([4,4],junction_after=0)
    reached,reason,steps=Actions(runtime)._follow_approach_path(candidate,[2])
    assert not reached and reason=='reposition_exit_correspondence_unavailable'
    assert calls==[('forward',{'distanceCm':4,'speed':30})]
    assert steps[0]['completed_segment_ids']==['0']


def test_short_leg_ending_at_node_is_not_combined_across_unhandled_exit():
    runtime,candidate,calls,_=straight_runtime([6,20],junction_after=0)
    reached,reason,steps=Actions(runtime)._follow_approach_path(candidate,[20])
    assert not reached and reason=='reposition_exit_correspondence_unavailable'
    assert calls==[('forward',{'distanceCm':6,'speed':30})]
    assert steps[0]['completed_segment_ids']==['0']


def test_no_safe_short_translation_stops_without_illegal_command():
    runtime,candidate,calls,_=straight_runtime([6],blocked=True)
    reached,reason,_=Actions(runtime)._follow_approach_path(candidate,[20])
    assert not reached and reason=='reposition_short_segment_no_safe_legal_motion'
    assert calls==[]


def test_curved_complete_route_passes_actual_parameter_normalizer():
    runtime,calls=curve_runtime();original=runtime.bridge.call
    def checked(method,params):
        normalize(method,params)
        return original(method,params)
    runtime.bridge.call=checked
    result=Actions(runtime).execute({'action':'go_to','params':{'object_id':'red'}})
    assert result['success'],result
    assert all(params['distanceCm']>=10 for method,params in calls if method=='follow_road')


def test_waypoint_overshoot_cannot_consume_unreplayed_arc_despite_legal_command():
    runtime,candidate,calls,_=straight_runtime([30])
    original=runtime.bridge.call
    def overshoot(method,params):
        result=original(method,params)  # Includes the real normalizeCommand.
        if method=='follow_road':
            runtime.snapshot['odometry']['forwardCm']+=12
            runtime.snapshot['odometry']['distanceCm']+=12
        return result
    runtime.bridge.call=overshoot
    reached,reason,steps=Actions(runtime)._follow_approach_path(candidate,[20])
    assert not reached and reason=='reposition_recorded_arc_exhausted_without_arrival'
    assert calls==[('follow_road',{'distanceCm':20,'speed':50})]
    assert all(not step.get('completed_segment_ids') for step in steps)
