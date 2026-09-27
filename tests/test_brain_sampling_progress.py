"""Actual public perception supplies progress; frame churn never unlocks a retry."""
import copy
import json
from unittest.mock import patch

import pytest

from autonomous_brain import llm
from test_brain_recovery_discovery import runtime, publish
from test_brain_perception import ball


def source_id(r):
    return r.perception.discovery_evidence()['records'][0]['hypothesis_id']


def failed(r, before=None, reason='confirmation_no_safe_independent_viewpoint'):
    return r.perception.record_sampling_attempt(source_id(r), before or copy.deepcopy(r.snapshot),
        {'success':False,'reason':reason,'evidence':{'confirmation_sampling':{
            'schema':'brain-confirmation-sampling/v1','steps':[],
            'initial_hit_count':1,'final_hit_count':1,'travelled_cm':0}}},r.snapshot)


def test_current_unique_candidate_is_separate_from_invisible_obligation():
    r=runtime();publish(r,95)
    first=source_id(r)
    summary=r.state()['discovery']
    assert summary['executable_candidate_count']==1
    assert summary['executable_candidates'][0]['id']==first
    before=copy.deepcopy(r.perception.discovery_evidence())
    publish(r)
    summary=r.state()['discovery']
    assert summary['pending_count']==1 and summary['candidate_count']==1
    assert summary['executable_candidates']==[]
    assert summary['pending'][0]['sampling_executable'] is False
    assert before['records']==r.perception.discovery_evidence()['records']


def test_failed_context_blocks_new_frame_and_same_pose_pixel_jitter():
    r=runtime();publish(r,80);failed(r)
    for reading in (80,80,80.1,80):
        publish(r,reading)
        current=r.perception.sampling_readiness(source_id(r))
        assert current['executable'] is False
        assert current['reason']=='sampling_retry_without_relevant_new_evidence'
    row=r.state()['discovery']['pending'][0]
    assert row['sampling_progress']['attempt_count']==1
    assert row['sampling_progress']['last_effective_view']['observation_index']==1
    assert row['sampling_progress']['retry_blocked'] is True


def test_new_independent_actual_hit_unlocks_retry_without_forgetting_old_failure():
    r=runtime();publish(r,80);failed(r)
    publish(r,64,forward=16)
    ready=r.perception.sampling_readiness(source_id(r))
    assert ready['executable'] is True
    assert ready['progress']['new_evidence_reason']=='new_accepted_hit'
    assert ready['progress']['attempt_count']==1
    assert ready['progress']['last_failure']['reason']=='confirmation_no_safe_independent_viewpoint'
    assert ready['progress']['last_effective_view']['observation_index']==2


def test_alias_source_of_same_explicit_track_cannot_bypass_failure():
    r=runtime();publish(r,80);failed(r);publish(r,80)
    latest=r.perception.discovery_evidence()['records'][-1]['id']
    assert latest!=source_id(r)
    assert r.perception.sampling_readiness(latest)['executable'] is False
    assert r.perception.sampling_readiness(latest)['progress']['attempt_count']==1


def test_invisible_after_failure_never_unlocks_on_motion_or_road_context_alone():
    r=runtime();publish(r,80);before=copy.deepcopy(r.snapshot)
    publish(r,forward=16);failed(r,before,reason='confirmation_needs_fresh_observation')
    publish(r,forward=40)
    ready=r.perception.sampling_readiness(source_id(r))
    assert ready['executable'] is False
    assert ready['reason']=='needs_fresh_observation'
    assert ready['progress']['last_effective_view']['frame_id']=='1'


def test_unique_reacquisition_at_new_tick_unlocks_after_missing_frame():
    r=runtime();publish(r,80);before=copy.deepcopy(r.snapshot)
    publish(r);failed(r,before,reason='confirmation_needs_fresh_observation')
    publish(r,80)
    ready=r.perception.sampling_readiness(source_id(r))
    assert ready['executable'] is True
    assert ready['progress']['new_evidence_reason']=='fresh_unique_visibility_reacquired'
    assert ready['progress']['independent_hits_added']==0


def test_same_tick_reacquisition_and_context_jitter_cannot_unlock():
    r=runtime();publish(r,80);before=copy.deepcopy(r.snapshot)
    publish(r);failed(r,before,reason='confirmation_needs_fresh_observation')
    publish(r,80)
    context=copy.deepcopy(r.snapshot)
    context['odometry']['tick']=2
    context['observation']['tick']=2
    context['road']['tick']=2
    ready=r.perception.sampling_readiness(source_id(r),context)
    assert ready['executable'] is False


def test_summary_progress_is_bounded_copy_and_full_attempts_retained_separately():
    r=runtime();publish(r,95)
    for _ in range(7):
        failed(r)
    summary=r.state()['discovery'];progress=summary['pending'][0]['sampling_progress']
    assert progress['attempt_count']==7 and len(progress['recent_attempts'])<=3
    assert 'before_context' not in progress['recent_attempts'][0]
    progress['last_failure']['reason']='tampered'
    assert r.perception.sampling_progress_evidence()['records'][0]['attempts'][-1]['reason']!='tampered'


def test_unknown_outcome_does_not_become_sampling_success_or_clear_obligation():
    r=runtime();publish(r,95)
    before=copy.deepcopy(r.snapshot)
    r.perception.record_sampling_attempt(source_id(r),before,
        {'success':False,'reason':'ConnectionError','evidence':{'outcome_unknown':True}},r.snapshot)
    ready=r.perception.sampling_readiness(source_id(r))
    assert ready['executable'] is False
    assert ready['progress']['last_failure']['outcome_unknown'] is True
    assert r.perception.discovery_evidence()['unresolved']


def test_v19_only_executable_candidates_and_v18_keeps_literal_pending_contract():
    state={'objects':[],'discovery':{'pending':[{'id':'old','sampling_allowed':False}],
        'executable_candidates':[{'id':'live','sampling_executable':True}]}}
    old={'action':'explore','params':{'discovery_id':'old'}}
    current={'action':'explore','params':{'discovery_id':'live'}}
    assert llm.VERSION=='autonomous-brain-llm/v19'
    assert llm.validate_action(old,state,transcript_version='autonomous-brain-llm/v18')==old
    with pytest.raises(llm.ActionValidationError):llm.validate_action(old,state)
    assert llm.validate_action(current,state)==current
    with pytest.raises(llm.ActionValidationError):
        llm.validate_action(old,{'objects':[],'discovery':{'pending':[{'id':'old'}]}})


def test_v18_literal_sampling_choice_replays_without_current_executable_requirement(tmp_path):
    from test_brain_llm import records
    from test_brain_llm_finish import canonical,literal_row
    state={'task':'把两个红球送到绿色存放区','objects':[],'robot':{},'junction_history':[],
        'recent_actions':[],'discovery':{'pending':[{'id':'old','sampling_allowed':False}]}}
    action={'action':'explore','params':{'discovery_id':'old'}}
    body=canonical({'model':'served-model','choices':[{'message':{'content':canonical(action)},'finish_reason':'stop'}]})
    row=literal_row(state,18,body,stream=False);row.update(raw_output=canonical(action),action=action)
    source=tmp_path/'v18.jsonl';source.write_text(canonical(row)+'\n')
    with patch('autonomous_brain.llm.os.environ.get',side_effect=AssertionError('environment forbidden')), \
            patch('urllib.request.urlopen',side_effect=AssertionError('network forbidden')):
        with llm.LLMClient(tmp_path/'replayed.jsonl',replay_path=source) as client:
            assert client.decide(state)==action
            client.assert_replay_consumed()
    assert records(tmp_path/'replayed.jsonl')==[dict(row,mode='replay')]


def test_real_execute_blocks_repeat_sampler_until_actual_independent_view():
    from test_brain_confirmation_sampling import sampling_runtime, sample, discovery_id
    from autonomous_brain.confirmation_sampling import sample_discovery
    r=sampling_runtime(mode='stationary');selected=discovery_id(r)
    with patch('autonomous_brain.confirmation_sampling.sample_discovery',wraps=sample_discovery) as sampler:
        first=sample(r,selected)
        assert not first['success']
        assert sampler.call_count==1
        original_calls=copy.deepcopy(r.bridge.calls)
        for advance_tick in (False,True):
            if advance_tick:r.bridge.tick+=1
            r.observe()
            state=r.state()['discovery']
            assert state['executable_candidates']==[]
            assert state['pending'][0]['sampling_progress']['retry_blocked']
            repeated=sample(r,selected)
            assert repeated['reason']=='sampling_retry_without_relevant_new_evidence'
            assert sampler.call_count==1
            assert r.bridge.calls==original_calls
        # Real public motion/frames, not an injected CONFIRMED label, unlocks.
        r.bridge.mode=None
        r.actions.move('forward',{'distanceCm':16,'speed':30})
        ready=r.perception.sampling_readiness(selected)
        assert ready['executable'] and ready['progress']['new_evidence_reason']=='new_accepted_hit'
        assert r.state()['discovery']['executable_candidate_count']==1
        result=sample(r,selected)
        assert result['success'],result
        assert sampler.call_count==2
        attempts=r.perception.sampling_progress_evidence()['records'][0]['attempts']
        assert len(attempts)==4 and attempts[-1]['success']
        assert attempts[-1]['independent_hits_added']==1
        assert attempts[-1]['after_observation']==r.snapshot['observation_index']
        assert attempts[-1]['actual_travelled_cm']>0
        assert all(a['after_observation']>a['before_observation'] for a in attempts)


def test_changed_road_constraints_unlock_only_with_fresh_unique_visibility():
    r=runtime();publish(r,80);failed(r)
    publish(r,80)
    snapshot=copy.deepcopy(r.snapshot)
    snapshot['road']['frontClearanceCm']=80
    ready=r.perception.sampling_readiness(source_id(r),snapshot)
    assert ready['executable']
    assert ready['progress']['new_evidence_reason']=='changed_observed_road_constraint'
    publish(r)
    snapshot=copy.deepcopy(r.snapshot);snapshot['road']['frontClearanceCm']=80
    assert not r.perception.sampling_readiness(source_id(r),snapshot)['executable']


def test_real_restored_view_without_progress_does_not_unlock_next_action():
    from test_brain_sampling_viewpoint_comparison import comparison_runtime,obscure_first_new_view
    from test_brain_confirmation_sampling import sample,discovery_id
    r=obscure_first_new_view(comparison_runtime(75,-20,road_heading=20,at_node=True),only_after_turn=True)
    selected=discovery_id(r)
    first=sample(r,selected)
    assert not first['success']
    recovery=first['evidence']['confirmation_sampling']['recovery_attempt']
    assert recovery['success'] and recovery['observed_pose_restored']
    calls=copy.deepcopy(r.bridge.calls)
    assert len(calls)==2 and all(method=='turn' for method,_ in calls)
    assert r.perception.objects()[0]['hit_count']==1
    assert r.state()['discovery']['executable_candidates']==[]
    for _ in range(2):
        r.bridge.tick+=1
        r.observe()
        repeated=sample(r,selected)
        assert not repeated['success']
        assert repeated['reason']=='sampling_retry_without_relevant_new_evidence'
        assert r.bridge.calls==calls
        assert r.perception.objects()[0]['hit_count']==1
