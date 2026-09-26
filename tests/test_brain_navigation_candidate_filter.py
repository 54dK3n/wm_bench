"""Public observed routes; candidate filtering must precede the three-slot cap."""
import pytest

from autonomous_brain.actions import Actions
from test_brain_route_contract import normalize, straight_runtime
from test_brain_stage2_adversarial import SensorTrace


def four_observed_routes():
    trace=SensorTrace()
    trace.publish(0,0)
    def move(z,heading,travel,method,params):
        normalize(method,params)
        trace.publish(0,z,heading=heading,travelled=travel,method=method,params=params)
    move(58,0,58,'follow_road',{'distanceCm':58})
    move(116,0,116,'follow_road',{'distanceCm':58})
    move(117,0,117,'forward',{'distanceCm':1})
    move(118,0,118,'forward',{'distanceCm':1})
    move(117,0,119,'backward',{'distanceCm':1})
    move(116,0,120,'backward',{'distanceCm':1})
    move(58,0,178,'backward',{'distanceCm':58})
    move(0,0,236,'backward',{'distanceCm':58})
    # A separate observed branch has 118 cm of arc and 115 cm net travel.
    # It has no fabricated edges to the first branch's nearby sample points.
    for z,travel,length in [(38.3,275,39),(76.6,314,39),(115,354,40)]:
        move(z,0,travel,'follow_road',{'distanceCm':length})
    move(115,-180,354,'turn',{'angleDeg':-180})
    for z,travel,length in [(76.6,394,40),(38.3,433,39),(0,472,39)]:
        move(z,-180,travel,'follow_road',{'distanceCm':length})
    move(0,0,472,'turn',{'angleDeg':-180})
    return trace


def test_filtering_three_failed_versions_exposes_a_new_118_cm_route_before_cap():
    trace=four_observed_routes()
    odo=trace.current['odometry']
    first=trace.roads.approach_candidates(odo,(0,1.5))
    assert len(first)==3 and [c['position_m'] for c in first]==[[0,1.18],[0,1.17],[0,1.16]]
    failed={c['route_version'] for c in first}
    candidates=trace.roads.approach_candidates(odo,(0,1.5),
        candidate_filter=lambda c:c['route_version'] not in failed)
    assert len(candidates)==1
    assert candidates[0]['position_m']==[0,1.15]
    assert candidates[0]['travelled_cm']==118
    assert candidates[0]['route_version'] not in failed


def test_reposition_executes_new_route_after_three_context_relevant_failures():
    trace=four_observed_routes()
    runtime,_,calls,_=straight_runtime([39,39,40])
    runtime.roads=trace.roads
    runtime.perception.get_object('red')['position_m']['z']=1.5
    runtime.observe()
    actions=Actions(runtime)
    context=actions._navigation_context('red')
    record=actions._navigation_record('red')
    for candidate in trace.roads.approach_candidates(runtime.snapshot['odometry'],(0,1.5)):
        runtime.navigation_progress.remember_approach(record,candidate,context,
            status='route_not_reached',reason='synthetic_previous_failure',reached=False,
            before_observation=1,after_observation=2)
    budget=[45]
    result=actions._road_reposition('red',actions.result(False,'requires_reposition'),budget)
    assert result['success'],result
    attempts=result['evidence']['road_reposition']['attempts']
    assert len(attempts)==1 and attempts[0]['candidate']['travelled_cm']==118
    assert attempts[0]['candidate']['position_m']==[0,1.15]
    assert sum(p['distanceCm'] for m,p in calls if m!='turn')==pytest.approx(118)
    assert 0<=budget[0]<45


def test_optional_filter_preserves_old_positional_api_and_three_candidate_cap():
    trace=four_observed_routes()
    odo=trace.current['odometry']
    original=trace.roads.approach_candidates(odo,(0,1.5))
    assert trace.roads.approach_candidates(odo,(0,1.5),[[0,1.18]],99,[])==original
    assert len(trace.roads.approach_candidates(odo,(0,1.5),limit=99,candidate_filter=lambda c:True))==3
    assert trace.roads.approach_candidates(odo,(0,1.5),candidate_filter=lambda c:False)==[]


def test_actual_candidate_attempts_remain_three_and_frame_only_changes_do_not_unlock():
    trace=four_observed_routes()
    runtime,_,calls,_=straight_runtime([39,39,40])
    runtime.roads=trace.roads
    runtime.perception.get_object('red')['position_m']['z']=1.5
    runtime.observe()
    actions=Actions(runtime)
    tried=[]
    def fail(candidate,budget):
        tried.append(candidate['route_version'])
        return False,'synthetic_precondition_unavailable',[]
    actions._follow_approach_path=fail
    budget=[45]
    first=actions._road_reposition('red',actions.result(False,'requires_reposition'),budget)
    assert len(first['evidence']['road_reposition']['attempts'])==3
    assert len(tried)==len(set(tried))==3 and budget==[45] and calls==[]
    second=actions._road_reposition('red',actions.result(False,'requires_reposition'),budget)
    assert len(second['evidence']['road_reposition']['attempts'])==1
    assert len(tried)==len(set(tried))==4
    runtime.observe()  # A new frame without changed pose/geometry cannot reset failures.
    blocked=actions._road_reposition('red',actions.result(False,'requires_reposition'),budget)
    assert blocked['evidence']['road_reposition']['attempts']==[]
    assert blocked['evidence']['road_reposition']['status']=='same_route_without_relevant_new_evidence'
    assert len(tried)==4 and budget==[45] and calls==[]
    runtime.snapshot['road']['frontClearanceCm']+=2
    restored=actions._road_reposition('red',actions.result(False,'requires_reposition'),budget)
    assert len(restored['evidence']['road_reposition']['attempts'])==3
    assert len(tried)==7 and budget==[45] and calls==[]


def test_legacy_candidate_provider_without_new_optional_keyword_remains_callable():
    trace=four_observed_routes()
    runtime,_,_,_=straight_runtime([39,39,40])
    runtime.roads=trace.roads
    runtime.perception.get_object('red')['position_m']['z']=1.5
    original=trace.roads.approach_candidates
    def legacy(odo,target,excluded=(),limit=3,alternative_routes=()):
        return original(odo,target,excluded,limit,alternative_routes)
    trace.roads.approach_candidates=legacy
    actions=Actions(runtime)
    actions._follow_approach_path=lambda candidate,budget:(False,'synthetic_precondition_unavailable',[])
    result=actions._road_reposition('red',actions.result(False,'requires_reposition'),[45])
    assert len(result['evidence']['road_reposition']['attempts'])==3
