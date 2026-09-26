"""Actual Perception/Runtime discovery ledgers checked from their raw sources."""
import copy
import pytest

from test_brain_recovery_discovery import runtime,publish
from test_brain_perception import CAMERA,ball
from tools.brain_evidence_audit import audit_unknown_discoveries


def observed_trace(*, resolve=True, competing=False):
    r=runtime();observations=[]
    r.observation_log.write=lambda o:observations.append(copy.deepcopy(o))
    publish(r,95,items=[ball(95),ball(95)] if competing else None)
    if resolve:
        for forward in (16,32,48):publish(r,95-forward,forward=forward)
    else:publish(r)
    summary={"runtime_version":"autonomous-brain-runtime/v15","discovery_evidence":r.perception.discovery_evidence(),
        "final_objects":r.perception.objects(),"action_evidence":r.perception.action_evidence()}
    bridge=[{"request":{"method":"camera_parameters"},"terminal":{"status":"completed","result":CAMERA}}]
    return summary,observations,bridge,[]


def test_real_independent_views_resolve_plain_discovery_without_claiming_delivery():
    data=observed_trace()
    result=audit_unknown_discoveries(*data)
    assert result["failures"]==[],result
    assert len(result["evidence"]["resolutions"])==1
    assert result["evidence"]["unresolved"]==[]
    assert data[0]["final_objects"][0]["state"]=="CONFIRMED"


def test_empty_later_frame_preserves_plain_untracked_obligation():
    result=audit_unknown_discoveries(*observed_trace(resolve=False))
    assert "discovery_historical_obligations_unresolved" in result["failures"]


def test_competing_original_boxes_cannot_both_be_explained_by_one_successor():
    result=audit_unknown_discoveries(*observed_trace(competing=True))
    assert "discovery_historical_obligations_unresolved" in result["failures"]
    assert not result["evidence"]["resolutions"]


@pytest.mark.parametrize("fault",["source-box","source-drop","one-view","matrix-rival","fake-hit","wrong-identity","raw-delete","intervening-grab"])
def test_discovery_resolution_tampering_is_independently_rejected(fault):
    data=observed_trace();summary,observations,bridge,motions=data
    resolution=summary["discovery_evidence"]["resolutions"][0]
    if fault=="source-box":summary["discovery_evidence"]["records"][0]["bbox"]["x"]+=10
    elif fault=="source-drop":summary["discovery_evidence"]["records"].pop(0)
    elif fault=="one-view":resolution["support_refs"]=resolution["support_refs"][:1]
    elif fault=="matrix-rival":resolution["candidate_matrix"][resolution["discovery_id"]].append("other")
    elif fault=="fake-hit":resolution["confirmation_evidence"]["hit_poses"][0]["frame_id"]="old-missing"
    elif fault=="wrong-identity":resolution["canonical_object_id"]="wrong"
    elif fault=="raw-delete":observations[0]["observation"]["detections"]=[]
    else:motions.append({"method":"grab","before_observation":1,"after_observation":2})
    assert audit_unknown_discoveries(*data)["failures"]


def lifecycle_trace(scenario):
    """Replay the real sensor/gripper fixtures, retaining every raw observation."""
    from unittest.mock import patch
    import test_brain_recovery_discovery as recovery
    captured=[]
    factory=recovery.runtime
    def record_runtime(*args,**kwargs):
        result=factory(*args,**kwargs)
        captured.append(result)
        return result
    with patch.object(recovery,'runtime',side_effect=record_runtime):
        getattr(recovery,scenario)()
    assert len(captured)==1
    r=captured[0]
    summary={'runtime_version':'autonomous-brain-runtime/v15',
        'discovery_evidence':r.perception.discovery_evidence(),
        'final_objects':r.perception.objects(),'action_evidence':r.perception.action_evidence()}
    bridge=[{'request':{'method':'camera_parameters'},
             'terminal':{'status':'completed','result':CAMERA}}]
    return summary,r.trace,bridge,r.motion_trace


@pytest.mark.parametrize('scenario',[
    'test_retired_tentative_source_is_explained_only_after_new_confirmation_and_delivery',
    'test_delivered_ball_occluded_then_reobserved_resolves_far_source_without_new_label',
    'test_new_release_near_old_delivery_resolves_only_after_same_frame_separation_and_views',
    'test_plain_discovery_and_retired_tentative_views_share_proven_successor',
])
def test_real_recovery_lifecycle_is_independently_reconstructed(scenario):
    result=audit_unknown_discoveries(*lifecycle_trace(scenario))
    assert result['failures']==[],result
    assert result['evidence']['unresolved']==[]


def test_real_late_boundary_revokes_active_resolution_and_retains_original_proof():
    r=runtime()
    publish(r,95)
    for forward in (16,32,48):publish(r,95-forward,forward=forward)
    old=copy.deepcopy(r.perception.discovery_evidence()['resolutions'][0])
    r.perception.note_manipulation_boundary({'method':'grab','before_observation':1},2)
    summary={'runtime_version':'autonomous-brain-runtime/v15','discovery_evidence':r.perception.discovery_evidence(),
        'final_objects':r.perception.objects(),'action_evidence':r.perception.action_evidence()}
    bridge=[{'request':{'method':'camera_parameters'},'terminal':{'status':'completed','result':CAMERA}}]
    result=audit_unknown_discoveries(summary,r.trace,bridge,[])
    assert result['evidence']['resolutions']==[]
    assert result['evidence']['unresolved']
    assert result['failures']==['discovery_historical_obligations_unresolved'],result
    assert summary['discovery_evidence']['resolution_revocations'][0]['resolution']==old
    summary['discovery_evidence']['resolution_revocations']=[]
    result=audit_unknown_discoveries(summary,r.trace,bridge,[])
    assert 'discovery_resolution_history_deleted' in result['failures']


def test_original_resolution_cannot_be_deleted_without_a_verified_revocation():
    summary,observations,bridge,motions=observed_trace()
    summary['discovery_evidence']['resolutions']=[]
    summary['discovery_evidence']['unresolved']=[summary['discovery_evidence']['records'][0]]
    result=audit_unknown_discoveries(summary,observations,bridge,motions)
    assert not result['evidence']['resolutions']
    assert 'discovery_resolution_history_deleted' in result['failures']


@pytest.mark.parametrize('unknown',[False,True])
def test_original_bridge_gripper_cannot_be_hidden_by_deleting_motion_and_boundary_ledgers(unknown):
    summary,observations,bridge,motions=observed_trace()
    for index,o in enumerate(observations):
        bridge.append({'request':{'method':'observe'},'terminal':{'status':'completed','result':copy.deepcopy(o['observation'])}})
        if index==0:
            bridge.append({'request':{'method':'grab','params':{}},
                'terminal':None if unknown else {'status':'completed','result':{'completed':True}}})
    result=audit_unknown_discoveries(summary,observations,bridge,motions)
    assert 'discovery_resolution_not_independently_verified' in result['failures']
    assert result['evidence']['resolutions']==[]
