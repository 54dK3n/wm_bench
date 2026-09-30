"""Directed transport constraints: public sensor fixtures, not platform results."""
import copy
import math
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory, heading_to, position, wrap
from test_brain_navigation_reposition import sensor, register
from test_brain_route_contract import normalize


def frame(index, p=(0, 0), *, heading=0, holding=True, clearance=100):
    row = sensor(index, p, heading=heading)
    row['holding']['holding'] = holding
    row['road'].update(atNode=True, frontClearanceCm=clearance,
                      exits=[{'angleDeg': wrap(h-heading)} for h in (0, 90, -180)])
    return row


def failed_passage(roads=None):
    roads = roads or RoadMemory()
    before = frame(1, clearance=10.2)
    after = frame(2, (0, .1), clearance=.2)
    after['odometry']['distanceCm'] = 10
    params = normalize('take_exit', {'angleDeg': 0, 'speed': 50})
    motion = {'method': 'take_exit', 'params': params, 'before_observation': 1,
              'after_observation': 2, 'bridge_request_id': 'public-test-1',
              'actuator_result': {'accepted': True, 'stoppedBy': 'front_clearance',
                                  'distanceCm': 10}}
    failure = roads.remember_passage_failure(before, after, motion)
    assert failure is not None
    return roads, before, after, failure


@pytest.mark.parametrize('change', ['same', 'new_frame', '3cm_5deg', 'unrelated_graph'])
def test_same_directed_obstruction_is_not_reset_by_irrelevant_context(change):
    roads, before, after, failure = failed_passage()
    current = frame(10, clearance=10.2)
    if change == 'same':
        current = copy.deepcopy(before)
    elif change == '3cm_5deg':
        current = frame(10, (.03, 0), heading=5, clearance=10.2)
    elif change == 'unrelated_graph':
        distant = frame(10, (2, 2))
        next_distant = frame(11, (2, 2.3))
        next_distant['odometry']['distanceCm'] = 30
        register(roads, distant)
        register(roads, next_distant, distant)
        assert roads.road_segment_records()
    assert roads.passage_blocked(current, current['odometry']['headingDeg'])['passage_id'] == failure['passage_id']
    assert roads.blocked[-1]['resolved_by'] is None
    assert roads.blocked[-1]['motion']['bridge_request_id'] == 'public-test-1'


def test_only_fresh_comparable_stop_view_restores_the_failed_clearance():
    roads, before, after, failure = failed_passage()
    # More clearance after moving or turning cannot prove the blocked direction clear.
    for candidate in [frame(5, (.03, .1), clearance=50),
                      frame(6, (0, .1), heading=5, clearance=50),
                      frame(2, (0, .1), clearance=50)]:
        assert roads.passage_blocked(candidate, 0) is not None
        assert roads.blocked[-1]['resolved_by'] is None
    restored = frame(7, (0, .1), clearance=50)
    assert roads.passage_blocked(restored, 0) is None
    resolution = roads.blocked[-1]['resolved_by']
    assert resolution['observation_index'] == 7
    assert resolution['reason'] == 'fresh_comparable_stop_view_clearance_restored'
    assert roads.passage_blocked(frame(8, clearance=10.2), 0) is None
    # The original immutable failure observations remain in the record.
    assert roads.blocked[-1]['stop']['front_clearance_cm'] == .2


def test_restriction_is_directional_and_preserves_the_original_load_condition():
    roads, before, after, failure = failed_passage()
    assert roads.passage_blocked(before, -180) is None
    empty = frame(8, holding=False, clearance=10.2)
    assert roads.passage_blocked(empty, 0) is None
    assert roads.blocked[-1]['resolved_by'] is None
    assert roads.passage_blocked(frame(9, clearance=10.2), 0) is not None


def recorded_graph(*, alternative):
    """Register actual contiguous motion endpoints; no fabricated graph edges."""
    roads = RoadMemory()
    current = frame(20)
    current['road'].update(atNode=False, exits=[])
    register(roads, current)
    vertices = [(0, .3), (0, 0)]
    if alternative:
        vertices += [(-.3, 0), (-.3, .3), (0, .3), (0, 0)]
    for endpoint in vertices:
        heading = heading_to(position(current['odometry']), endpoint)
        angle = wrap(heading-current['odometry']['headingDeg'])
        if abs(angle) >= 1:
            params = normalize('turn', {'angleDeg': angle, 'speed': 50})
            nxt = copy.deepcopy(current)
            nxt['observation_index'] += 1
            nxt['odometry'].update(headingDeg=heading, tick=nxt['observation_index'])
            nxt['observation'] = {'frameId': str(nxt['observation_index']), 'tick': nxt['observation_index']}
            roads.update(nxt['odometry'], nxt['road'], nxt['observation_index'])
            roads.observe_traversal(nxt, {'method': 'turn', 'params': params,
                'before_observation': current['observation_index'], 'after_observation': nxt['observation_index'],
                'actuator_result': {'completed': True}})
            current = nxt
        length = math.dist(position(current['odometry']), endpoint)*100
        params = normalize('follow_road', {'distanceCm': length, 'speed': 50})
        nxt = sensor(current['observation_index']+1, endpoint, heading=heading,
                     travelled=current['odometry']['distanceCm']+length)
        nxt['holding']['holding'] = True
        roads.update(nxt['odometry'], nxt['road'], nxt['observation_index'])
        roads.observe_traversal(nxt, {'method': 'follow_road', 'params': params,
            'before_observation': current['observation_index'], 'after_observation': nxt['observation_index'],
            'actuator_result': {'accepted': True, 'stoppedBy': 'max_distance', 'distanceCm': length}})
        current = nxt
    return roads, current


def test_route_search_uses_a_recorded_alternative_without_deleting_history():
    roads, current = recorded_graph(alternative=True)
    assert roads.route_to(current['odometry'], (0, .3)) == [(0, 0), (0, .3)]
    original_count = len(roads.road_segment_records())
    failed_passage(roads)
    assert roads.route_to(current['odometry'], (0, .3)) == [(0, 0), (-.3, 0), (-.3, .3), (0, .3)]
    assert len(roads.road_segment_records()) == original_count
    assert roads.edge_passage_blocked(roads._approach_edges[(0, 0)][(0, .3)]) is not None
    assert roads.edge_passage_blocked(roads._approach_edges[(0, .3)][(0, 0)]) is None


def test_no_recorded_successor_does_not_invent_a_route():
    roads, current = recorded_graph(alternative=False)
    failed_passage(roads)
    assert roads.route_to(current['odometry'], (0, .3)) == [(0, 0)]
    assert roads.approach_candidates(current['odometry'], (0, .6)) == []


def action_runtime(*, heading=0, blocked=False):
    current = frame(10, heading=heading, clearance=100)
    roads, calls, motions = RoadMemory(), [], []
    register(roads, current)
    pending = {}
    runtime = SimpleNamespace(snapshot=current, round=1, roads=roads,
        bridge=SimpleNamespace(seconds=0, max_seconds=1200, sequence=0),
        perception=SimpleNamespace(), motion_log=SimpleNamespace(write=motions.append))
    def call(method, params):
        normalized = normalize(method, params)
        calls.append((method, normalized))
        runtime.bridge.sequence += 1
        if method == 'turn':
            current['odometry']['headingDeg'] = wrap(current['odometry']['headingDeg']+normalized['angleDeg'])
            pending['front'] = 10.2 if blocked else 100
            return {'completed': True}
        assert method == 'take_exit'
        current['odometry']['forwardCm'] += 10
        current['odometry']['distanceCm'] += 10
        pending['front'] = .2 if blocked else 100
        return {'accepted': True, 'stoppedBy': 'front_clearance' if blocked else 'entered_road', 'distanceCm': 10}
    def observe(*, motion=None):
        current['observation_index'] += 1
        current['odometry']['tick'] = current['observation_index']
        current['observation'] = {'frameId': str(current['observation_index']), 'tick': current['observation_index']}
        current['road'].update(frontClearanceCm=pending.pop('front', current['road']['frontClearanceCm']),
            exits=[{'angleDeg': wrap(h-current['odometry']['headingDeg'])} for h in (0, 90, -180)])
        roads.update(current['odometry'], current['road'], current['observation_index'])
        roads.observe_traversal(current, dict(motion, after_observation=current['observation_index']) if motion else None)
    runtime.bridge.call, runtime.observe = call, observe
    return runtime, calls, motions


def test_action_records_actual_failed_motion_and_rejects_identical_retry():
    runtime, calls, motions = action_runtime(blocked=True)
    actions = Actions(runtime)
    first = actions.move('take_exit', {'angleDeg': 0, 'speed': 50})
    assert first['stoppedBy'] == 'front_clearance'
    assert len(calls) == 1 and len(motions) == 1
    assert runtime.roads.blocked[-1]['entry']['observation_index'] == 10
    assert runtime.roads.blocked[-1]['stop']['observation_index'] == 11
    with pytest.raises(ObservedMotionFailure) as rejected:
        actions.move('take_exit', {'angleDeg': 0, 'speed': 50})
    assert rejected.value.reason == 'directed_passage_still_blocked'
    assert len(calls) == 1


def test_exit_turn_reobserves_direction_but_does_not_drive_into_known_blocker():
    runtime, calls, motions = action_runtime(heading=90, blocked=True)
    failed_passage(runtime.roads)
    with pytest.raises(ObservedMotionFailure) as rejected:
        Actions(runtime).take_observed_exit(-90)
    assert rejected.value.reason == 'directed_passage_still_blocked'
    assert calls == [('turn', {'angleDeg': -90, 'speed': 50})]
    assert runtime.snapshot['observation_index'] == 11
    assert runtime.snapshot['road']['frontClearanceCm'] == 10.2


def test_unblocked_exit_still_turns_observes_and_executes_normalized_command():
    runtime, calls, motions = action_runtime(heading=90)
    result = Actions(runtime).take_observed_exit(-90)
    assert result['accepted'] and result['stoppedBy'] == 'entered_road'
    assert calls == [('turn', {'angleDeg': -90, 'speed': 50}),
                     ('take_exit', {'angleDeg': 0, 'speed': 50})]
    assert [(x['before_observation'], x['after_observation']) for x in motions] == [(10, 11), (11, 12)]


def test_no_safe_current_exit_sends_zero_commands():
    runtime, calls, motions = action_runtime(blocked=True)
    runtime.snapshot['road']['exits'] = [{'angleDeg': 0}]
    failed_passage(runtime.roads)
    with pytest.raises(ObservedMotionFailure) as rejected:
        Actions(runtime).take_observed_exit(0)
    assert rejected.value.reason == 'directed_passage_still_blocked'
    assert calls == [] and motions == []


def test_reverse_retreat_edge_is_restricted_at_failed_arrival_even_when_start_is_distant():
    roads, before, stopped, failure = failed_passage()
    departure = frame(20, (0, .1), heading=-180, clearance=100)
    arrival = frame(21, (0, -.3), heading=-180, clearance=100)
    arrival['odometry']['distanceCm'] = 40
    params = normalize('take_exit', {'angleDeg': 0, 'speed': 50})
    register(roads, departure)
    roads.update(arrival['odometry'], arrival['road'], 21)
    roads.observe_traversal(arrival, {'method': 'take_exit', 'params': params,
        'before_observation': 20, 'after_observation': 21,
        'actuator_result': {'accepted': True, 'stoppedBy': 'entered_road', 'distanceCm': 40}})
    retreat = roads._approach_edges[(0, .1)][(0, -.3)]
    reverse = roads._approach_edges[(0, -.3)][(0, .1)]
    assert math.dist(reverse['departure']['position_m'], failure['entry']['position_m']) > .15
    assert roads.edge_passage_blocked(retreat) is None
    assert roads.edge_passage_blocked(reverse)['passage_id'] == failure['passage_id']
    assert roads.route_to(arrival['odometry'], (0, .1)) == [(0, -.3)]


def test_curved_reverse_binds_the_actual_failed_route_without_widening_heading_gates():
    """Reduced original public r59/r61 geometry; never used as a runtime route."""
    roads = RoadMemory()
    entry = frame(1, (.765, 1.554), heading=-151, clearance=16.9)
    stopped = frame(2, (.852, 1.414), heading=-134.2, clearance=.2)
    stopped['odometry']['distanceCm'] = 16.8
    params = normalize('take_exit', {'angleDeg': 0, 'speed': 50})
    failure = roads.remember_passage_failure(entry, stopped, {'method': 'take_exit', 'params': params,
        'before_observation': 1, 'after_observation': 2,
        'actuator_result': {'accepted': True, 'stoppedBy': 'front_clearance', 'distanceCm': 16.9}})
    # The legal retreat curves from body heading 6.6 degrees to 0.1 degrees.
    departure = frame(3, (.852, 1.414), heading=6.6, clearance=99.7)
    departure['road']['exits'] = [{'angleDeg': a} for a in (85.5, 0, -157.5)]
    departure['odometry']['distanceCm'] = 16.8
    arrival = frame(4, (.757, 1.774), heading=.1, clearance=63)
    arrival['road']['exits'] = [{'angleDeg': 179.9}]
    arrival['odometry']['distanceCm'] = 55.8
    register(roads, departure)
    roads.update(arrival['odometry'], arrival['road'], 4)
    roads.observe_traversal(arrival, {'method': 'take_exit', 'params': params,
        'before_observation': 3, 'after_observation': 4,
        'actuator_result': {'accepted': True, 'stoppedBy': 'entered_road', 'distanceCm': 39}})
    reverse = roads._approach_edges[position(arrival['odometry'])][position(departure['odometry'])]
    assert abs(wrap(reverse['arrival']['travel_heading_deg']-stopped['odometry']['headingDeg'])) > 10
    assert roads.edge_passage_blocked(reverse) is None  # Tangent evidence alone cannot make this association.
    selected = roads.route_segment_ref(position(arrival['odometry']), position(departure['odometry']))
    roads.bind_blocked_route(failure['passage_id'], selected)
    assert roads.edge_passage_blocked(reverse)['passage_id'] == failure['passage_id']
    reobserved = copy.deepcopy(reverse)
    reobserved['segment_id'] = 'same-measured-route-later-observations'
    assert roads.edge_passage_blocked(reobserved)['passage_id'] == failure['passage_id']
    assert roads.edge_passage_blocked(roads._approach_edges[position(departure['odometry'])][position(arrival['odometry'])]) is None
