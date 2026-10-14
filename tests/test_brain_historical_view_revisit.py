"""A40 navigation-only historical viewing poses; no old identity is restored.

Original public road history and camera window are replayed without truth.
Perception starts at 681, so its local IDs are not claims about original118.
Future actuator readings below are explicitly synthetic component inputs.
"""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import RoadMemory, position, wrap
from autonomous_brain.perception import Perception
from autonomous_brain.run import compact_action_result
from test_brain_grab_authorization import actual_grabs
from test_brain_pick_pixel_recovery import ClippedRetryRuntime, commands
from test_brain_route_contract import normalize

FIXTURE = Path(__file__).parent / 'fixtures/run_20261013T105016_historical_view_public.json'


def public_runtime(endpoint=859, *, source_fault=None):
    f = json.loads(FIXTURE.read_text())
    rows = {r['observation_index']: r for r in f['road_prefix'] + f['observations']}
    incoming = {m['after_observation']: m for m in f['motions']}
    outgoing = {m['before_observation']: m for m in f['motions']}
    p, roads = Perception(f['camera_parameters']), RoadMemory()
    calls, motions = [], []
    r = SimpleNamespace(snapshot={}, round=155, perception=p, roads=roads,
        held_object_id=None, pending_grasp=None, bridge=SimpleNamespace(seconds=0, max_seconds=1200),
        motion_log=SimpleNamespace(write=motions.append))
    r.actions = Actions(r)
    for index, original in rows.items():
        if index > endpoint:
            break
        row = copy.deepcopy(original)
        motion = copy.deepcopy(incoming.get(index))
        if motion:
            motion.pop('motion_verification', None)
            motion.pop('passage_failure', None)
        if index >= 681:
            row['perception'] = p.update(row['observation'], row['odometry'],
                simulation_time_s=row['simulation_seconds'], round_index=row['round'], observation_index=index)
            row['objects'] = p.objects()
        roads.update(row['odometry'], row['road'], index)
        roads.observe_traversal(row, motion)
        roads._refresh_passage_evidence(row)
        if incoming.get(index, {}).get('passage_failure'):
            roads.remember_passage_failure(rows[motion['before_observation']], row, motion)
        for binding in f['passage_route_bindings']:
            if binding['observation_index'] == index:
                roads.bind_blocked_route(binding['passage_id'], binding['segment'])
        nxt = outgoing.get(index)
        if nxt and nxt['method'] == 'take_exit':
            roads.chosen(row['odometry'], nxt['params']['angleDeg'], observation_index=index)
        r.snapshot = row
        if index >= 681:
            r.round = row['round']
            r.bridge.seconds = row['simulation_seconds']
            # One nominated source for source-binding negative tests. The
            # full positive replay notes every observation, like Runtime.
            if source_fault is None:
                r.actions.note_historical_view(row, motion)
            elif index == 821:
                changed = copy.deepcopy(row)
                red = next(d for d in changed['perception']['detections'] if d['category'] == 'red-ball')
                if source_fault == 'wrong-id':
                    red['track_id'] = 'unobserved-other-id'
                elif source_fault == 'unknown':
                    red['pixel_quality']['status'] = 'unknown'
                elif source_fault == 'clip':
                    red['bbox']['y'] = 480 - red['bbox']['h']
                elif source_fault == 'missing-quality':
                    del red['pixel_quality']
                elif source_fault == 'old-frame':
                    changed['observation']['frameId'] = 'not-the-source'
                r.actions.note_historical_view(changed, motion)
    r.object_id = next(o['id'] for o in p.objects() if o['category'] == 'red-ball' and o['ever_confirmed'])
    r.public_rows, r.calls, r.motions = rows, calls, motions
    return r, f


def synthetic_runtime(*, source_fault=None, source_heading=0):
    r = ClippedRetryRuntime(clip_gap=100)
    r.roads = RoadMemory()
    original = r.observe
    def observe(*, motion=None):
        original(motion=motion)
        r.roads.update(r.snapshot['odometry'], r.snapshot['road'], r.snapshot['observation_index'])
        finalized = dict(motion, after_observation=r.snapshot['observation_index']) if motion else None
        r.roads.observe_traversal(r.snapshot, finalized)
        r.actions.note_historical_view(r.snapshot, finalized)
        return r.snapshot
    r.observe = observe
    # A real current confirmation precedes the later ordinary WM expiry.
    r.observe()
    if source_heading:
        r.actions.move('turn', {'angleDeg': source_heading, 'speed': 30})
    source = copy.deepcopy(r.snapshot)
    if source_fault:
        # This fixture intentionally drops all usable cache sources, then
        # presents exactly the malformed candidate being tested.
        r.actions = Actions(r)
        changed = copy.deepcopy(source)
        if source_fault == 'wrong-id':
            changed['perception']['detections'][0]['track_id'] = 'other-object'
        elif source_fault == 'unknown':
            changed['perception']['detections'][0]['pixel_quality']['status'] = 'unknown'
        elif source_fault == 'clip':
            box = changed['perception']['detections'][0]['bbox']
            box['y'] = 480 - box['h']
        elif source_fault == 'missing-quality':
            del changed['perception']['detections'][0]['pixel_quality']
        elif source_fault == 'old-frame':
            changed['observation']['frameId'] = 'wrong-frame'
        r.actions.note_historical_view(changed)
    r.override_items = []
    if source_heading:
        r.actions.move('turn', {'angleDeg': -source_heading, 'speed': 30})
    r.actions.move('backward', {'distanceCm': 20, 'speed': 30})
    r.bridge.seconds += 60
    r.observe()
    assert r.perception.get_object(r.object_id)['state'] == 'LOST'
    r.command_start = len(r.bridge_records)
    return r, source


def test_original_public_sources_and_exact_graph_routes_remain_navigation_only():
    for endpoint in (840, 859):
        r, _ = public_runtime(endpoint)
        obj = r.perception.get_object(r.object_id)
        assert obj['state'] == 'LOST' and obj['ever_confirmed']
        assert [p['frame_id'] for p in obj['hit_poses']] == ['681', '684', '687', '698']
        cap = r.actions.historical_view_revisit(r.object_id)
        assert cap['available'] and cap['navigation_only'] and cap['requires_fresh_identity'], cap
        assert cap['source_observation'] in (814, 821)
        source = r.public_rows[cap['source_observation']]
        assert cap['position_m'] == list(position(source['odometry']))
        route = r.roads.route_to(r.snapshot['odometry'], tuple(cap['position_m']))
        assert route[-1] == tuple(cap['position_m']) and len(route) > 1
        assert not r.actions.current_pick_ready(r.object_id)
        assert not r.actions.navigation_readiness(r.object_id)['operation_ready']
        assert not r.perception._grab_authorizations
        # Dispatch through real Actions and the unchanged parameter contract.
        # The first future actuator acknowledgement is deliberately unknown;
        # no invented future curved-road reading claims arrival.
        def call(method, params):
            r.calls.append((method, normalize(method, params)))
            raise ConnectionError('synthetic_public_route_ack_unknown')
        def observe(*, motion=None):
            row = copy.deepcopy(r.snapshot)
            row['observation_index'] += 1
            row['simulation_seconds'] += .02
            tick = row['odometry']['tick'] + 1
            row['odometry']['tick'] = row['road']['tick'] = tick
            row['observation'] = {'frameId': 'synthetic-future-' + str(row['observation_index']),
                'tick': tick, 'width': 640, 'height': 480, 'detections': []}
            row['perception'] = r.perception.update(row['observation'], row['odometry'],
                simulation_time_s=row['simulation_seconds'], round_index=row['round'],
                observation_index=row['observation_index'])
            row['objects'] = r.perception.objects()
            r.snapshot = row
            r.roads.update(row['odometry'], row['road'], row['observation_index'])
            r.roads.observe_traversal(row, motion)
            r.actions.note_historical_view(row, motion)
        r.bridge.call, r.observe = call, observe
        with pytest.raises(ConnectionError, match='synthetic_public_route_ack_unknown'):
            r.actions.execute({'action': 'go_to', 'params': {'object_id': r.object_id}})
        assert len(r.calls) == 1
        assert r.calls[0][0] in {'turn', 'follow_road', 'forward', 'backward'}
        assert r.motions[-1]['outcome_unknown']
        assert r.perception.get_object(r.object_id)['state'] == 'LOST'
        assert not r.perception._grab_authorizations


def test_actual_revisit_executes_known_route_without_restoring_old_identity_or_probe():
    r, source = synthetic_runtime()
    bound = {'limit_cm': .1, 'requires_new_view': True,
             'anchor_odometry': copy.deepcopy(source['odometry'])}
    r.actions._pick_probe_limits[r.object_id] = copy.deepcopy(bound)
    before = copy.deepcopy(r.perception.objects())
    result = r.actions.execute({'action': 'go_to', 'params': {'object_id': r.object_id}})
    assert result['success'] is False and result['reason'] == 'historical_view_revisited_identity_unresolved', result
    proof = result['evidence']['historical_view_revisit']
    assert proof['arrived'] and proof['navigation_only'] and proof['requires_fresh_identity']
    assert position(r.snapshot['odometry']) == position(source['odometry'])
    assert commands(r, 'forward') == [{'distanceCm': 20.0, 'speed': 30}]
    assert r.actions._pick_probe_limits[r.object_id] == bound
    assert r.perception.get_object(r.object_id)['state'] == 'LOST'
    assert [o['id'] for o in r.perception.objects()] == [o['id'] for o in before]
    assert not r.actions.current_pick_ready(r.object_id)
    assert not r.actions.navigation_readiness(r.object_id)['operation_ready']
    assert not r.perception._grab_authorizations and not actual_grabs(r)
    compact = compact_action_result(1, {'action': 'go_to', 'params': {'object_id': r.object_id}},
                                    result, r.snapshot['observation_index'])
    assert compact['evidence']['historical_view_revisit']['navigation_only']
    assert compact['evidence']['historical_view_revisit']['requires_fresh_identity']
    n = len(r.bridge_records)
    r.observe()  # A fresh frame alone cannot make a second revisit useful.
    again = r.actions.execute({'action': 'go_to', 'params': {'object_id': r.object_id}})
    assert not again['success']
    assert all(row['request']['method'] not in {'forward', 'backward', 'turn', 'grab'}
               for row in r.bridge_records[n:])
    picked = r.pick()
    assert not picked['success'] and not actual_grabs(r)


@pytest.mark.parametrize('fault', ['wrong-id', 'unknown', 'clip', 'missing-quality', 'old-frame'])
def test_invalid_historical_source_never_creates_a_revisit_capability(fault):
    r, _ = synthetic_runtime(source_fault=fault)
    assert not r.actions.historical_view_revisit(r.object_id)['available']
    assert not r.perception._grab_authorizations and not actual_grabs(r)


@pytest.mark.parametrize('fault', ['holding', 'held-id', 'pending', 'no-exact-route', 'load-mismatch', 'never-confirmed', 'delivered', 'alias'])
def test_current_lifecycle_and_path_guards_reject_revisit_without_dispatch(fault):
    r, _ = synthetic_runtime()
    if fault == 'holding':
        r.snapshot['holding']['holding'] = True
    elif fault == 'held-id':
        r.held_object_id = r.object_id
    elif fault == 'pending':
        r.pending_grasp = {'object_id': r.object_id}
    elif fault == 'no-exact-route':
        r.roads._approach_edges.clear()
    elif fault == 'load-mismatch':
        for frame in r.roads._semantic.frames.values():
            frame['holding'] = {'holding': True}
    else:
        getter = r.perception.get_object
        def changed(oid):
            obj = copy.deepcopy(getter(oid))
            if fault == 'never-confirmed': obj['ever_confirmed'] = False
            elif fault == 'delivered': obj['state'] = 'DELIVERED'
            else: obj['alias_of'] = 'another-object'
            return obj
        r.perception.get_object = changed
    assert not r.actions.historical_view_revisit(r.object_id)['available']
    assert not commands(r, 'forward') and not commands(r, 'backward')
    assert not r.perception._grab_authorizations and not actual_grabs(r)


def test_unknown_revisit_motion_dispatches_once_and_never_retries():
    r, _ = synthetic_runtime()
    original = r.bridge.call
    sent = []
    def unknown(method, params):
        sent.append((method, copy.deepcopy(params)))
        original(method, params)
        raise ConnectionError('synthetic_revisit_ack_unknown')
    r.bridge.call = unknown
    with pytest.raises(ConnectionError, match='synthetic_revisit_ack_unknown') as caught:
        r.actions.execute({'action': 'go_to', 'params': {'object_id': r.object_id}})
    assert len(sent) == 1 and sent[0][0] == 'forward'
    assert caught.value.action_evidence['outcome_unknown']
    assert not r.perception._grab_authorizations and not actual_grabs(r)


def test_final_heading_unknown_cannot_mark_candidate_arrived():
    r, _ = synthetic_runtime(source_heading=10)
    original = r.bridge.call
    sent = []
    def final_turn_unknown(method, params):
        sent.append((method, copy.deepcopy(params)))
        result = original(method, params)
        if method == 'turn':
            raise ConnectionError('synthetic_final_heading_ack_unknown')
        return result
    r.bridge.call = final_turn_unknown
    with pytest.raises(ConnectionError, match='synthetic_final_heading_ack_unknown'):
        r.actions.execute({'action': 'go_to', 'params': {'object_id': r.object_id}})
    assert [method for method, _ in sent] == ['forward', 'turn']
    record = r.actions._navigation_record(r.object_id)
    assert not any(a.get('candidate_reached') or a.get('status') == 'historical_view_revisited'
                   for a in record['approach_attempts'])
    assert not r.perception._grab_authorizations and not actual_grabs(r)
