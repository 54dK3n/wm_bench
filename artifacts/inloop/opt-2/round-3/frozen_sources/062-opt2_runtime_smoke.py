#!/usr/bin/env python3
"""Full platform-wrapped source startup against a saved public API prefix.

No student helper or variable is installed in the student's global scope. The
actual Robot validator and transformation/wrapper statements come from the
platform worker. The backend returns immutable saved public results; no browser,
controller, visual model or simulator is started. Later scope checks explicitly
use static public replies and captured real nested functions, not a task replay.
"""
import argparse
import ast
import asyncio
import copy
import hashlib
import json
import math
from pathlib import Path
import sys
import traceback
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORKER = Path('/Users/ken/Desktop/robot_competition-main/projects/car-python/python-worker.js')
DEFAULT_FIXTURE = ROOT / 'tools/fixtures/opt2_runtime_public_prefix.json'
FROZEN_COUNTEREXAMPLE = ROOT / 'artifacts/inloop/opt-2/round-2/program.py'
PUBLIC_TYPES = {'navigation_query', 'navigation_control', 'vision_query'}


class PrefixComplete(BaseException):
    """Planned read-only stop before the first API beyond the saved prefix."""


class ReplayMismatch(AssertionError):
    pass


class SyntheticAPIError(RuntimeError):
    pass


def file_sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _arguments(method, args):
    if method == 'take_exit':
        return dict(zip(('roadId', 'speed', 'obeySpeedLimit'), args))
    if method == 'follow_road':
        return dict(zip(('maxCm', 'speed', 'obeySpeedLimit'), args))
    return list(args) if args else None


def _assert_control_schema(result):
    if (not isinstance(result, dict) or type(result.get('accepted')) is not bool
            or not isinstance(result.get('stoppedBy'), str)
            or not isinstance(result.get('roadId'), str)
            or type(result.get('distanceCm')) not in (int, float)
            or type(result.get('elapsedTicks')) not in (int, float)):
        raise ReplayMismatch('saved public road-control result has an invalid schema')


class PublicPrefix:
    """A strict JSON transport used by the unmodified worker Robot class."""
    def __init__(self, fixture):
        self.inputs = fixture['inputs']
        self.cursor = 0
        self.calls = []
        self.outer = {}
        self.coroutine = None
        self.mode = 'native_prefix'
        self.static_replies = {}
        self.speed_probes = []
        self.fail_method = None

    def __getattr__(self, method):
        async def call(*args):
            if self.coroutine is not None and self.coroutine.cr_frame is not None:
                self.outer = dict(self.coroutine.cr_frame.f_locals)
            requested = {'method': method, 'args': _arguments(method, args)}
            if self.mode == 'synthetic_scope':
                if method not in ('odometry', 'road_state'):
                    raise ReplayMismatch('scope fixture attempted an unplanned API: ' + method)
                # Read the real student's closure-aware speed function; no helper
                # is replaced and no global variable is introduced.
                speed = await self.outer['_opt2_travel_speed']()
                self.speed_probes.append({'method': method, 'speed': speed})
                self.calls.append(dict(mode=self.mode, **requested))
                if method == self.fail_method:
                    raise SyntheticAPIError('explicit synthetic ' + method + ' failure')
                return json.dumps(copy.deepcopy(self.static_replies[method]))
            if self.cursor >= len(self.inputs):
                self.calls.append(dict(mode=self.mode, stopped_before_reply=True, **requested))
                raise PrefixComplete()
            expected = self.inputs[self.cursor]
            if expected['method'] != method or expected.get('args') != requested['args']:
                raise ReplayMismatch('public prefix mismatch at input ' + str(self.cursor) + ': expected '
                                     + repr((expected['method'], expected.get('args'))) + ', got ' + repr(requested))
            result = copy.deepcopy(expected['result'])
            if method in ('follow_road', 'take_exit'):
                _assert_control_schema(result)
            self.calls.append(dict(mode=self.mode, fixture_index=self.cursor,
                                   native_input_index=expected.get('native_input_index'),
                                   seq=expected.get('seq'), tick=expected.get('tick'), result=result, **requested))
            self.cursor += 1
            if method in ('odometry', 'road_state'):
                self.static_replies[method] = result
            return json.dumps(result)
        return call


def _runtime_template(worker):
    """Decode the worker's literal JS template before compiling its Python."""
    text = Path(worker).read_text()
    start = text.index('  const runtime = `') + len('  const runtime = `')
    raw = text[start:text.index('`;\n  try {', start)]
    if '${' in raw:
        raise ValueError('runtime template interpolation needs explicit review')
    output, index = [], 0
    while index < len(raw):
        if raw[index] != chr(92):
            output.append(raw[index])
            index += 1
        elif raw[index + 1] == chr(92):
            output.append(chr(92))
            index += 2
        elif raw[index + 1] == 'u':
            output.append(chr(int(raw[index + 2:index + 6], 16)))
            index += 6
        else:
            raise ValueError('unreviewed JS runtime template escape at ' + str(index))
    return ''.join(output)


def worker_runtime(worker, source, backend, output):
    """Execute the real sim-mode wrapper, including the enclosing async def."""
    text = _runtime_template(worker)
    robot_code = text[text.index('class Robot:'):text.index('class AsyncRobotTransformer(')]
    transform_code = text[text.index('class AsyncRobotTransformer('):text.index("student_run_target = globals().get(")]
    wrapper_code = text[text.index('function_names = {node.name for node in tree.body'):text.index("await scope['__student_main__']()")]
    runtime = {'ast': ast, 'json': json, 'math': math, 'js_robot': backend,
               'student_source': source, 'student_run_target': 'sim',
               'emit_output': output.append}
    exec(robot_code, runtime)
    exec(transform_code, runtime)
    runtime['tree'] = ast.parse(source, filename='<student_source>', mode='exec')
    exec(wrapper_code, runtime)
    scope = runtime['scope']
    # exec adds builtins and exactly the platform's single enclosing function.
    if set(scope) != {'robot', 'print', '__builtins__', '__student_main__'}:
        raise AssertionError('unexpected student-global injection: ' + repr(set(scope)))
    return scope, runtime


async def _scope_checks(backend):
    """Exercise actual nested wrappers without replacing functions or cells."""
    local = backend.outer
    backend.mode = 'synthetic_scope'
    before = await local['_opt2_travel_speed']()
    await local['_nav_invalidate']()
    # This absent target deliberately reaches the real graph function's normal
    # target-lost return after public pose reads. It does not claim navigation.
    normal = await local['_opt2_memory_navigation'](SimpleNamespace(obj_id='synthetic-absent-track'))
    after_normal = await local['_opt2_travel_speed']()
    await local['_nav_invalidate']()
    backend.fail_method = 'odometry'
    exception_type = None
    try:
        await local['_opt2_memory_navigation'](SimpleNamespace(obj_id='synthetic-absent-track'))
    except SyntheticAPIError as exc:
        exception_type = type(exc).__name__
    after_error = await local['_opt2_travel_speed']()
    probes = list(backend.speed_probes)
    checks = {'default_speed_is_30': before == 30,
              'real_graph_normal_target_lost_return': normal is False,
              'speed_100_during_real_memory_wrapper': bool(probes) and all(p['speed'] == 100 for p in probes),
              'normal_return_restores_30': after_normal == 30,
              'synthetic_API_exception_propagates': exception_type == 'SyntheticAPIError',
              'exception_restores_30': after_error == 30}
    return {'mode': 'explicit synthetic static public replies, real nested functions and shared closure',
            'checks': checks, 'all_pass': all(checks.values()), 'speed_probes': probes,
            'before_speed': before, 'after_normal_speed': after_normal, 'after_error_speed': after_error,
            'normal_result': normal, 'exception_type': exception_type}


async def run_smoke_async(program, fixture=DEFAULT_FIXTURE, worker=DEFAULT_WORKER, check_scopes=True):
    program, fixture, worker = Path(program), Path(fixture), Path(worker)
    raw_source = program.read_text()
    source = raw_source.strip()  # Platform editor/run boundary uses trim().
    payload = json.loads(fixture.read_text())
    backend = PublicPrefix(payload)
    logs, runtime_scope = [], None
    result = {'schema': 'opt2-full-worker-runtime-smoke/v1', 'all_pass': False,
              'program': str(program.resolve()), 'program_raw_sha256': file_sha(program),
              'executed_source_sha256': hashlib.sha256(source.encode()).hexdigest(),
              'dependencies': {str(p.resolve()): file_sha(p) for p in (program, fixture, worker, Path(__file__))},
              'fixture_provenance': payload.get('provenance'),
              'limitations': ['No simulator, controller, renderer, detector or browser runs.',
                  'Native prefix checks API order/arguments/results only, not changed-program physical equivalence.',
                  'Memory scope uses static public replies and the real graph target-lost return; it does not test target capture or delivery.',
                  'CPython executes the worker Python semantics; Pyodide/JS transport scheduling is not exercised.']}
    modules = {k: v for k, v in sys.modules.items() if k == 'world_model' or k.startswith('world_model.')}
    saved_path = list(sys.path)
    for key in modules:
        del sys.modules[key]
    # Runtime input metadata is provided by the worker before the student's
    # separate scope is created. It is not a student variable/helper injection.
    main = sys.modules['__main__']
    had_source = hasattr(main, 'student_source')
    previous_source = getattr(main, 'student_source', None)
    main.student_source = source
    startup_status = 'not_started'
    try:
        runtime_scope, _runtime = worker_runtime(worker, source, backend, logs)
        backend.coroutine = runtime_scope['__student_main__']()
        try:
            await backend.coroutine
            startup_status = 'program_returned'
        except PrefixComplete:
            startup_status = 'prefix_completed'
        except Exception as exc:
            startup_status = 'error'
            result['error_type'] = type(exc).__name__
            result['error_message'] = str(exc)
            result['traceback'] = traceback.format_exc()
        result['startup'] = {'status': startup_status, 'consumed_inputs': backend.cursor,
                             'prefix_inputs': len(backend.inputs), 'scope_keys': sorted(runtime_scope),
                             'student_helper_global_keys': [k for k in runtime_scope if k.startswith('OPT2_')]}
        controls = [c for c in backend.calls if c.get('method') in ('take_exit', 'follow_road') and 'result' in c]
        parsed = []
        for text in logs:
            if text.startswith('GY '):
                parsed.append(json.loads(text[3:]))
        startup_checks = {'whole_prefix_consumed': backend.cursor == len(backend.inputs),
                          'stopped_only_after_public_prefix': startup_status == 'prefix_completed',
                          'accepted_first_legal_move': bool(controls) and controls[0]['result']['accepted']
                              and controls[0]['result']['distanceCm'] > 0,
                          'first_patrol_enter_returned': any(e.get('event') == 'viewpoint_take_exit' and
                              float(e.get('distanceCm') or 0) > 0 for e in parsed),
                          'no_student_globals_injected': not result['startup']['student_helper_global_keys']}
        result['startup']['checks'] = startup_checks
        if all(startup_checks.values()) and check_scopes:
            try:
                result['memory_scope'] = await _scope_checks(backend)
            except Exception as exc:
                result['memory_scope'] = {'all_pass': False, 'error_type': type(exc).__name__,
                                          'error_message': str(exc), 'traceback': traceback.format_exc()}
        result['all_pass'] = all(startup_checks.values()) and (not check_scopes or result.get('memory_scope', {}).get('all_pass', False))
        result['failures'] = [name for name, passed in startup_checks.items() if not passed]
        if check_scopes and not result.get('memory_scope', {}).get('all_pass', False):
            result['failures'].append('memory_scope_not_verified')
    except Exception as exc:
        result.update(error_type=type(exc).__name__, error_message=str(exc), traceback=traceback.format_exc(), failures=['runtime_setup_error'])
    finally:
        if backend.coroutine is not None:
            backend.coroutine.close()
        for key in list(sys.modules):
            if key == 'world_model' or key.startswith('world_model.'):
                del sys.modules[key]
        sys.modules.update(modules)
        sys.path[:] = saved_path
        if had_source:
            main.student_source = previous_source
        else:
            del main.student_source
    result['public_calls'] = backend.calls
    result['logs'] = logs
    return result


def run_smoke(program, fixture=DEFAULT_FIXTURE, worker=DEFAULT_WORKER, check_scopes=True):
    return asyncio.run(run_smoke_async(program, fixture, worker, check_scopes))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--program', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--fixture', type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument('--worker', type=Path, default=DEFAULT_WORKER)
    args = parser.parse_args()
    result = run_smoke(args.program, args.fixture, args.worker)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'all_pass': result['all_pass'], 'failures': result.get('failures', []), 'output': str(args.out)}, ensure_ascii=False))
    raise SystemExit(0 if result['all_pass'] else 1)


if __name__ == '__main__':
    main()
