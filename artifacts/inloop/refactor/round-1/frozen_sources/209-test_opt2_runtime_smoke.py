"""Actual full worker closure catches startup errors hidden by module-level exec."""
import asyncio
import json
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
from opt2_runtime_smoke import (DEFAULT_FIXTURE, DEFAULT_WORKER, FROZEN_COUNTEREXAMPLE,
                                PublicPrefix, file_sha, run_smoke, worker_runtime)
from platform_paths import recorded_repository_path

CURRENT = ROOT / 'programs/world_model_opt2.py'


@pytest.fixture(scope='module')
def repaired():
    return run_smoke(CURRENT)


def test_frozen_full_r2_reproduces_real_startup_nameerror_without_globals_repair():
    result = run_smoke(FROZEN_COUNTEREXAMPLE)
    assert not result['all_pass']
    assert result['error_type'] == 'NameError'
    assert result['error_message'] == "name 'OPT2_MEMORY_TRAVEL_ACTIVE' is not defined"
    assert result['startup']['consumed_inputs'] == 7
    assert result['startup']['student_helper_global_keys'] == []
    assert not any(call.get('method') in ('take_exit', 'follow_road') and 'result' in call
                   for call in result['public_calls'])
    assert '__student_main__' in result['traceback']


def test_corrected_full_source_reaches_real_first_patrol_move(repaired):
    assert repaired['all_pass'], repaired
    assert repaired['startup']['scope_keys'] == ['__builtins__', '__student_main__', 'print', 'robot']
    assert repaired['startup']['consumed_inputs'] == 10
    moves = [c for c in repaired['public_calls'] if c.get('method') == 'take_exit' and 'result' in c]
    assert len(moves) == 1
    assert moves[0]['args'] == {'roadId': 'parking-connector', 'speed': 30.0, 'obeySpeedLimit': True}
    assert moves[0]['result']['accepted'] and moves[0]['result']['distanceCm'] == 25
    assert repaired['startup']['checks']['first_patrol_enter_returned']
    version = next(json.loads(line[3:]) for line in repaired['logs'] if '"event": "program_version"' in line)
    assert version['file_sha256'] == repaired['executed_source_sha256']


def test_real_nested_memory_scope_reads_100_then_restores_after_return_and_error(repaired):
    scope = repaired['memory_scope']
    assert scope['all_pass']
    assert scope['normal_result'] is False  # Deliberately absent target, no physics claim.
    assert scope['exception_type'] == 'SyntheticAPIError'
    assert [probe['speed'] for probe in scope['speed_probes']] == [100, 100, 100]
    assert (scope['before_speed'], scope['after_normal_speed'], scope['after_error_speed']) == (30, 30, 30)


def test_real_worker_printer_decodes_js_template_newline_and_wrapper_is_nested():
    backend = PublicPrefix({'inputs': []})
    output = []
    scope, _ = worker_runtime(DEFAULT_WORKER, 'answer = 2\nprint(answer)', backend, output)
    asyncio.run(scope['__student_main__']())
    assert output == ['2\n']
    assert 'answer' not in scope


def test_fixture_is_exact_public_native_prefix_without_frames_or_truth():
    fixture = json.loads(DEFAULT_FIXTURE.read_text())
    provenance = fixture['provenance']
    native_path = recorded_repository_path(provenance['native_record_path'])
    assert file_sha(native_path) == provenance['native_record_sha256']
    native = json.loads(native_path.read_text())
    for item in fixture['inputs']:
        original = native['inputs'][item['native_input_index']]
        expected = {k: original[k] for k in ('seq', 'tick', 'type', 'method', 'args', 'result') if k in original}
        assert {k: v for k, v in item.items() if k != 'native_input_index'} == expected
    assert 'visionFrames' not in fixture and 'samples' not in fixture
    assert len(fixture['inputs']) == 10


def test_wrong_request_arguments_fail_instead_of_advancing_replay(tmp_path):
    fixture = json.loads(DEFAULT_FIXTURE.read_text())
    fixture['inputs'][7]['args']['speed'] = 100
    path = tmp_path / 'mismatched.json'
    path.write_text(json.dumps(fixture))
    result = run_smoke(CURRENT, path)
    assert not result['all_pass'] and result['error_type'] == 'ReplayMismatch'
    assert result['startup']['consumed_inputs'] == 7


def test_missing_native_road_control_field_is_rejected(tmp_path):
    fixture = json.loads(DEFAULT_FIXTURE.read_text())
    del fixture['inputs'][7]['result']['elapsedTicks']
    path = tmp_path / 'invalid-result.json'
    path.write_text(json.dumps(fixture))
    result = run_smoke(CURRENT, path)
    assert not result['all_pass'] and result['error_type'] == 'ReplayMismatch'
    assert 'invalid schema' in result['error_message']


def test_silent_wrong_globals_speed_reader_is_detected_in_full_source(tmp_path):
    source = CURRENT.read_text()
    old = 'DELIVERY_LOG.get("on") or OPT2_MOTION_STATE["memory_travel_active"]'
    assert source.count(old) == 1
    source = source.replace(old, 'DELIVERY_LOG.get("on") or globals().get("OPT2_MEMORY_TRAVEL_ACTIVE", False)')
    path = tmp_path / 'bad-global-reader.py'
    path.write_text(source)
    result = run_smoke(path)
    assert all(result['startup']['checks'].values())
    assert not result['all_pass']
    assert not result['memory_scope']['checks']['speed_100_during_real_memory_wrapper']
    assert all(p['speed'] == 30 for p in result['memory_scope']['speed_probes'])
