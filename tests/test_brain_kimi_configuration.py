"""Kimi profile is explicit; delivery and model-byte evidence stay mandatory."""
import copy
from unittest.mock import patch
import pytest
from autonomous_brain.llm import LLMClient
from test_brain_stage1_source_proof import formal_proof, verdict
from test_brain_evaluation import fixture_data

@pytest.mark.parametrize('overrides', [{}, {'LLM_TEMPERATURE':'0'}, {'LLM_THINKING':'enabled'},
    {'LLM_BASE_URL':'https://example.invalid/v1'}, {'LLM_MODEL':'kimi-k3'}])
def test_live_kimi_profile_is_checked_without_rewriting_settings(tmp_path, overrides):
    env={'LLM_BASE_URL':'https://api.moonshot.cn/v1','LLM_API_KEY':'unit-test-secret',
         'LLM_MODEL':'kimi-k2.6','LLM_TEMPERATURE':'0.6','LLM_THINKING':'disabled',**overrides}
    with patch.dict('os.environ',env), patch('urllib.request.urlopen',side_effect=AssertionError('no network')):
        with LLMClient(tmp_path/'llm.jsonl') as client:
            if overrides:
                with pytest.raises(ValueError,match='Formal run requires'):client.validate_formal_configuration()
            else:
                config=client.validate_formal_configuration()
                assert config['model']=='kimi-k2.6' and config['temperature']==0.6
            assert client.call_count==0
            assert client.model==env['LLM_MODEL']

def test_kimi_frozen_profile_requires_exact_matching_runtime(formal_proof):
    for manifest in [formal_proof['source_manifest'],formal_proof['driver_summary']['sourceManifestAfterRun']]:
        manifest['modelConfiguration'].update(model='kimi-k2.6',temperature=0.6)
    formal_proof['summary']['formal_configuration'].update(model='kimi-k2.6',temperature=0.6)
    assert verdict(formal_proof)['status']=='verified'
    formal_proof['summary']['formal_configuration']['temperature']=0
    assert 'source_proof_formal_configuration_mismatch' in verdict(formal_proof)['failures']

def test_kimi_wrong_profile_is_invalid_even_when_all_records_agree(formal_proof):
    for manifest in [formal_proof['source_manifest'],formal_proof['driver_summary']['sourceManifestAfterRun']]:
        manifest['modelConfiguration'].update(model='kimi-k2.6',temperature=0)
    formal_proof['summary']['formal_configuration'].update(model='kimi-k2.6',temperature=0)
    assert verdict(formal_proof)['status']=='invalid'

def test_kimi_done_bytes_still_require_two_deliveries_and_matching_response_model():
    import hashlib,json
    from brain_evidence_fixtures import task_fixture
    from tools.evaluate_autonomous_brain import evaluate_task_scope
    summary,obs,rounds,calls,bridge,motions=task_fixture()
    call=calls[0]
    call['request'].update(model='kimi-k2.6',temperature=0.6)
    call['request_sha256']=hashlib.sha256(json.dumps(call['request'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    body=json.loads(call['response_body']);body['model']='kimi-k2.6';call['response_body']=json.dumps(body)
    summary['formal_configuration']={'model':'kimi-k2.6','temperature':0.6}
    assert evaluate_task_scope(summary,obs,rounds,calls,bridge,motions)['failures']==[]
    summary['action_evidence'].pop()
    assert 'task_completion:required_delivery_count_not_met' in evaluate_task_scope(summary,obs,rounds,calls,bridge,motions)['failures']
    body['model']='deepseek-flash';call['response_body']=json.dumps(body)
    assert 'done_not_selected_in_recorded_llm_call' in evaluate_task_scope(summary,obs,rounds,calls,bridge,motions)['failures']
