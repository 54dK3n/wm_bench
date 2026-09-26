"""Synthetic configuration failures traverse real LLM/run log consumers offline."""
import io
import json
import traceback
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from autonomous_brain import llm, run

MARKER = 'endpoint-sensitive-synthetic-marker'
KEY = 'synthetic-key-not-a-real-credential'


def configure(monkeypatch, endpoint):
    for key, value in {'LLM_BASE_URL': endpoint, 'LLM_API_KEY': KEY,
        'LLM_MODEL': 'deepseek-flash', 'LLM_TEMPERATURE': '0',
        'LLM_THINKING': 'disabled'}.items():
        monkeypatch.setenv(key, value)


@pytest.mark.parametrize('endpoint', [MARKER, 'file:///' + MARKER,
    'ftp://' + MARKER + '.invalid', 'https://' + MARKER + '@example.invalid/v1',
    'https://example.invalid/v1?token=' + MARKER, 'https://example.invalid/#' + MARKER,
    'https://example.invalid:' + MARKER, 'https://[' + MARKER,
    ' https://example.invalid/' + MARKER, 'https://example.invalid/\n' + MARKER,
    'https:///missing-host/' + MARKER])
def test_invalid_endpoint_rejected_before_runtime_and_never_echoed(tmp_path, monkeypatch, capsys, endpoint):
    configure(monkeypatch, endpoint)
    monkeypatch.setattr(run, 'read_config', lambda: {'task':'把两个红球送到绿色存放区'})
    runtime = Mock(side_effect=AssertionError('robot forbidden'))
    monkeypatch.setattr(run, 'Runtime', runtime)
    with patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')) as network:
        assert run.main(['--out',str(tmp_path/'run')]) == 1
    runtime.assert_not_called()
    network.assert_not_called()
    summary = json.loads((tmp_path/'run/summary.json').read_text())
    assert 'invalid_configuration:LLM_BASE_URL' in summary['reason']
    assert summary['rounds'] == summary['llm_calls'] == summary['observations'] == 0
    assert (tmp_path/'run/rounds.jsonl').read_text() == ''
    outputs = ''.join(p.read_text() for p in (tmp_path/'run').glob('*.json*'))
    captured = capsys.readouterr()
    assert MARKER not in outputs + captured.out + captured.err
    assert KEY not in outputs + captured.out + captured.err
    with pytest.raises(ValueError) as caught:
        llm.LLMClient(tmp_path/'direct.jsonl')
    error = caught.value
    assert error.__cause__ is None and error.__context__ is None
    assert MARKER not in ''.join(traceback.format_exception(type(error),error,error.__traceback__))


class FakeRuntime:
    def __init__(self, config, out):
        self.round = self.observation_count = 0
        self.held_object_id = self.pending_grasp = None
        self.bridge = SimpleNamespace(seconds=0,max_seconds=1200,log=Mock())
        self.observation_log, self.motion_log = Mock(), Mock()
        self.perception = SimpleNamespace(objects=lambda:[],timeline=lambda:[],action_evidence=lambda:[])
        self.roads = SimpleNamespace(summary=lambda:[])
        self.actions = SimpleNamespace(grab_attempts={}, execute=Mock(side_effect=AssertionError('action forbidden')))
    def observe(self):
        self.observation_count += 1
    def state(self):
        return {'task':'把两个红球送到绿色存放区','objects':[],'robot':{},'junction_history':[],'recent_actions':[]}


@pytest.mark.parametrize('raised', [ValueError, TypeError, RuntimeError])
def test_request_construction_failure_closes_lifecycle_and_safe_round_logs(tmp_path, monkeypatch, capsys, raised):
    configure(monkeypatch, 'https://example.invalid/v1')
    monkeypatch.setattr(run,'read_config',lambda:{'task':'把两个红球送到绿色存放区','max_rounds':1})
    monkeypatch.setattr(run,'Runtime',FakeRuntime)
    monkeypatch.setattr(run,'capture_world_model_provenance',lambda root:{'fixture':True})
    with patch('urllib.request.Request',side_effect=raised(MARKER + KEY)), \
            patch('urllib.request.urlopen',side_effect=AssertionError('network forbidden')) as network:
        assert run.main(['--out',str(tmp_path/'run')]) == 1
    network.assert_not_called()
    rows = [json.loads(l) for l in (tmp_path/'run/llm.jsonl').read_text().splitlines()]
    events = [json.loads(l) for l in (tmp_path/'run/llm.lifecycle.jsonl').read_text().splitlines()]
    assert len(rows) == 1
    assert rows[0]['transport_error'] == {'type':'RequestConstructionError'}
    assert rows[0]['transport_diagnostics']['phase'] == 'construct_request'
    assert [e['event'] for e in events] == ['started','finished']
    outputs = ''.join(p.read_text() for p in (tmp_path/'run').glob('*.json*'))
    captured=capsys.readouterr()
    assert MARKER not in outputs+captured.out+captured.err and KEY not in outputs+captured.out+captured.err
    # Exercise the live propagated exception as well as serialized consumers.
    with patch('urllib.request.Request',side_effect=raised(MARKER + KEY)), \
            patch('urllib.request.urlopen',side_effect=AssertionError('network forbidden')):
        with llm.LLMClient(tmp_path/'live-error.jsonl') as client:
            with pytest.raises(llm.LLMRequestError) as live_error:
                client.decide(FakeRuntime.state(None))
        error=live_error.value
        assert error.__cause__ is None and error.__context__ is None
        rendered=''.join(traceback.format_exception(type(error),error,error.__traceback__))
        assert MARKER not in rendered and KEY not in rendered
    with llm.LLMClient(tmp_path/'replay.jsonl',replay_path=tmp_path/'run/llm.jsonl') as client:
        with pytest.raises(llm.LLMRequestError) as caught:
            client.decide(FakeRuntime.state(None))
        assert caught.value.__cause__ is None and caught.value.__context__ is None
        client.assert_replay_consumed()


def test_valid_configuration_keeps_exact_successful_request_and_response_replay(tmp_path, monkeypatch):
    configure(monkeypatch,'https://example.invalid/v1')
    body=json.dumps({'model':'deepseek-flash','choices':[{'message':{'content':'{"action":"look_around","params":{}}'},'finish_reason':'stop'}]}).encode()
    state=FakeRuntime.state(None)
    with patch('urllib.request.urlopen',return_value=io.BytesIO(body)) as network:
        with llm.LLMClient(tmp_path/'live.jsonl',stream=False) as client:
            assert client.validate_formal_configuration()['formal_run']
            assert client.decide(state)['action']=='look_around'
    assert network.call_count==1
    original=json.loads((tmp_path/'live.jsonl').read_text())
    with patch('urllib.request.urlopen',side_effect=AssertionError('replay network')), \
            patch('autonomous_brain.llm.os.environ.get',side_effect=AssertionError('replay configuration')):
        with llm.LLMClient(tmp_path/'replay.jsonl',replay_path=tmp_path/'live.jsonl') as client:
            assert client.decide(state)['action']=='look_around'
            client.assert_replay_consumed()
    replay=json.loads((tmp_path/'replay.jsonl').read_text())
    assert {k:v for k,v in original.items() if k!='mode'}=={k:v for k,v in replay.items() if k!='mode'}
