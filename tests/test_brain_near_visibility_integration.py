"""Visibility-only refresh through real Perception and vendored WorldModel."""
import copy
import pytest
from test_brain_perception import CAMERA, Perception, ball, observe


@pytest.mark.parametrize('state', ['tentative', 'stale', 'confirmed'])
def test_active_unique_near_sighting_preserves_geometry_and_confirmation(state):
    p = Perception(CAMERA)
    observe(p, 1)
    if state != 'tentative':
        observe(p, 2, 16)
        observe(p, 3, 32)
    if state == 'stale':
        observe(p, 4, 60, time=2, items=[])
    t = p.wm.get_scene()[0]
    assert t.state.value == state
    before = copy.deepcopy(vars(t))
    poses = copy.deepcopy(p._accepted_poses)
    for frame, now in [(10, 3), (11, 6), (12, 9)]:
        e = observe(p, frame, 60, time=now)['detections'][0]
        assert e['visibility_refresh_only'] is True
        assert e['fed_to_world_model'] is False
        assert e['track_id'] == t.obj_id
        for field in ['x', 'z', 'confidence', 'state', 'hit_count', 'miss_count', 'radius_cm']:
            assert getattr(t, field) == before[field]
        assert t.last_seen == t.last_updated == now
        assert p._accepted_poses == poses
        assert p.wm.get_archived(t.obj_id) is None
        assert (p.confirmed(t.obj_id) is not None) == (state == 'confirmed')
    # Visibility must not make the next independent confirmation sample disappear.
    observe(p, 13, 16, time=9.1, items=[ball(64)])
    if state == 'tentative':
        assert t.hit_count == before['hit_count'] + 1


def test_lost_is_not_revived_and_near_does_not_spawn():
    p = Perception(CAMERA)
    observe(p, 1)
    oid = p.wm.get_scene()[0].obj_id
    observe(p, 2, time=20, items=[])
    archived = copy.deepcopy(vars(p.wm.get_archived(oid)))
    e = observe(p, 3, 60, time=21)['detections'][0]
    assert not e.get('visibility_refresh_only')
    assert not p.wm.get_scene()
    assert vars(p.wm.get_archived(oid)) == archived


@pytest.mark.parametrize('multiple_tracks', [False, True])
def test_tentative_ambiguity_in_either_direction_still_decays(multiple_tracks):
    p = Perception(CAMERA)
    observe(p, 1, items=[ball(80, bearing=-3), ball(80, bearing=3)] if multiple_tracks else [ball(80)])
    before = {t.obj_id: copy.deepcopy(vars(t)) for t in p.wm.get_scene()}
    e = observe(p, 2, 60, time=3,
                items=[ball(20)] if multiple_tracks else [ball(20, bearing=-3), ball(20, bearing=3)])
    assert all(not d.get('visibility_refresh_only') for d in e['detections'])
    for oid, old in before.items():
        t = p.wm.get_object(oid)
        assert t.confidence < old['confidence']
        assert t.last_seen == old['last_seen']
