"""Public r55 input regression; no model replay or task-success assertion."""
import copy
import json
from pathlib import Path
import pytest
from autonomous_brain.navigation import RoadMemory, position
from autonomous_brain.road_evidence import RoadEvidence

FIXTURE = Path(__file__).parent / 'fixtures/run_20260930T221441_r54_r61_public.json'

def source():
    return json.loads(FIXTURE.read_text())

def reconstruct(limit=252, data=None):
    data = data or source()
    mem = RoadMemory()
    motions = {m['after_observation']:m for m in data['motions']}
    previous, states = None, {}
    for row in data['observations']:
        if row['observation_index'] > limit:
            break
        motion = motions.get(row['observation_index'])
        if motion and motion['method'] == 'take_exit':
            mem.chosen(previous['odometry'], motion['params']['angleDeg'],
                       observation_index=previous['observation_index'])
        mem.update(row['odometry'], row['road'], row['observation_index'])
        mem.observe_traversal(row, motion)
        if motion and motion['actuator_result'].get('stoppedBy') == 'front_clearance':
            mem.remember_passage_failure(previous, row, motion)
            mem.mark_blocked()
        states[row['observation_index']] = {'chain':mem._semantic.chain,
            'anchor':copy.deepcopy(mem._semantic.anchors.get(row['observation_index']))}
        previous = row
    return mem, states

def test_actual_r55_preserves_localization_but_never_completes_blocked_exit():
    mem, states = reconstruct(240)
    assert states[240]['chain'] == states[239]['chain']
    assert states[240]['anchor']['node_id'] != states[239]['anchor']['node_id']
    frames = mem._semantic.frames
    a, b = position(frames[239]['odometry']), position(frames[240]['odometry'])
    edge = mem._approach_edges[b][a]
    assert edge['direction_status'] == 'reverse_not_yet_observed'
    assert edge['execution']['kind'] == 'road_following'
    assert mem._approach_edges[a][b]['localization_prefix_only'] is True
    assert mem.edge_passage_blocked(mem._approach_edges[a][b]) is not None
    assert mem.edge_passage_blocked(edge) is None
    assert not any(t['last_observation'] == 240 for t in mem.road_evidence()['traversals'])
    assert mem.passage_blocked(frames[239], -151) is not None

def test_actual_r57_and_r58_reconnect_geometry_and_exact_semantic_anchor():
    mem, states = reconstruct()
    assert states[252]['anchor']['node_id'] == states[239]['anchor']['node_id']
    node = mem._semantic.nodes[states[252]['anchor']['node_id']]
    assert node['status'] == 'confirmed'
    a = position(mem._semantic.frames[240]['odometry'])
    b = position(mem._semantic.frames[248]['odometry'])
    c = position(mem._semantic.frames[252]['odometry'])
    assert b in mem._approach_edges[a] and c in mem._approach_edges[b]
    assert mem._approach_edges[b][c]['direction_status'] == 'observed_forward'
    assert mem.passage_blocked(mem._semantic.frames[253] if 253 in mem._semantic.frames
        else mem._semantic.frames[239], -151) is not None
    assert not any(t['first_observation'] == 239 for t in mem.road_evidence()['traversals'])

@pytest.mark.parametrize('bad', ['unknown','not_sent','rejected','error','missing_frame','stale_frame',
    'tick','road_tick','elapsed','distance','holding','offroad','collision','gap','curve_basic'])
def test_incomplete_stop_evidence_cannot_keep_chain_or_prefix_edge(bad):
    data = source()
    a = copy.deepcopy(next(o for o in data['observations'] if o['observation_index']==239))
    b = copy.deepcopy(next(o for o in data['observations'] if o['observation_index']==240))
    m = copy.deepcopy(next(m for m in data['motions'] if m['after_observation']==240))
    if bad == 'unknown':m['outcome_unknown']=True
    if bad == 'not_sent':m['motion_not_sent']=True
    if bad == 'rejected':m['actuator_result']['accepted']=False
    if bad == 'error':m['actuator_result']['error']='unknown'
    if bad == 'missing_frame':b['observation'].pop('frameId')
    if bad == 'stale_frame':b['observation']['frameId']=a['observation']['frameId']
    if bad == 'tick':b['observation']['tick']-=1
    if bad == 'road_tick':b['road']['tick']-=1
    if bad == 'elapsed':m['actuator_result']['elapsedTicks']-=1
    if bad == 'distance':m['actuator_result']['distanceCm']+=2
    if bad == 'holding':b['holding']['holding']=False
    if bad == 'offroad':b['road']['onRoad']=False
    if bad == 'collision':m['actuator_result']['stoppedBy']='collision'
    if bad == 'gap':b['observation_index']+=1;m['after_observation']+=1
    if bad == 'curve_basic':m['method']='forward';m['params']={'distanceCm':20}
    mem = RoadMemory()
    for row,motion in [(a,None),(b,m)]:
        mem.update(row['odometry'],row['road'],row['observation_index'])
        mem.observe_traversal(row,motion)
    assert mem._semantic.chain > 0
    assert not mem._approach_edges.get(position(b['odometry']),{}).get(position(a['odometry']))

def test_static_fresh_frames_do_not_invent_completion_or_different_node_identity():
    mem, states = reconstruct(240)
    before = mem.road_evidence()
    row = copy.deepcopy(mem._semantic.frames[240])
    for i in range(241,251):
        row['observation_index']=i;row['observation']['frameId']=i
        mem.update(row['odometry'],row['road'],i);mem.observe_traversal(row)
    after=mem.road_evidence()
    assert after['traversals'] == before['traversals']
    assert states[239]['anchor']['node_id'] != mem._semantic.anchors[250]['node_id']
    assert all(e['state']=='blocked' for e in after['exits'] if e['id'] in
        {e['id'] for e in before['exits'] if e['state']=='blocked'})

@pytest.mark.parametrize('change', ['different_stop', 'different_structure', 'unknown_return', 'missing_return'])
def test_unproved_return_never_claims_old_semantic_identity(change):
    data = source()
    end = next(o for o in data['observations'] if o['observation_index']==252)
    motion = next(m for m in data['motions'] if m['after_observation']==252)
    if change == 'different_stop':end['odometry']['rightCm']+=3
    if change == 'different_structure':end['road']['exits'].pop()
    if change == 'unknown_return':motion['actuator_result']['accepted']=False
    if change == 'missing_return':data['motions'].remove(motion)
    # No historical completed trip is supplied here: test the localization
    # prefix alone, without independently proved route-endpoint identity.
    ledger = RoadEvidence()
    motions = {m['after_observation']:m for m in data['motions']}
    for row in data['observations']:
        if 233 <= row['observation_index'] <= 252:
            ledger.observe(row, motions.get(row['observation_index']))
    assert ledger.anchors[252]['node_id'] != ledger.anchors[239]['node_id']

def test_zero_chord_r56_receipt_preserves_pose_only_without_creating_a_loop_edge():
    mem, states = reconstruct(244)
    assert states[244]['chain'] == states[243]['chain']
    p=position(mem._semantic.frames[244]['odometry'])
    assert p not in mem._approach_edges[p]
    assert not any(t['first_observation']==243 for t in mem.road_evidence()['traversals'])
