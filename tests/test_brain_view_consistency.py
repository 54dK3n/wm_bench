"""Public accepted-hit windows; no scene truth, RGB reconstruction or live score."""
import copy
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.perception import Perception, discovery_pixel_match
from world_model.providers.guangyang import odometry_to_pose
from test_brain_confirmation_sampling import sampling_runtime

WINDOWS = json.loads((Path(__file__).parent / 'fixtures/identity_view_consistency_public.json').read_text())


@pytest.mark.parametrize('window', WINDOWS, ids=lambda x: x['name'])
def test_public_views_reproduce_but_do_not_prove_a_precise_fused_anchor(window):
    p = Perception(window['camera'])
    rows = [r['source'] for r in window['sources']]
    oid = rows[0]['initial_object_id']
    for original in window['sources']:
        source = original['source']
        p.pose = odometry_to_pose(source['odometry'])
        det, evidence = p._convert(original['original_detection'], source['frame_id'], source['simulation_time_s'])
        assert (det.x, det.z) == pytest.approx(tuple(source['position_m'][k] for k in ('x', 'z')), abs=1e-12)
        assert evidence['position_semantics'] == 'approximate_width_range_estimate'
        assert discovery_pixel_match(p.camera, source, source['position_m'])
    mean = {k: sum(r['position_m'][k] for r in rows) / len(rows) for k in ('x', 'z')}
    assert mean == pytest.approx(window['wm_position'], abs=1e-12)
    p._accepted_poses[oid] = [{'frame_id': r['frame_id']} for r in rows]
    p._discovery_records = copy.deepcopy(rows)
    before = copy.deepcopy(p._discovery_records)
    proof = p._position_evidence(SimpleNamespace(obj_id=oid, **mean))
    assert proof['source_records_complete']
    assert proof['pixel_consistency'] == 'incompatible_original_pixels'
    assert proof['mean_reprojection_failed_frames'] == [r['frame_id'] for r in rows]
    assert len(proof['mutual_reprojection_failed_pairs']) == math.comb(len(rows), 2)
    assert not proof['position_is_identity_proof']
    assert p._discovery_records == before
    # A repeated source cannot substitute for a missing accepted view.
    p._discovery_records[-1] = copy.deepcopy(rows[0])
    assert not p._position_evidence(SimpleNamespace(obj_id=oid, **mean))['source_records_complete']


def test_live_components_expose_consistency_without_granting_manipulation():
    r = sampling_runtime(target=(0, 88))
    oid = r.perception.objects()[0]['id']
    assert r.perception.get_object(oid)['position_evidence']['pixel_consistency'] == 'insufficient_original_views'
    for _ in range(2):
        r.actions.move('forward', {'distanceCm': 16, 'speed': 30})
    obj = r.perception.get_object(oid)
    assert obj['state'] == 'CONFIRMED'
    assert obj['position_evidence']['pixel_consistency'] == 'pixel_consistent_estimate'
    brief = next(o for o in r.state()['objects'] if o['id'] == oid)['position_evidence']
    assert brief['pixel_consistency'] == 'pixel_consistent_estimate'
    assert not brief['position_is_identity_proof']
    assert brief['mean_reprojection_failure_count'] == 0
    assert not any(m['method'] in {'grab', 'release'} for m in r.motions)


def test_two_same_frame_detections_still_compete_and_cannot_grab():
    r = sampling_runtime(target=(0, 88), mode='competing')
    for _ in range(2):
        r.actions.move('forward', {'distanceCm': 16, 'speed': 30})
    rows = r.perception.objects()
    assert len(rows) == 2
    for row in rows:
        assert not r.perception.check_grasp_identity(row['id'], r.snapshot)['authorized']
    records = r.perception.discovery_evidence()['records']
    assert len(records) == 6
    assert records[0]['frame_id'] == records[1]['frame_id']
    assert records[0]['hypothesis_id'] != records[1]['hypothesis_id']
    assert not r.perception.discovery_evidence()['resolutions']
