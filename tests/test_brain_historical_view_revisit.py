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


def mixed_revisit_runtime():
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
    r.observe()
    # Real conversion changes feed classification as the public bbox becomes
    # smaller at a more distant measured robot pose. Both sources stay confirmed.
    fed = []
    for distance in (35, 5):
        r.actions.move('backward', {'distanceCm': distance, 'speed': 30})
        source = copy.deepcopy(r.snapshot)
        assert source['perception']['detections'][0]['fed_to_world_model'] is True
        assert r.perception.confirmed(r.object_id)
        assert r.perception.check_grasp_identity(r.object_id, source)['authorized']
        fed.append(source)
    r.actions.move('forward', {'distanceCm': 40, 'speed': 30})
    near = copy.deepcopy(r.snapshot)
    assert near['perception']['detections'][0]['fed_to_world_model'] is False
    assert r.perception.confirmed(r.object_id)
    assert r.perception.check_grasp_identity(r.object_id, near)['authorized']
    # Loss is produced by normal WM expiry, not an internal state assignment.
    r.override_items = []
    r.actions.move('backward', {'distanceCm': 5, 'speed': 30})
    r.bridge.seconds += 60
    r.observe()
    assert r.perception.get_object(r.object_id)['state'] == 'LOST'
    return r, fed, near


def test_historical_view_prefers_latest_fed_source_over_newer_visibility_only_source():
    r, fed, near = mixed_revisit_runtime()
    before = copy.deepcopy(r.perception.objects())
    commands_before = len(r.bridge_records)
    assert fed[0]['observation_index'] < fed[1]['observation_index'] < near['observation_index']
    view = r.actions.historical_view_revisit(r.object_id)
    assert view['available'] and view['navigation_only'] and view['requires_fresh_identity']
    assert view['source_observation'] == fed[1]['observation_index']
    assert view['position_m'] == list(position(fed[1]['odometry']))
    assert r.perception.objects() == before
    assert len(r.bridge_records) == commands_before and not actual_grabs(r)


def test_historical_view_keeps_near_fallback_when_fed_sources_have_no_exact_route():
    r, fed, near = mixed_revisit_runtime()
    # Remove only the recorded graph connections to the two fed viewpoints.
    # Keep all cached observations; source eligibility must not bypass route checks.
    points = {position(source['odometry']) for source in fed}
    for point in points:
        r.roads._approach_edges.pop(point, None)
    for edges in r.roads._approach_edges.values():
        for point in points:
            edges.pop(point, None)
    for point in points:
        route = r.roads.route_to(r.snapshot['odometry'], point)
        assert not route or route[-1] != point
    view = r.actions.historical_view_revisit(r.object_id)
    assert view['available'] and view['navigation_only'] and view['requires_fresh_identity']
    assert view['source_observation'] == near['observation_index']
    assert view['position_m'] == list(position(near['odometry']))
    assert r.perception.get_object(r.object_id)['state'] == 'LOST'
    assert not r.perception._grab_authorizations and not actual_grabs(r)


def revisit(r):
    return r.actions.execute({'action': 'go_to', 'params': {'object_id': r.object_id}})


def test_distinct_historical_view_continues_after_known_unresolved_arrival():
    r, fed, _ = mixed_revisit_runtime()
    bound = {'limit_cm': .1, 'requires_new_view': True,
             'anchor_odometry': copy.deepcopy(fed[1]['odometry'])}
    r.actions._pick_probe_limits[r.object_id] = copy.deepcopy(bound)
    identities = [o['id'] for o in r.perception.objects()]
    first = revisit(r)
    assert first['reason'] == 'historical_view_revisited_identity_unresolved'
    assert first['evidence']['historical_view_revisit']['source_observation'] == fed[1]['observation_index']
    record = r.actions._navigation_record(r.object_id)
    prior_attempts = copy.deepcopy(record['attempts'])
    prior_approaches = copy.deepcopy(record['approach_attempts'])
    assert len(prior_attempts) == len(prior_approaches) == 1
    assert prior_attempts[0]['historical_view_arrived'] is True
    # Default target-level protection is retained. Only the separately checked
    # next historical viewpoint supplies another navigation intent.
    assert r.navigation_progress.blocked(record, r.actions._navigation_context(r.object_id))
    candidate = r.actions.historical_view_revisit(r.object_id)
    assert candidate['available'] and candidate['source_observation'] == fed[0]['observation_index']
    # The next native25 model decision receives B through production state
    # assembly, then the unchanged validator accepts only navigation to LOST.
    from autonomous_brain.run import Runtime
    from autonomous_brain.llm import ActionValidationError, validate_action
    r.config = {'task': '把一个红球放到存放区'}
    action = {'action': 'go_to', 'params': {'object_id': r.object_id}}
    r.recent = [compact_action_result(r.round, action, first, r.snapshot['observation_index'])]
    r.snapshot['road']['atJunction'] = False
    state = Runtime.state(r)
    target = next(row for row in state['objects'] if row['id'] == r.object_id)
    assert target['status'] == 'LOST'
    assert target['historical_view_revisit'] == candidate
    assert state['recent_actions'][-1]['reason'] == 'historical_view_revisited_identity_unresolved'
    assert state['navigation'][0]['recent_attempts'] == prior_attempts
    assert state['navigation'][0]['repeat_blocked'] is False
    accepted = validate_action(action, state, transcript_version='autonomous-brain-llm/v25')
    with pytest.raises(ActionValidationError, match='pick requires a CONFIRMED'):
        validate_action({'action': 'pick', 'params': {'object_id': r.object_id}}, state,
                        transcript_version='autonomous-brain-llm/v25')
    second = r.actions.execute(accepted)
    assert not second['success'] and second['reason'] == 'historical_view_revisited_identity_unresolved'
    assert second['evidence']['historical_view_revisit']['arrived']
    assert position(r.snapshot['odometry']) == pytest.approx(position(fed[0]['odometry']))
    assert record['attempts'][:len(prior_attempts)] == prior_attempts
    assert record['approach_attempts'][:len(prior_approaches)] == prior_approaches
    assert len(record['approach_attempts']) == 2
    assert r.actions._pick_probe_limits[r.object_id] == bound
    assert r.perception.get_object(r.object_id)['state'] == 'LOST'
    assert [o['id'] for o in r.perception.objects()] == identities
    assert not r.actions.current_pick_ready(r.object_id)
    assert not r.actions.navigation_readiness(r.object_id)['operation_ready']
    assert not r.perception._grab_authorizations and not actual_grabs(r)


def test_tried_historical_poses_do_not_repeat_after_frames_routes_or_exhaustion():
    r, _, _ = mixed_revisit_runtime()
    views = copy.deepcopy(r.actions._historical_views[r.object_id])
    for _ in views:
        assert revisit(r)['reason'] == 'historical_view_revisited_identity_unresolved'
    record = r.actions._navigation_record(r.object_id)
    attempts = copy.deepcopy(record['attempts'])
    approaches = copy.deepcopy(record['approach_attempts'])
    # Each actual return created fresh observed graph segments, with route
    # versions different from the route that originally attempted that pose.
    old_versions = {attempt['route_version'] for attempt in approaches}
    new_versions = set()
    from autonomous_brain.navigation import evidence_version
    for view in views:
        route = r.roads.route_to(r.snapshot['odometry'], tuple(view['position_m']))
        if route and tuple(route[-1]) == tuple(view['position_m']):
            segments = [r.roads._approach_edges[a][b] for a, b in zip(route, route[1:])]
            new_versions.add(evidence_version([[s['segment_version'], s['direction']] for s in segments]))
    assert new_versions - old_versions
    before = len(r.bridge_records)
    for _ in range(2):
        r.observe()
        assert not r.actions.historical_view_revisit(r.object_id)['available']
        assert revisit(r)['reason'] == 'historical_view_revisit_exhausted'
    assert record['attempts'] == attempts and record['approach_attempts'] == approaches
    assert not any(row['request']['method'] in {'forward', 'backward', 'turn', 'grab'}
                   for row in r.bridge_records[before:])
    assert not r.perception._grab_authorizations and not actual_grabs(r)


def same_position_views_runtime():
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
    r.observe()
    for _ in range(2):
        r.actions.move('turn', {'angleDeg': 10, 'speed': 30})
    duplicate = copy.deepcopy(r.actions._historical_views[r.object_id][-1])
    r.observe()  # A second valid source frame at the same saved pose/heading.
    sources = copy.deepcopy(r.actions._historical_views[r.object_id])
    assert [source['heading_deg'] for source in sources] == [0, 10, 20]
    assert len({tuple(source['position_m']) for source in sources}) == 1
    r.override_items = []
    r.actions.move('turn', {'angleDeg': -20, 'speed': 30})
    r.actions.move('backward', {'distanceCm': 20, 'speed': 30})
    r.bridge.seconds += 60
    r.observe()
    assert r.perception.get_object(r.object_id)['state'] == 'LOST'
    r.command_start = len(r.bridge_records)
    return r, sources, duplicate


def test_saved_heading_distinguishes_views_and_source_frame_does_not():
    r, sources, duplicate = same_position_views_runtime()
    assert duplicate['source_observation'] != sources[-1]['source_observation']
    assert duplicate['frame_id'] != sources[-1]['frame_id']
    assert duplicate['position_m'] == sources[-1]['position_m']
    assert duplicate['heading_deg'] == sources[-1]['heading_deg']
    for expected in (20, 10, 0):
        candidate = r.actions.historical_view_revisit(r.object_id)
        assert candidate['available'] and candidate['heading_deg'] == expected
        result = revisit(r)
        assert result['evidence']['historical_view_revisit']['arrived']
        assert r.snapshot['odometry']['headingDeg'] == expected
        if expected == 20:
            r.actions._historical_views[r.object_id].append(duplicate)
    record = r.actions._navigation_record(r.object_id)
    # Both final candidates have the same position and empty route; headings
    # still give independent camera views, without target-identity authority.
    assert record['approach_attempts'][1]['route_version'] == record['approach_attempts'][2]['route_version']
    assert len(record['approach_attempts']) == 3
    assert commands(r, 'turn') == [{'angleDeg': 20.0, 'speed': 50},
                                  {'angleDeg': -10.0, 'speed': 50},
                                  {'angleDeg': -10.0, 'speed': 50}]
    assert revisit(r)['reason'] == 'historical_view_revisit_exhausted'
    assert r.perception.get_object(r.object_id)['state'] == 'LOST'
    assert not r.perception._grab_authorizations and not actual_grabs(r)


@pytest.mark.parametrize('fault', ['ordinary-failure', 'unknown-arrival', 'unverified-arrival',
                                   'mismatched-arrival', 'blocked-route'])
def test_different_view_does_not_erase_other_failure_or_safety_guards(fault):
    r, _, _ = mixed_revisit_runtime()
    arrived = revisit(r)
    assert arrived['evidence']['historical_view_revisit']['arrived']
    record = r.actions._navigation_record(r.object_id)
    prior = copy.deepcopy(record['approach_attempts'])
    if fault == 'blocked-route':
        r.roads._approach_edges.clear()
    else:
        # Start with the real, complete A result so each fault independently
        # tests its guard instead of failing on unrelated missing evidence.
        outcome = copy.deepcopy(arrived)
        if fault == 'ordinary-failure':
            outcome['reason'] = 'route_blocked'
        elif fault == 'unknown-arrival':
            outcome['evidence']['outcome_unknown'] = True
        elif fault == 'unverified-arrival':
            outcome['evidence']['historical_view_revisit']['arrived'] = False
        else:
            outcome['evidence']['historical_view_revisit']['after_observation'] += 1
        r.actions.remember_navigation_result(r.object_id, outcome)
        assert 'historical_view_arrived' not in record['attempts'][-1]
    before = len(r.bridge_records)
    assert not r.actions.historical_view_revisit(r.object_id)['available']
    rejected = revisit(r)
    assert not rejected['success']
    assert rejected['reason'] in {'navigation_repeat_without_new_evidence',
                                  'historical_view_revisit_unavailable'}
    assert record['approach_attempts'] == prior
    assert len(prior) == 1 < len(r.actions._historical_views[r.object_id])
    assert not any(row['request']['method'] in {'forward', 'backward', 'turn', 'grab'}
                   for row in r.bridge_records[before:])
    assert not r.perception._grab_authorizations and not actual_grabs(r)


@pytest.mark.parametrize('failure_at', ['translation', 'heading'])
def test_second_view_unknown_ack_stops_after_one_send_without_consuming_success(failure_at):
    r = mixed_revisit_runtime()[0] if failure_at == 'translation' else same_position_views_runtime()[0]
    assert revisit(r)['evidence']['historical_view_revisit']['arrived']
    record = r.actions._navigation_record(r.object_id)
    prior = copy.deepcopy(record['approach_attempts'])
    assert r.actions.historical_view_revisit(r.object_id)['available']
    original = r.bridge.call
    sent = []
    def unknown(method, params):
        sent.append((method, copy.deepcopy(params)))
        original(method, params)
        raise ConnectionError('synthetic_second_view_ack_unknown')
    r.bridge.call = unknown
    with pytest.raises(ConnectionError, match='synthetic_second_view_ack_unknown') as caught:
        revisit(r)
    assert len(sent) == 1
    assert sent[0][0] in ({'forward', 'backward'} if failure_at == 'translation' else {'turn'})
    assert caught.value.action_evidence['outcome_unknown']
    assert record['approach_attempts'][:len(prior)] == prior
    failed = record['approach_attempts'][-1]
    assert failed['candidate_reached'] is False and failed['status'] == 'route_not_reached'
    assert not r.actions.historical_view_revisit(r.object_id)['available']
    assert not revisit(r)['success'] and len(sent) == 1
    assert r.perception.get_object(r.object_id)['state'] == 'LOST'
    assert not r.perception._grab_authorizations and not actual_grabs(r)
