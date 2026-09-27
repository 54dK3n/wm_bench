"""Real Perception sees a target after exit alignment; preserve that view."""
import copy

from autonomous_brain.navigation import wrap
from test_brain_confirmation_sampling import sampling_runtime


def exit_runtime(category='red-ball', *, initially_visible=False, raw_near=False):
    runtime = sampling_runtime(target=(0, 88) if initially_visible else (-45 if raw_near else -88, 0))
    original = runtime.bridge.call
    def call(method, params=None):
        if method == 'local_road':
            road = original(method, params)
            road.update(atNode=True, atJunction=True,
                        exits=[{'angleDeg':wrap((0 if initially_visible else 90)-runtime.bridge.heading)}])
            return road
        if method == 'observe':
            data = original(method, params)
            data['detections'] = [dict(row, category=category) for row in data['detections']
                                  if row['bbox']['y']+row['bbox']['h']<=480]
            return data
        return original(method, params)
    runtime.bridge.call = call
    runtime.observe()
    return runtime


def test_new_target_seen_after_turn_is_given_back_before_take_exit():
    runtime=exit_runtime()
    assert not runtime.perception.objects()
    result=runtime.actions.explore(90)
    assert result['success'] and result['reason']=='target_sampling_opportunity_observed'
    assert [method for method,params in runtime.bridge.calls]==['turn']
    proof=result['evidence']['sampling_opportunity']
    assert proof['discovery_id'] and proof['new_effective_observation']
    obj=runtime.perception.objects()[0]
    assert obj['state']=='TENTATIVE' and obj['hit_count']==1
    assert runtime.snapshot['perception']['detections'][0]['fed_to_world_model']
    assert proof['after_observation']==runtime.snapshot['observation_index']


def test_unrelated_detection_does_not_interrupt_exit_selection():
    runtime=exit_runtime(category='blue-ball')
    result=runtime.actions.take_observed_exit(90, yield_for_discovery=True)
    assert not result.get('sampling_opportunity')
    assert [method for method,params in runtime.bridge.calls]==['turn','take_exit']


def test_window_rejected_target_does_not_claim_valid_sampling_opportunity():
    runtime=exit_runtime(raw_near=True)
    # Raw <40 after alignment is a real bbox but no accepted confirmation hit.
    result=runtime.actions.take_observed_exit(90, yield_for_discovery=True)
    assert not result.get('sampling_opportunity')
    assert [method for method,params in runtime.bridge.calls]==['turn','take_exit']


def test_existing_view_with_new_frame_only_does_not_yield_again():
    runtime=exit_runtime(initially_visible=True)
    before=copy.deepcopy(runtime.snapshot)
    result=runtime.actions.take_observed_exit(0, yield_for_discovery=True)
    assert not result.get('sampling_opportunity')
    assert before['perception']['detections'][0]['fed_to_world_model']
    assert [method for method,params in runtime.bridge.calls]==['take_exit']


def test_non_explore_exit_keeps_original_behavior():
    runtime=exit_runtime()
    runtime.actions.take_observed_exit(90)
    assert [method for method,params in runtime.bridge.calls]==['turn','take_exit']


def test_execute_retains_opportunity_only_with_fresh_post_action_pixels():
    runtime=exit_runtime()
    result=runtime.actions.execute({'action':'explore','params':{'exit_angle':90}})
    assert result['success'] and result['reason']=='target_sampling_opportunity_observed'
    assert result['evidence']['sampling_opportunity']['post_observation_retained']
    assert [method for method,params in runtime.bridge.calls]==['turn']


def test_execute_keeps_original_opportunity_but_reports_post_action_loss():
    runtime=exit_runtime();original=runtime.bridge.call
    def call(method,params=None):
        result=original(method,params)
        if method=='observe' and runtime.bridge.frame>=4:
            result['detections']=[]
        return result
    runtime.bridge.call=call
    result=runtime.actions.execute({'action':'explore','params':{'exit_angle':90}})
    assert not result['success'] and result['reason']=='target_sampling_opportunity_no_longer_visible'
    assert result['evidence']['sampling_opportunity']['new_effective_observation']
    assert not result['evidence']['sampling_opportunity']['post_observation_retained']
    assert [method for method,params in runtime.bridge.calls]==['turn']
