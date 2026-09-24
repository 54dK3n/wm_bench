#!/usr/bin/env python3
"""Read-only full-worker replay of saved PUBLIC results, never a simulator.

Native recordings do not contain holding() returns. Strict mode stops there;
optional public-log supplementation is reported separately, including the
initial pre-grab guard inference. Basic movement has a
normalized command but no original API request: its invertible distance/angle
fields are checked separately and this evidence distinction is reported.
"""
import argparse
import asyncio
import copy
from enum import Enum
import hashlib
import json
import math
import subprocess
from pathlib import Path
import sys
import tempfile
import traceback

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from opt2_runtime_smoke import worker_runtime
from platform_paths import file_reference, platform_root, platform_worker, recorded_repository_path


class EvidenceBoundary(BaseException):
    pass


class RequestMismatch(BaseException):
    """BaseException prevents production except Exception from hiding a mismatch."""


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def plain(value):
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [plain(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return sorted((plain(item) for item in value), key=repr)
    if value is None or type(value) in (str, float, int, bool):
        return value
    if hasattr(value, '__dict__'):
        return plain(vars(value))
    raise TypeError('unhandled snapshot type ' + type(value).__name__)


IDENTITY_FIELDS = frozenset({'version', 'file_sha256', 'wm_kit_commit', 'wm_embed_sha256'})


def normalized_event(event):
    # Only these four provenance values differ by design. Turn calibration,
    # numeric cost and log conventions remain part of the compared contract.
    return {key: value for key, value in event.items()
            if event.get('event') != 'program_version' or key not in IDENTITY_FIELDS}


def normalized_log(line):
    return normalized_event(json.loads(line[3:])) if line.startswith('GY ') else line


def wm_state(local):
    wm = local.get('wm')
    if wm is None:
        return None
    return plain({key: getattr(wm, key) for key in
                  ('_objects', '_lost', '_hit_poses', 'pose', 'last_update_time',
                   'assoc_cfg', 'decay_cfg', 'fov_cfg')})


def requests(method, args):
    if method == 'follow_road':
        return dict(zip(('maxCm', 'speed', 'obeySpeedLimit'), args))
    if method == 'take_exit':
        return dict(zip(('roadId', 'speed', 'obeySpeedLimit'), args))
    return list(args) if args else None


def public_inputs(record):
    """Explicitly discard startState, geometry, samples and target truth."""
    allowed = {'seq', 't', 'tick', 'type', 'method', 'args', 'result', 'command',
               'intent', 'reason', 'source', 'frameId', 'evidenceId'}
    return [dict(native_input_index=i, **{k: copy.deepcopy(v) for k, v in row.items() if k in allowed})
            for i, row in enumerate(record['inputs'])]


class NativePublicReplay:
    def __init__(self, inputs, original_logs=None, supplement_holding=False):
        self.inputs, self.cursor = inputs, 0
        self.original_logs = original_logs or []
        self.log_cursor = 0
        self.supplement_holding = supplement_holding
        self.pending_interaction = None
        self.holding_evidence = None
        self.original_log_differences = []
        self.coroutine = None
        self.calls, self.snapshots, self.logs = [], [], []
        self.boundary = None

    def local(self):
        if self.coroutine is not None and self.coroutine.cr_frame is not None:
            return self.coroutine.cr_frame.f_locals
        return {}

    def emit(self, text):
        self.logs.append(text)
        if text.startswith('GY '):
            event = json.loads(text[3:])
            if self.original_logs:
                if self.log_cursor >= len(self.original_logs):
                    self.fail('extra_program_log', 'print', [], event)
                original = self.original_logs[self.log_cursor]
                if event.get('event') != original.get('event'):
                    self.fail('program_log_event_order_mismatch', 'print', [], original)
                if normalized_event(event) != normalized_event(original):
                    self.original_log_differences.append({'raw_line_index': self.log_cursor,
                                                         'original': original, 'replayed': event})
                self.log_cursor += 1
            if event.get('event') in {'observe', 'wm_update', 'wm_action_removed', 'memory_confirmed',
                                       'wm_empty_frame_update', 'wm_targets', 'wm_associations', 'last_observe',
                                       'target_search_abandoned', 'ball_confirmed', 'ball_end', 'flow_end'}:
                self.snapshots.append({'log_index': len(self.logs) - 1, 'event': event,
                                       'next_native_input_index': self.cursor,
                                       'wm': wm_state(self.local())})

    def fail(self, reason, method, args, expected=None):
        self.boundary = {'reason': reason, 'method': method, 'args': requests(method, args),
                         'native_input_index': self.cursor, 'expected': expected}
        raise RequestMismatch(json.dumps(self.boundary, ensure_ascii=False))

    def control(self, method, args, expected):
        """Compare recorded normalized angle or commanded displacement, no physics.

        unitsPerMeter=8 is the platform's PUBLIC adapter conversion in app.js.
        Only recorded duration/speed request fields are used, never startState.
        """
        command = expected.get('command', {})
        direction = 1 if method in {'forward', 'left_angle'} else -1
        if method in {'left_angle', 'right_angle'}:
            valid = (command.get('kind') == 'turn_angle' and command.get('direction') == direction
                     and command.get('angleDegrees') == args[0])
            return valid, {'basis': 'normalized turn command angleDegrees/direction exact',
                           'recorded_angle_degrees': command.get('angleDegrees')}
        if method in {'forward', 'backward'}:
            # Multiplication order follows driveDistancePlan and command normalization.
            # Use a one-to-one expected speed, avoiding an inverse-roundoff comparison.
            world_distance = args[0] * 8 / 100
            ticks = max(1, math.ceil(world_distance / (1.25 * 20 / 1000)))
            duration_ms = ticks * 20
            speed = world_distance / (duration_ms / 1000)
            valid = (command.get('kind') == 'drive' and command.get('direction') == direction
                     and command.get('durationMs') == duration_ms
                     and command.get('durationTicks') == ticks
                     and command.get('speed') == speed)
            return valid, {'basis': 'app.js driveDistancePlan forward mapping, exact duration/ticks/speed',
                           'expected_duration_ms': duration_ms, 'expected_ticks': ticks,
                           'expected_speed': speed, 'recorded_speed': command.get('speed')}
        return False, {'basis': 'unsupported control method'}

    def holding_reply(self):
        if self.pending_interaction:
            operation = self.pending_interaction
            events = ({'grab_step', 'grab_lateral_recovery_step'} if operation == 'grab'
                      else {'ball_delivered', 'ball_release_unverified'})
            field = 'holding' if operation == 'grab' else 'holding_after'
            match = next(((i, row) for i, row in enumerate(self.original_logs[self.log_cursor:], self.log_cursor)
                          if row.get('event') in events and field in row), None)
            if match is None:
                self.boundary = {'reason': 'interaction_holding_not_in_public_logs',
                                 'operation': operation, 'native_input_index': self.cursor}
                raise EvidenceBoundary()
            index, row = match
            self.holding_evidence = {'result': row[field], 'basis': 'explicit original public holding log',
                                     'raw_line_index': index, 'event': row['event'], 'field': field,
                                     'tick': row.get('tick', row.get('tick_after_grab'))}
            self.pending_interaction = None
        elif self.holding_evidence is None:
            # The pre-grab guard is unlogged. Its None result follows from the
            # saved request reaching the subsequent grab, not from scene truth.
            upcoming = self.inputs[self.cursor:self.cursor + 2]
            if (len(upcoming) == 2 and upcoming[0]['type'] == 'control'
                    and upcoming[0].get('command', {}).get('kind') == 'wait'
                    and upcoming[1]['type'] == 'package_grab'):
                self.holding_evidence = {'result': None,
                    'basis': 'control-flow inference: saved execution passed before_holding guard and reached first grab',
                    'native_package_grab_index': self.cursor + 1,
                    'limitation': 'not a directly recorded holding return'}
            else:
                match = next(((i, row) for i, row in enumerate(self.original_logs[self.log_cursor:], self.log_cursor)
                              if row.get('event') in {'flow_end', 'grab_loop_failed'} and 'holding' in row), None)
                if match is None:
                    self.boundary = {'reason': 'no_public_holding_provenance', 'native_input_index': self.cursor}
                    raise EvidenceBoundary()
                index, row = match
                self.holding_evidence = {'result': row['holding'], 'basis': 'explicit original public holding log',
                                        'raw_line_index': index, 'event': row['event'], 'field': 'holding',
                                        'tick': row.get('tick')}
        evidence = copy.deepcopy(self.holding_evidence)
        self.calls.append({'method': 'holding', 'args': None, 'native_input_index': self.cursor,
                           'return_basis': 'PUBLIC_LOG_SUPPLEMENT_NOT_NATIVE_INPUT',
                           'provenance': evidence, 'result': evidence['result'],
                           'unchanged_between_interactions': True})
        return json.dumps(evidence['result'], ensure_ascii=False)

    def interaction(self, method, args):
        start = self.cursor
        if args:
            self.fail('interaction_args_not_empty', method, args)
        # The platform's public API wraps a wait animation, an interaction
        # intent and a completion animation. There is no student-visible result.
        before = self.inputs[self.cursor]
        required_ms = 480 if method == 'grab' else 260
        if (before['type'] != 'control' or before.get('command', {}).get('kind') != 'wait'
                or before['command'].get('durationMs') != required_ms):
            self.fail('interaction_initial_animation_mismatch', method, args, before)
        self.cursor += 1
        intent = self.inputs[self.cursor]
        if intent['type'] != 'package_' + method or intent.get('intent') != {}:
            self.fail('interaction_intent_mismatch', method, args, intent)
        self.cursor += 1
        animations = []
        while self.cursor < len(self.inputs):
            row = self.inputs[self.cursor]
            if row['type'] != 'control' or row.get('command', {}).get('kind') != 'wait':
                break
            if row['command'].get('durationMs') not in (280, 420):
                self.fail('unexpected_interaction_completion_animation', method, args, row)
            animations.append(row['command'])
            self.cursor += 1
        if not animations:
            self.fail('interaction_missing_completion_animation', method, args)
        self.pending_interaction = method
        self.calls.append({'method': method, 'args': None, 'native_input_index': start,
                           'seq': before.get('seq'), 'tick': before.get('tick'),
                           'native_input_indices': list(range(start, self.cursor)),
                           'request_validation': 'exact empty package intent and native animation command envelope',
                           'return_basis': 'unmodified worker interaction methods return None'})
        return None

    def __getattr__(self, method):
        async def call(*args):
            if method == 'holding' and self.supplement_holding:
                return self.holding_reply()
            if method in {'grab', 'release'} and self.supplement_holding:
                return self.interaction(method, args)
            if method == 'holding':
                self.boundary = {'reason': 'holding_return_not_recorded_in_native_inputs',
                                 'method': method, 'native_input_index': self.cursor,
                                 'last_consumed_seq': self.inputs[self.cursor - 1].get('seq') if self.cursor else None}
                raise EvidenceBoundary()
            if self.cursor >= len(self.inputs) or self.inputs[self.cursor]['type'] == 'run_end':
                self.boundary = {'reason': 'no_recorded_response_for_next_request', 'method': method,
                                 'args': requests(method, args), 'native_input_index': self.cursor}
                raise EvidenceBoundary()
            start = self.cursor
            expected = self.inputs[start]
            entry = {'method': method, 'args': requests(method, args), 'native_input_index': start,
                     'seq': expected.get('seq'), 'tick': expected.get('tick')}
            if method in {'forward', 'backward', 'left_angle', 'right_angle'}:
                if expected['type'] != 'control':
                    self.fail('expected_record_type_is_not_control', method, args, expected)
                valid, validation = self.control(method, args, expected)
                if not valid:
                    self.fail('normalized_control_mismatch', method, args,
                              dict(expected, validation=validation))
                entry['request_validation'] = validation
                entry['recorded_command'] = expected['command']
                entry['return_basis'] = 'unmodified worker motion methods return None'
                self.cursor += 1
                self.calls.append(entry)
                return None
            if method == 'approach':
                # Native approach wraps its internal vision/motion operations. The
                # student receives only the final approach boolean. Do not expose
                # internal target geometry as an extra sensor input.
                while self.cursor < len(self.inputs):
                    item = self.inputs[self.cursor]
                    if item['type'] == 'vision_query' and item.get('method') == 'approach':
                        break
                    if not ((item['type'] == 'vision_query' and item.get('method') == 'approach_step')
                            or item['type'] == 'control'):
                        self.fail('unrecognized_approach_child_record', method, args, item)
                    if item['type'] == 'vision_query' and item.get('args', [])[:2] != list(args[:2]):
                        self.fail('approach_child_target_or_distance_mismatch', method, args, item)
                    self.cursor += 1
                if self.cursor >= len(self.inputs):
                    self.fail('approach_has_no_final_result', method, args)
                expected = self.inputs[self.cursor]
                entry['nested_native_input_indices'] = list(range(start, self.cursor))
                entry['result_native_input_index'] = self.cursor
            if (expected.get('method') != method or expected.get('args') != requests(method, args)
                    or 'result' not in expected):
                self.fail('public_request_or_argument_mismatch', method, args, expected)
            entry['request_validation'] = 'exact saved public method/args'
            entry['result'] = copy.deepcopy(expected['result'])
            entry['result_sha256'] = hashlib.sha256(json.dumps(entry['result'], sort_keys=True,
                                                        ensure_ascii=False).encode()).hexdigest()
            self.cursor += 1
            self.calls.append(entry)
            return json.dumps(entry['result'], ensure_ascii=False)
        return call


async def execute(program, inputs, worker, original_logs=None, supplement_holding=False):
    source = program.read_text().strip()
    backend = NativePublicReplay(copy.deepcopy(inputs), original_logs, supplement_holding)
    saved_modules = {name: module for name, module in sys.modules.items()
                     if name == 'world_model' or name.startswith('world_model.')}
    saved_path = list(sys.path)
    for name in saved_modules:
        del sys.modules[name]
    main = sys.modules['__main__']
    had_source, old_source = hasattr(main, 'student_source'), getattr(main, 'student_source', None)
    main.student_source = source
    old_prefix, old_bytecode = sys.pycache_prefix, sys.dont_write_bytecode
    result = {'program': file_reference(program), 'program_sha256': sha(program)}
    try:
        with tempfile.TemporaryDirectory(prefix='wm-replay-cache-') as cache:
            # The real worker has an isolated filesystem; prevent a host .pyc
            # left by the other program from supplying a different embedded WM.
            sys.pycache_prefix, sys.dont_write_bytecode = cache, True
            scope, _runtime = worker_runtime(worker, source, backend, backend)
            backend.coroutine = scope['__student_main__']()
            try:
                await backend.coroutine
                status = 'program_returned'
            except EvidenceBoundary:
                status = 'missing_recorded_public_return'
            except RequestMismatch:
                status = 'request_mismatch'
            except Exception as error:
                status = 'program_error'
                result['error'] = {'type': type(error).__name__, 'message': str(error),
                                   'traceback': traceback.format_exc()}
            result.update(status=status, consumed_native_inputs=backend.cursor,
                          next_native_input=inputs[backend.cursor] if backend.cursor < len(inputs) else None,
                          boundary=backend.boundary, calls=backend.calls, logs=backend.logs,
                          wm_snapshots=backend.snapshots, final_wm=wm_state(backend.local()),
                          original_log_differences=backend.original_log_differences,
                          original_log_events_consumed=backend.log_cursor,
                          holding_supplement_count=sum(c['method'] == 'holding' for c in backend.calls))
    finally:
        if backend.coroutine:
            backend.coroutine.close()
        for name in list(sys.modules):
            if name == 'world_model' or name.startswith('world_model.'):
                del sys.modules[name]
        sys.modules.update(saved_modules)
        sys.path[:] = saved_path
        sys.pycache_prefix, sys.dont_write_bytecode = old_prefix, old_bytecode
        if had_source:
            main.student_source = old_source
        else:
            del main.student_source
    return result


# worker_runtime expects an output object with append, as a Python list does.
NativePublicReplay.append = NativePublicReplay.emit


def first_difference(left, right):
    for index, (a, b) in enumerate(zip(left, right)):
        if a != b:
            return {'index': index, 'baseline': a, 'candidate': b}
    if len(left) != len(right):
        return {'index': min(len(left), len(right)), 'baseline_length': len(left), 'candidate_length': len(right)}
    return None


PYODIDE_RUNNER = r"""
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const payload = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const pyroot = path.join(payload.platform, 'vendor/pyodide');
  const {loadPyodide} = require(path.join(pyroot, 'pyodide.js'));
  const py = await loadPyodide({indexURL: pyroot + path.sep,
                               stdLibURL: path.join(pyroot, 'python_stdlib.zip')});
  py.FS.mkdirTree('/workspace/tools');
  py.FS.mkdirTree('/platform');
  for (const [name, source] of Object.entries(payload.modules)) {
    py.FS.writeFile('/workspace/tools/' + name, source);
  }
  py.FS.writeFile('/platform/python-worker.js', payload.worker);
  for (const [name, source] of Object.entries(payload.programs)) {
    py.FS.writeFile('/workspace/' + name + '.py', source);
  }
  py.globals.set('public_replay_payload', JSON.stringify(payload.fixture));
  py.globals.set('public_replay_program_names', JSON.stringify(Object.keys(payload.programs)));
  const result = await py.runPythonAsync(`
import os, sys, json
from pathlib import Path
os.environ['GUANGYANG_PLATFORM_ROOT'] = '/platform'
sys.path.insert(0, '/workspace/tools')
import refactor_public_replay as replay
fixture = json.loads(public_replay_payload)
results = {}
for name in json.loads(public_replay_program_names):
    results[name] = await replay.execute(Path('/workspace/' + name + '.py'),
        fixture['inputs'], Path('/platform/python-worker.js'), fixture['logs'], fixture['supplement_holding'])
json.dumps({'results': results, 'python_version': sys.version}, ensure_ascii=False)
`);
  fs.writeFileSync(process.argv[2], result);
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
"""


def pyodide_execute(programs, inputs, logs, worker, supplement_holding):
    payload = {'platform': str(platform_root()), 'worker': worker.read_text(),
               'modules': {name: (HERE / name).read_text() for name in
                           ('refactor_public_replay.py', 'opt2_runtime_smoke.py', 'platform_paths.py')},
               'programs': programs,
               'fixture': {'inputs': inputs, 'logs': logs, 'supplement_holding': supplement_holding}}
    with tempfile.TemporaryDirectory(prefix='public-worker-replay-') as folder:
        request, response = Path(folder) / 'public.json', Path(folder) / 'result.json'
        request.write_text(json.dumps(payload, ensure_ascii=False))
        process = subprocess.run(['node', '-e', PYODIDE_RUNNER, str(request), str(response)],
                                 capture_output=True, text=True, timeout=120)
        if process.returncode:
            raise RuntimeError(process.stderr or process.stdout)
        return json.loads(response.read_text())


def run(raw_path, baseline, candidate, worker, supplement_holding=False, engine="pyodide"):
    raw = json.loads(raw_path.read_text())
    record_path = recorded_repository_path(raw['fullRecordFile'])
    record = json.loads(record_path.read_text())
    inputs = public_inputs(record)
    if record.get('sourceCode') != baseline.read_text().strip():
        raise ValueError('baseline program does not match the native record sourceCode exactly')
    # Only public request/result fields are passed to the runtime; no events,
    # samples, startState pose, renderTruth or package geometry is accessed.
    if engine == 'pyodide':
        runtime = pyodide_execute({'baseline': baseline.read_text(), 'candidate': candidate.read_text()},
                                 inputs, raw['lines'], worker, supplement_holding)
        results = runtime['results']
        python_version = runtime['python_version']
        for name, program in [('baseline', baseline), ('candidate', candidate)]:
            results[name]['program'] = file_reference(program)
    else:
        results = {name: asyncio.run(execute(program, inputs, worker, raw['lines'], supplement_holding))
                   for name, program in [('baseline', baseline), ('candidate', candidate)]}
        python_version = sys.version
    old, new = results['baseline'], results['candidate']
    log_normalize = lambda logs: [normalized_log(line) for line in logs]
    differences = {'calls': first_difference(old['calls'], new['calls']),
                   'wm_snapshots': first_difference(old['wm_snapshots'], new['wm_snapshots']),
                   'nonidentity_logs': first_difference(log_normalize(old['logs']), log_normalize(new['logs']))}
    return {'schema': 'refactor-public-record-replay/v1',
            'source_raw': file_reference(raw_path), 'record': file_reference(record_path),
            'dependencies': {file_reference(p): sha(p) for p in
                             (raw_path, record_path, baseline, candidate, worker, Path(__file__),
                              HERE / 'opt2_runtime_smoke.py', HERE / 'platform_paths.py', platform_root() / 'app.js',
                              platform_root() / 'vendor/pyodide/pyodide.js',
                              platform_root() / 'vendor/pyodide/pyodide.asm.js',
                              platform_root() / 'vendor/pyodide/pyodide.asm.wasm',
                              platform_root() / 'vendor/pyodide/python_stdlib.zip')},
            'native_inputs': len(inputs), 'baseline_matches_record_source_code': True,
            'supplement_holding': supplement_holding, 'engine': engine,
            'python_version': python_version, 'allowed_identity_fields': sorted(IDENTITY_FIELDS), 'results': results,
            'comparison': {'same_supported_prefix': all(value is None for value in differences.values())
                           and old['status'] == new['status'] and old['boundary'] == new['boundary'],
                           'full_public_trace_verified': not supplement_holding and old['status'] == new['status'] == 'program_returned',
                           'complete_with_public_log_supplement': supplement_holding and old['status'] == new['status'] == 'program_returned'
                             and old['consumed_native_inputs'] == new['consumed_native_inputs'] == len(inputs) - 1,
                           'original_public_logs_exact_except_identity': {name: not value['original_log_differences']
                              and value['original_log_events_consumed'] == len(raw['lines'])
                              for name, value in results.items()},
                           'differences': differences},
            'limitations': ['Native recording has no holding() return; supplementation is marked per call, including initial pre-grab guard inference, without target/package truth.',
                            'Basic movement stores normalized control, not original public method/args; checked against that representation.',
                            'Uses native worker transformation/wrapper. Engine is recorded; Pyodide mode uses the local WASM runtime but does not reproduce live JS request scheduling.',
                            'No simulator, controller, renderer, detector, task truth, or candidate physical trajectory is run.',
                            'This diagnostic cannot turn the failed C native-equivalence batch into a pass.']}


def self_checks(raw_path, baseline, candidate, worker):
    raw = json.loads(raw_path.read_text())
    record = json.loads(recorded_repository_path(raw['fullRecordFile']).read_text())
    source = candidate.read_text()
    motion = 'motion_take_exit(road_id, _opt2_travel_speed(), True)'
    update = '        wm.update(detections, pose, now=timestamp)'
    assert source.count(motion) == source.count(update) == 1
    mutated_motion = source.replace(motion, 'motion_take_exit(road_id, 31, True)')
    mutated_wm = source.replace(update, update + '\n        for _audit_obj in wm.get_scene():\n            _audit_obj.x += 0.01')
    # Mutations exist only in in-memory negative fixtures, never production files.
    output = pyodide_execute({'baseline': baseline.read_text(), 'motion_mutant': mutated_motion,
                              'wm_mutant': mutated_wm}, public_inputs(record), raw['lines'], worker, True)
    result = output['results']
    motion_failure = result['motion_mutant']['boundary']
    state_difference = first_difference(result['baseline']['wm_snapshots'], result['wm_mutant']['wm_snapshots'])
    strict = pyodide_execute({'baseline': baseline.read_text()}, public_inputs(record),
                             raw['lines'], worker, False)['results']['baseline']
    identity = dict(raw['lines'][0])
    changed_k = dict(identity, turn_cost_k=identity['turn_cost_k'] + 1)
    changed_identity = dict(identity, version='negative-identity', file_sha256='negative-hash',
                            wm_kit_commit='negative-commit', wm_embed_sha256='negative-zip')
    checks = {'baseline_completes': result['baseline']['status'] == 'program_returned',
              'wrong_motion_speed_rejected_at_first_take_exit':
                  result['motion_mutant']['status'] == 'request_mismatch'
                  and motion_failure['native_input_index'] == 7
                  and motion_failure['method'] == 'take_exit'
                  and motion_failure['args']['speed'] == 31,
              'altered_world_model_state_detected': state_difference is not None,
              'changed_program_version_turn_cost_k_detected': normalized_event(identity) != normalized_event(changed_k),
              'only_four_identity_fields_ignored': normalized_event(identity) == normalized_event(changed_identity),
              'holding_native_return_absence_not_reclassified_as_recorded':
                  strict['status'] == 'missing_recorded_public_return'
                  and strict['boundary']['reason'] == 'holding_return_not_recorded_in_native_inputs'
                  and strict['holding_supplement_count'] == 0}
    return {'all_pass': all(checks.values()), 'checks': checks, 'engine': 'pyodide',
            'python_version': output['python_version'], 'motion_mismatch': motion_failure,
            'strict_missing_evidence_boundary': strict['boundary'],
            'first_wm_snapshot_difference': state_difference,
            'mutation_provenance': {'motion': 'replace in-memory first live take_exit speed with31',
                                    'wm': 'in-memory add0.01m to track x immediately after fusion'},
            'production_files_modified': False, 'simulator_started': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--all-maps', action='store_true')
    parser.add_argument('--self-check', action='store_true')
    parser.add_argument('--engine', choices=['pyodide', 'cpython'], default='pyodide')
    parser.add_argument('--supplement-holding', action='store_true', help='use explicit public logs, with separate inference provenance; never claims native complete coverage')
    parser.add_argument('--raw', type=Path, default=ROOT / 'artifacts/inloop/opt-2/round-3/map-05.json')
    parser.add_argument('--baseline', type=Path, default=ROOT / 'artifacts/inloop/opt-2/round-3/program.py')
    parser.add_argument('--candidate', type=Path, default=ROOT / 'artifacts/inloop/refactor/round-1/program.py')
    parser.add_argument('--out', type=Path, default=ROOT / 'artifacts/inloop/refactor/round-1/replay-map-05.json')
    args = parser.parse_args()
    if args.self_check:
        result = self_checks(args.raw, args.baseline, args.candidate, platform_worker())
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'output': file_reference(args.out), 'checks': result['checks'], 'all_pass': result['all_pass']}))
        return
    paths = ([args.raw.parent / ('map-%02d.json' % i) for i in range(1, 11)]
             if args.all_maps else [args.raw])
    summaries = []
    for raw_path in paths:
        result = run(raw_path, args.baseline, args.candidate, platform_worker(), args.supplement_holding, args.engine)
        out = (args.out.parent / ('replay-' + raw_path.stem + '-' + args.engine + '.json')
               if args.all_maps else args.out)
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        summary = {'map': raw_path.stem, 'output': file_reference(out), 'comparison': result['comparison'],
                   'runs': {key: {'status': value['status'], 'consumed': value['consumed_native_inputs'],
                                  'calls': len(value['calls']), 'holding_supplements': value['holding_supplement_count'],
                                  'gy_events': value['original_log_events_consumed'],
                                  'boundary': value['boundary'], 'wm_snapshots': len(value['wm_snapshots'])}
                            for key, value in result['results'].items()}}
        summaries.append(summary)
        print(json.dumps(summary, ensure_ascii=False), flush=True)
    if args.all_maps:
        totals = {key: sum(item['runs']['baseline'][key] for item in summaries)
                  for key in ('calls', 'wm_snapshots', 'holding_supplements', 'consumed', 'gy_events')}
        aggregate = {'maps': len(summaries), 'totals_per_program': totals,
                     'tool_sha256': sha(Path(__file__)), 'allowed_identity_fields': sorted(IDENTITY_FIELDS),
                     'holding_scope': 'All holding returns are supplemented with attached public-log provenance; initial pre-grab None is a labeled control-flow inference.',
                     'inference': 'Same saved public inputs yield identical requests, WM snapshots and original public logs. This does not establish live perception or JS scheduling equivalence or identify the source of the native input differences.'}
        args.out.write_text(json.dumps({'engine': args.engine, 'runs': summaries, 'aggregate': aggregate,
                         'native_C_verdict_unchanged': 'FAIL', 'simulation_run': False},
                         ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
