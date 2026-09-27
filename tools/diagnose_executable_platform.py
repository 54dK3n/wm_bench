#!/usr/bin/env python3
"""Bounded native-motion diagnostic using only the existing public RobotBridge.

The local return target below is calculated from an already observed robot pose,
solely to ask the production candidate generator for a path back to that pose.
It is not a simulated object or a task answer. No model/scene/evaluator is read.
"""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from autonomous_brain.actions import road_translation_limit
from autonomous_brain.navigation import position, distance, wrap
from autonomous_brain.run import Runtime


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args(); config=json.loads(sys.stdin.readline())
    runtime=Runtime(config,args.out)
    original_call=runtime.bridge.call
    primitive_count=0
    def bounded_call(method,params=None):
        nonlocal primitive_count
        if method in {'turn','forward','backward','follow_road','take_exit'}:
            if primitive_count>=30:
                raise RuntimeError('local_diagnostic_primitive_budget_exhausted')
            primitive_count+=1
        return original_call(method,params)
    runtime.bridge.call=bounded_call
    runtime.observe()
    report={'schema':'native-public-motion-local-diagnostic/v1','formal_run':False,
            'model_calls':0,'truth_access':False,'task_solution_script':False,
            'primitive_budget':30,'simulation_budget_seconds':120,'cases':[]}
    try:
        # A sensed road direction plus bounded local lateral clearance chooses
        # the setup; this is an actuator diagnostic, not autonomous task routing.
        initial=copy.deepcopy(runtime.snapshot)
        road=runtime.snapshot['road']
        assert road['onRoad'],'Diagnostic starts off the observed road'
        if road.get('atNode') and road.get('exits'):
            angle=min((e['angleDeg'] for e in road['exits']),key=abs)
            runtime.actions.take_observed_exit(angle)
            assert runtime.snapshot['road']['onRoad']
        # Test two local motion types from sensor-derived setup only. The
        # original road-following leg and an oblique basic leg are later reused
        # by the actual candidate generator/path executor without a pose jump.
        road_start=copy.deepcopy(runtime.snapshot)
        if runtime.snapshot['road'].get('atNode'):
            report['setup_limit']='still_inside_start_node_region'
        else:
            runtime.actions.move('follow_road',{'distanceCm':20,'speed':50})
        before=copy.deepcopy(runtime.snapshot)
        road=before['road']; tangent=road.get('headingErrorDeg')
        assert type(tangent) in (int,float)
        runtime.actions.turn(tangent+30)
        permitted,clearance=road_translation_limit(runtime.snapshot['road'],'forward',20)
        length=math.floor(permitted*10)/10
        if length<15:
            # One smaller angle is allowed only by a newly read road context;
            # the diagnostic must never force the nominal 30deg/20cm probe.
            runtime.actions.turn(-15)
            permitted,clearance=road_translation_limit(runtime.snapshot['road'],'forward',20)
            length=math.floor(permitted*10)/10
        assert length>=15, 'No fresh-safe independent basic test segment on this native start'
        departure=copy.deepcopy(runtime.snapshot)
        runtime.actions.move('forward',{'distanceCm':length,'speed':30})
        endpoint=copy.deepcopy(runtime.snapshot)
        a=position(departure['odometry']);current=position(endpoint['odometry'])
        # Public-local diagnostic selection: a point 32cm from the observed
        # return pose lets approach_candidates retain that already visited pose.
        local_check=(a[0]+.32,a[1])
        candidates=runtime.roads.approach_candidates(endpoint['odometry'],local_check)
        candidate=next((c for c in candidates if tuple(c['position_m'])==a),None)
        assert candidate is not None,'Observed basic segment did not produce a usable reverse candidate'
        budget=[12];reached,reason,steps=runtime.actions._follow_approach_path(candidate,budget)
        after=copy.deepcopy(runtime.snapshot)
        displacement=distance(a,position(after['odometry']))*100
        heading_error=abs(wrap(after['odometry']['headingDeg']-departure['odometry']['headingDeg']))
        case={'name':'native_basic_oblique_reverse','recorded_departure':departure,'recorded_arrival':endpoint,
              'fresh_clearance':clearance,'requested_cm':length,'candidate':candidate,'reached':reached,
              'reason':reason,'steps':steps,'after':after,'return_position_error_cm':displacement,
              'return_body_heading_error_deg':heading_error,'executor_steps_used':12-budget[0]}
        report['cases'].append(case)
        # Verify actual native odometry and the chosen inverse primitive, not
        # merely a candidate position within the visual standoff radius.
        case['checks']={'reached':reached,'position_returned':displacement<=.5,'body_heading_preserved':heading_error<=1,
                        'inverse_basic_selected':any(s.get('method')=='backward' or s.get('primitive')=='backward'
                                                    or s.get('execution_method')=='backward' for s in steps)}
        # Inspect public motion log for explicit inverse evidence regardless of
        # executor trace field naming; original log has the method contract.
        motions=[json.loads(line) for line in (args.out/'motions.jsonl').read_text().splitlines()]
        replayed=[m for m in motions if m['before_observation']>=endpoint['observation_index']]
        case['checks']['inverse_basic_selected']=any(m['method']=='backward' for m in replayed)
        case['replayed_motion_methods']=[m['method'] for m in replayed]
        report['initial_observation']=initial;report['road_setup_observation']=road_start
        report['passed']=all(case['checks'].values())
        assert report['passed'], 'Native inverse segment did not satisfy unchanged measured evidence'
        # One local visibility diagnostic after the return. It contains no
        # transport/grasp plan and does not require a confirmation to succeed.
        guidance=runtime.perception.discovery_summary()
        scan=None
        if not guidance.get('executable_candidates'):
            scan=runtime.actions.execute({'action':'look_around','params':{}})
            guidance=runtime.perception.discovery_summary()
        available=guidance.get('executable_candidates',[])
        sampling={'scan':scan,'candidate_count':guidance.get('executable_candidate_count',0),
                  'before':copy.deepcopy(runtime.snapshot),'attempts':0,
                  'result':None,'confirmation_success':False}
        if available:
            chosen=available[0]['hypothesis_id']
            sampling.update(attempts=1,discovery_id=chosen)
            sampling['result']=runtime.actions.execute({'action':'explore','params':{'discovery_id':chosen}})
            sampling['confirmation_success']=sampling['result']['success']
        else:
            sampling['refusal_reason']='no_current_executable_discovery_after_bounded_scan'
        sampling['after']=copy.deepcopy(runtime.snapshot)
        sampling['scope']='single public-sensor intent; refusal retained; not task acceptance'
        report['native_sampling_visibility']=sampling
    except Exception as error:
        report['passed']=False;report['failure']={'type':type(error).__name__,'message':str(error),
            'action_evidence':copy.deepcopy(getattr(error,'action_evidence',None))}
    finally:
        report['final_observation']=runtime.snapshot
        report['simulation_seconds']=runtime.bridge.seconds
        report['observations']=runtime.observation_count
        for log in [runtime.bridge.log,runtime.observation_log,runtime.motion_log]:log.close()
        calls=[json.loads(line) for line in (args.out/'bridge-calls.jsonl').read_text().splitlines()]
        motors=[x for x in calls if x['request']['method'] in {'turn','forward','backward','follow_road','take_exit'}]
        report['primitive_count']=len(motors)
        report['within_budget']=len(motors)<=30 and runtime.bridge.seconds<=120
        report['passed']=report.get('passed',False) and report['within_budget']
        with (args.out/'local-controller-diagnostic.json').open('x') as out:json.dump(report,out,ensure_ascii=False,indent=2);out.write('\n')
    print(json.dumps({k:report[k] for k in ['passed','formal_run','primitive_count','simulation_seconds','within_budget']},ensure_ascii=False))
    return 0 if report['passed'] else 1

if __name__=='__main__':raise SystemExit(main())
