#!/usr/bin/env python3
"""Create-only public synthetic Actions/WM/independent-consumer examples.

Run from a restored source tree with --repo SOURCE --output NEW.json.
No model, simulator, capture, record, evaluation truth, or live environment input.
"""
import argparse
import ast
import copy
import hashlib
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('create-only output already exists')
    repo = args.repo.resolve()
    source_paths = ['autonomous_brain/actions.py','autonomous_brain/perception.py',
                    'tools/brain_evidence_audit.py','tests/test_brain_grab_authorization.py',
                    'tests/test_brain_pending_grasp_audit.py','tests/test_brain_route_contract.py']
    source_hashes = {name:hashlib.sha256((repo/name).read_bytes()).hexdigest() for name in source_paths}
    sys.path[:0] = [str(repo / 'vendor/wm_kit_opt2'), str(repo), str(repo / 'tests')]
    from test_brain_grab_authorization import AuthorizationRuntime, actual_grabs
    from test_brain_perception import CAMERA
    import autonomous_brain.actions as actions_module
    import autonomous_brain.perception as perception_module
    assert Path(actions_module.__file__).resolve() == repo/'autonomous_brain/actions.py'
    assert Path(perception_module.__file__).resolve() == repo/'autonomous_brain/perception.py'

    examples = []
    def save(name, runtime, expected_grabs, expected_picks, expected_deliveries):
        audit = runtime.audit()
        assert len(actual_grabs(runtime)) == expected_grabs, name
        assert sum(x['action'] == 'pick' for x in runtime.perception.action_evidence()) == expected_picks, name
        assert sum(x['action'] == 'place' for x in runtime.perception.action_evidence()) == expected_deliveries, name
        assert audit['failures'] == [], (name, audit['failures'])
        examples.append({'name':name, 'synthetic_public_input':{'fault':runtime.fault,
            'grab_results':runtime.grab_results, 'initial_confirming_forward_cm':[0,16,32],
            'camera_parameters':CAMERA, 'renderer':'AuthorizationRuntime.observe'},
            'checks':{'actual_grabs':expected_grabs, 'verified_pick_events':expected_picks,
                      'verified_delivery_events':expected_deliveries, 'audit_failures':audit['failures']},
            'observations':runtime.observations, 'motions':runtime.records,
            'bridge':runtime.bridge_records, 'rounds':runtime.rounds,
            'summary':{'runtime_version':'autonomous-brain-runtime/v18',
                       'action_evidence':runtime.perception.action_evidence(),
                       'final_objects':runtime.perception.objects(),
                       'pending_grasp':copy.deepcopy(runtime.pending_grasp),
                       'held_object_id':runtime.held_object_id}, 'audit':audit})

    r = AuthorizationRuntime(); r.become_stale(); assert not r.pick()['success']
    save('entry_stale_refusal', r, 0, 0, 0)
    for name, outcomes in [('normal_first_grab_release',(True,)),('failed_then_current_confirmed_retry_release',(False,True))]:
        r = AuthorizationRuntime(grab_results=outcomes)
        assert r.pick()['success']; assert r.execute({'action':'place','params':{}})['success']
        save(name, r, len(outcomes), 1, 1)
    for fault, grabs in [('approach_stale',0),('retry_stale',1),('competition',0)]:
        r = AuthorizationRuntime(fault=fault, grab_results=(False,True))
        assert not r.pick()['success']; save(fault, r, grabs, 0, 0)
    r = AuthorizationRuntime(fault='approach_stale')
    assert not r.pick()['success']; assert r.perception.get_object(r.object_id)['state'] == 'STALE'
    r.fault = None
    for method, params in [('turn',{'angleDeg':90,'speed':30}),('backward',{'distanceCm':16,'speed':30}),('turn',{'angleDeg':-90,'speed':30})]:
        r.actions.move(method, params)
    assert r.perception.confirmed(r.object_id); assert r.pick()['success']
    save('measured_restore_new_independent_hit_then_new_pick_decision', r, 1, 1, 0)
    for fault in ['unknown_receipt','unknown_receipt_and_sensor']:
        r = AuthorizationRuntime(fault=fault, delayed=True)
        r.round = 1
        try: r.actions.execute({'action':'pick','params':{'object_id':r.object_id}})
        except ConnectionError as error:
            r.rounds.append({'round':1,'action':{'action':'pick','params':{'object_id':r.object_id}},
                'result':{'success':False,'reason':'synthetic_grab_ack_loss',
                    'evidence':dict(error.action_evidence,final_observation=r.frame)}})
        else: raise AssertionError('expected synthetic exception')
        assert r.pending_grasp
        original_request = r.pending_grasp['grab_ref']['bridge_request_id']
        r.sensor_broken = False; r.fault = None; r.observe()
        assert not r.pick()['success']
        assert r.pending_grasp['grab_ref']['bridge_request_id'] == original_request
        result = r.execute({'action':'place','params':{}})
        reconciled = fault == 'unknown_receipt'
        assert result['success'] is reconciled
        save(fault, r, 1, int(reconciled), int(reconciled))
    source_paths = ['autonomous_brain/actions.py','autonomous_brain/perception.py',
                    'tools/brain_evidence_audit.py','tests/test_brain_grab_authorization.py',
                    'tests/test_brain_pending_grasp_audit.py','tests/test_brain_route_contract.py']
    assert source_hashes == {name:hashlib.sha256((repo/name).read_bytes()).hexdigest() for name in source_paths}
    result = {'schema':'synthetic-grab-authorization-examples/v1',
              'scope':'offline public synthetic input; not a formal simulation or task PASS',
              'repo_argument': str(repo), 'sources_unchanged_during_export': True,
              'source_sha256':source_hashes,
              'ast_sha256': {name:hashlib.sha256(ast.dump(ast.parse((repo/name).read_bytes()), include_attributes=False).encode()).hexdigest() for name in source_paths},
              'example_count':len(examples), 'examples':examples}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as stream: json.dump(result, stream, ensure_ascii=False, indent=2); stream.write('\n')
    print(json.dumps({'examples':len(examples),'audit_failures':0,'output':str(args.output)}, ensure_ascii=False))

if __name__ == '__main__': main()
