"""Only related perception evidence can unlock a grasp identity failure."""
import copy
from autonomous_brain.navigation_progress import grasp_identity_change, NavigationProgress
from test_brain_approach_identity import confirmed_scene
from test_brain_recovery_discovery import runtime, publish, see_world


def context(r, oid):
    return {'grasp_identity': r.perception.grasp_identity_context(oid),
            'grasp_identity_authorized': r.perception.check_grasp_identity(oid, r.snapshot)['authorized'],
            'relevant_object_states': [(o['id'], o['state']) for o in r.perception.objects()]}


def test_same_competition_cannot_unlock_from_new_frame_turn_or_position():
    r, oid, _ = confirmed_scene(old_x=8)
    before = context(r, oid)
    see_world(r, 0, 80, forward=32)
    after = context(r, oid)
    # Generic navigation progress used to accept these unrelated changes.
    after.update(position_m=[.01,.32], heading_deg=90)
    assert grasp_identity_change(before, after) is None
    assert not after['grasp_identity_authorized']
    action = {'action':'pick','params':{'object_id':oid}}
    key = ('pick', oid)
    r.navigation_progress = NavigationProgress()
    r.actions._manipulation_failure_context = lambda _: (key, after)
    r.navigation_progress.action_failures[key] = [{'reason':'grab_identity_competition','context':before}]
    result = r.actions.action_failure_guard(action)
    assert result['reason'] == 'action_repeat_without_new_evidence'
    assert r.perception._grab_authorizations == {}


def test_real_all_source_resolution_unlocks_identity_but_not_final_grab_geometry():
    r = runtime()
    see_world(r, 0, 80)
    old = r.perception.objects()[0]['id']
    r.bridge.seconds = 20
    publish(r)
    for forward in (0,16):
        see_world(r,0,80,forward=forward)
    oid = next(o['id'] for o in r.perception.objects() if o['state']=='TENTATIVE')
    before = context(r, oid)
    assert old in before['grasp_identity']['candidate_ids_by_detection'][0]
    see_world(r,0,80,forward=32)
    after = context(r, oid)
    assert grasp_identity_change(before, after) == 'perception_verified_competing_identities_resolved'
    assert after['grasp_identity']['verified_resolutions']
    key = ('pick', oid)
    r.navigation_progress = NavigationProgress()
    r.navigation_progress.action_failures[key] = [{'reason':'grab_identity_competition','context':before}]
    r.actions._manipulation_failure_context = lambda _: (key, after)
    assert r.actions.action_failure_guard({'action':'pick','params':{'object_id':oid}}) is None
    full = r.perception.authorize_grab(oid,r.snapshot,{
        'before_observation':r.snapshot['observation_index'],'bridge_sequence':7,'bridge_request_id':'brain-000007'})
    assert full['reason'] == 'grab_geometry_not_authorized'
    assert r.perception._grab_authorizations == {}


def test_smaller_current_matrix_without_verified_old_competitor_resolution_is_not_progress():
    r, oid, _ = confirmed_scene(old_x=8)
    before = context(r, oid)
    after = copy.deepcopy(before)
    # This is a comparison counterexample, not a fake Perception or a claim of
    # physical authorization: disappearing detections alone prove nothing.
    after['grasp_identity_authorized'] = True
    after['grasp_identity']['candidate_ids_by_detection'] = [[oid]]
    after['grasp_identity']['target_detection_indices'] = [0]
    assert grasp_identity_change(before, after) is None
