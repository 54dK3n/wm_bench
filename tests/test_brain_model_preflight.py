"""The separate service preflight must make at most one request and never move."""
import io
import json
import urllib.error
from unittest.mock import patch

import pytest

from tools.brain_model_preflight import perform


@pytest.mark.parametrize('status', [200, 402, 503])
def test_preflight_one_request_no_repair_retry_or_robot(tmp_path, status):
    content = json.dumps({'action': 'look_around', 'params': {}})
    body = ('data: ' + json.dumps({'model': 'deepseek-flash', 'choices': [
        {'index': 0, 'delta': {'content': content}, 'finish_reason': 'stop'}]}) + '\n\ndata: [DONE]\n\n').encode()
    def response(request, timeout):
        posted = json.loads(request.data)
        assert posted['model'] == 'deepseek-flash'
        assert posted['temperature'] == 0
        assert posted['thinking'] == {'type': 'disabled'}
        assert 'No robot is connected' in posted['messages'][0]['content']
        if status != 200:
            raise urllib.error.HTTPError(request.full_url, status, 'synthetic', {}, io.BytesIO(b'{}'))
        return io.BytesIO(body)
    with patch.dict('os.environ', {'LLM_BASE_URL': 'https://synthetic.invalid/v1',
            'LLM_API_KEY': 'synthetic-unit-test-key', 'LLM_MODEL': 'deepseek-flash',
            'LLM_TEMPERATURE': '0', 'LLM_THINKING': 'disabled'}), \
            patch('urllib.request.urlopen', side_effect=response) as call:
        result = perform(tmp_path / 'preflight')
    assert call.call_count == result['request_count'] == 1
    assert result['available'] is (status == 200)
    assert not result['robot_started'] and not result['formal_task']
    if status != 200:
        assert result['transport_error']['status'] == status
    assert 'synthetic-unit-test-key' not in (tmp_path / 'preflight' / 'RESULT.json').read_text()


def test_preflight_cannot_overwrite_old_evidence(tmp_path):
    with pytest.raises(FileExistsError):
        perform(tmp_path)
