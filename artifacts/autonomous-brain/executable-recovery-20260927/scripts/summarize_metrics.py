#!/usr/bin/env python3
"""Derive this round's metrics from completed, immutable evaluation/public logs."""
import hashlib
import json
from pathlib import Path

R = Path('artifacts/autonomous-brain/executable-recovery-20260927')
sources = {}
def read(name):
    data = (R / name).read_bytes()
    sources[name] = hashlib.sha256(data).hexdigest()
    return json.loads(data)
gate = read('GATE.json')
frozen = read('FROZEN_INPUTS.json')
public = read('raw/analysis/formal-public-diagnosis.json')
evaluation = read('raw/evaluation/formal-stage1/evaluation.json')
driver = read('raw/formal-stage1/summary.json')
old_replay = read('raw/recovery/historical-v18-replay/replay-checks.json')
component = read('raw/gate/component-frozen-candidate.json')
views = read('raw/gate/viewpoint-frozen-candidate.json')
prior = read('raw/gate/prior-scenarios-frozen-candidate.json')
assert driver['status'] == 'complete' and len(driver['trials']) == 1
assert public['input_bytes_and_stat_unchanged'] and not public['integrity_findings']
assert evaluation['source_proof']['status'] == 'verified'
assert evaluation['strict_transcript_replay']['allPass']
assert evaluation['metrics']['rounds'] == public['counts']['rounds']
assert evaluation['metrics']['observations'] == public['counts']['observations']
select = lambda obj, keys: {k:obj.get(k) for k in keys}
observed = evaluation['task_scope']['observed_evidence']
reposition = {k:v for k,v in public['repositioning'].items() if not isinstance(v, list)}
metrics = dict(schema='executable-recovery-round-metrics/v1',
    reviewed_baseline=gate['reviewed_baseline'], source_commit=frozen['source_commit'],
    historical_results_preserved={
        'd1538f7570a42b760ad518f133eaefd7bcac83a8':'stage1_PASS',
        '1117336bcb875e0700ebe6363d6154fc0409a8a0':'stage1_FAIL',
        'dec5b078d6711bdfda972ca4632c200e235dfb7e':'stage1_FAIL'},
    verification_layers=dict(function_regressions=dict(python=gate['python'],node=gate['node']),
        synthetic_component_checks=component['checks'],
        synthetic_viewpoint_cases=dict(cases=len(views['cases']),all_checks_satisfied=views['checks_satisfied']),
        synthetic_prior_cases=dict(cases=len(prior['cases']),all_checks_satisfied=prior['diagnostic_checks_satisfied']),
        native_local=gate['native_local'],
        historical_v18_transcript=select(old_replay,['allPass','recorded_rounds','recorded_calls','network_calls','environment_access_attempts']),
        formal_stage1=dict(runs=1,map='map-05',task='把两个红球送到绿色存放区',
            success=evaluation['success'], brain_status=evaluation['brain_status'],brain_reason=evaluation['brain_reason'],
            metrics=evaluation['metrics'],limits=dict(rounds=200,simulation_seconds=1200),
            deliveries=dict(required=2,
                brain_claimed=evaluation['task_scope']['completion']['delivered_count'],
                independent_record_count=len(evaluation['delivery']['delivered_target_ids']),
                observed_chain_verified=sum(d['verified'] for d in observed['deliveries']),
                observed_chain_failures=observed['failures']),
            done_actions=public['counts']['actions'].get('done',0),
            judge=evaluation['judge']['counts'],prefix_judge=evaluation['action_identity_audit']['prefix_judge']['counts'],
            evaluator_failures=evaluation['failures'],source_proof=evaluation['source_proof'],
            strict_transcript_replay={k:v for k,v in evaluation['strict_transcript_replay'].items() if k!='source_sha256'},
            driver_exit_code=1,evaluator_exit_code=1),
        stage2=dict(runs=0,status='not_run_stage1_failed'),ten_layouts_and_hardware_started=False),
    public_counts=public['counts'],public_motion=public['public_motion'],repositioning=reposition,
    confirmed_track_timeline=public['confirmed_track_timeline'],
    final_obligations=select(public['final_obligations'],['holding','held_object_id','pending_grasp',
        'object_state_counts','unresolved_discovery_record_count','unresolved_discovery_hypothesis_count']),
    stopped_after_failure=True,new_formal_run_after_failure=False,
    evidence_sources=sources)
with (R/'METRICS.json').open('x') as stream:
    json.dump(metrics,stream,ensure_ascii=False,indent=2);stream.write('\n')
print(json.dumps({'stage1':evaluation['success'],'metrics':evaluation['metrics'],
    'deliveries':metrics['verification_layers']['formal_stage1']['deliveries'],
    'complete_reposition_successes':reposition['full_reposition_success_count']},ensure_ascii=False))
