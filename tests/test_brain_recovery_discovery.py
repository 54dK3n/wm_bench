"""Discovery recovery through public pixels, real Runtime.state and Actions.done.

Only road completion is isolated: these tests exercise object obligations, while
the separate road tests prove the public traversal ledger. No model or simulator.
"""
import copy
import math
from types import SimpleNamespace

import pytest

from autonomous_brain import run
from autonomous_brain.actions import Actions
from autonomous_brain.task import parse_task
from test_brain_perception import CAMERA, Perception, ball, observe, grasp_evidence
from autonomous_brain.perception import RANGE_CAL


COMPLETE_ROADS = {"schema": "brain-road-exploration/v1", "complete": True,
    "pending_exit_count": 0, "unresolved_node_count": 0, "unresolved_connection_count": 0,
    "state_counts": {"unexplored": 0, "exploring": 0, "verified": 2, "blocked": 0, "unresolved": 0}}


class PublicBridge:
    def __init__(self):
        self.frame = 0
        self.seconds = 0
        self.max_seconds = 1200
        self.items = []
        self.forward = self.right = self.heading = 0
        self.holding = False

    def call(self, method, params=None):
        if method in {"grab", "release"}:
            self.holding = method == "grab"
            return {"completed": True, "holding": self.holding, "tick": self.frame}
        if method == "odometry":
            self.frame += 1
            self.seconds += .1
            return {"tick": self.frame, "rightCm": self.right, "forwardCm": self.forward,
                    "headingDeg": self.heading, "distanceCm": abs(self.forward) + abs(self.right)}
        if method == "local_road":
            return {"tick": self.frame, "onRoad": True, "atNode": True,
                    "atJunction": False, "exits": [{"angleDeg": 0}], "frontClearanceCm": 100}
        if method == "holding":
            return {"holding": self.holding}
        if method == "observe":
            return {"frameId": str(self.frame), "tick": self.frame, "width": 640,
                    "height": 480, "detections": copy.deepcopy(self.items)}
        raise AssertionError("Sensor/gripper fixture received an unsupported motion")


def runtime(task="把地图上的红球都送到绿色存放区"):
    r = run.Runtime.__new__(run.Runtime)
    r.config, r.task_spec, r.round = {"task": task}, parse_task(task), 1
    r.perception, r.bridge = Perception(CAMERA), PublicBridge()
    r.observation_count, r.recent = 0, []
    r.held_object_id = r.pending_grasp = None
    r.roads = SimpleNamespace(nodes=[{}], update=lambda *a, **k: None,
        observe_traversal=lambda *a, **k: [], exploration_status=lambda: copy.deepcopy(COMPLETE_ROADS),
        unexplored=lambda: 0, summary=lambda: [], exits=lambda *a: [], frontier_hints=lambda *a, **k: [])
    r.trace, r.motion_trace = [], []
    r.observation_log = SimpleNamespace(write=lambda value: r.trace.append(copy.deepcopy(value)))
    r.motion_log = SimpleNamespace(write=lambda value: r.motion_trace.append(copy.deepcopy(value)))
    r.actions = Actions(r)
    return r


def publish(r, reading=None, *, forward=0, right=0, items=None):
    r.bridge.items = items if items is not None else ([] if reading is None else [ball(reading)])
    r.bridge.forward, r.bridge.right = forward, right
    return r.observe()


@pytest.mark.parametrize("reading", [25, 95, 140])
def test_plain_untracked_red_is_persistent_and_blocks_real_state_and_done(reading):
    r = runtime()
    current = publish(r, reading)
    item = current["perception"]["detections"][0]
    assert item["track_id"] is None and item["fed_to_world_model"] is False
    assert not item.get("identity_ambiguity")
    assert r.perception.objects() == []
    ledger = r.perception.discovery_evidence()
    assert len(ledger["unresolved"]) == 1
    assert r.state()["completion"]["ready_for_done"] is False
    publish(r)
    assert r.perception.discovery_evidence()["unresolved"]
    assert not r.actions.execute({"action": "done", "params": {}})["success"]


def test_new_confirmed_independent_views_can_explain_an_earlier_plain_discovery():
    r = runtime()
    publish(r, 95)
    original = copy.deepcopy(r.perception.discovery_evidence())
    for forward in (16, 32, 48):
        publish(r, 95-forward, forward=forward)
    row = next(x for x in r.perception.objects() if x["category"] == "red-ball")
    assert row["state"] == "CONFIRMED" and row["hit_count"] == 3
    ledger = r.perception.discovery_evidence()
    assert ledger.get("resolutions"), "A confirmed multi-view successor needs a legal resolver"
    assert not ledger["unresolved"]
    assert ledger["records"][:len(original["records"])] == original["records"]
    # Association explains discovery, but has not performed the task.
    assert not r.state()["completion"]["ready_for_done"]
    assert not r.actions.done()["success"]


def test_same_position_frames_do_not_resolve_or_promote_plain_discovery():
    r = runtime()
    for _ in range(6):
        publish(r, 95)
    ledger = r.perception.discovery_evidence()
    assert ledger["unresolved"]
    assert not ledger.get("resolutions")
    assert r.perception.objects() == []
    assert len({row["hypothesis_id"] for row in ledger["unresolved"]}) == 1


def test_same_frame_competing_boxes_cannot_share_one_confirmed_successor():
    r = runtime()
    publish(r, items=[ball(95), ball(95)])
    for forward in (16, 32, 48):
        publish(r, 95-forward, forward=forward)
    ledger = r.perception.discovery_evidence()
    assert len(ledger["unresolved"]) >= 2
    assert len({row["hypothesis_id"] for row in ledger["unresolved"]}) >= 2
    assert not ledger.get("resolutions")


def test_plain_current_red_cannot_be_hidden_by_a_stale_empty_discovery_query():
    r = runtime()
    publish(r, 25)
    r.perception.discovery_evidence = lambda: {"schema": "brain-discovery-evidence/v1", "unresolved": []}
    assert not r.state()["completion"]["ready_for_done"]
    assert not r.actions.done()["success"]


def world_ball(x_cm, z_cm, *, forward=0, right=0):
    """Invert the published M5 sensor calibration; no identity enters the brain."""
    x, z = x_cm-right, z_cm-forward-RANGE_CAL["L_cm"]
    beta = math.atan2(x, z)
    reading = ((math.hypot(x, z)-RANGE_CAL["a_cm"])*math.cos(beta)/RANGE_CAL["k"])
    return ball(reading, bearing=math.degrees(beta))


def see_world(r, x, z, *, forward=0, right=0, additional=()):
    return publish(r, forward=forward, right=right,
        items=[world_ball(x,z,forward=forward,right=right), *additional])


def deliver(r, oid, *, destination=300):
    """Exercise real lifecycle guards with raw empty-origin and release pixels."""
    target=r.perception.get_object(oid)
    if target['distance_cm'] > 85:
        see_world(r,target['position_m']['x']*100,target['position_m']['z']*100,
                  forward=target['position_m']['z']*100-60,right=target['position_m']['x']*100)
    original_forward, original_right = r.bridge.forward, r.bridge.right
    r.bridge.items=[]
    r.actions.move('grab',{})
    post=r.snapshot
    proof = grasp_evidence(r.perception, oid)
    proof["post_observation"] = post["observation_index"]
    assert r.perception.mark_picked(oid, holding=True, original_position_absent=True,
        simulation_time_s=r.bridge.seconds, evidence=proof)
    preexisting = [o["id"] for o in r.perception.objects()
                  if o["category"] == "red-ball" and o["id"] != oid]
    zone = {"category": "storage-zone", "source": "storage-ground-pixels", "confidence": 1,
            "bbox": {"x": 240, "y": 230, "w": 160, "h": 100}}
    publish(r,forward=destination)
    r.bridge.items=[ball(60),zone]
    r.actions.move('release',{})
    post=r.snapshot
    witness, storage = post["perception"]["detections"]
    release = {"frame_id": post["perception"]["frame_id"], "simulation_time_s": r.bridge.seconds,
               "preexisting_ball_ids": preexisting}
    evidence = {"holding": False, "candidate_witnesses": 1, "release_observation": release,
        "placement": {"ball_track_id": witness["track_id"], "ball_category": "red-ball",
            "ball_position_m": witness["position_m"], "ball_bbox": witness["bbox"],
            "storage_bbox": storage["bbox"], "frame_id": post["perception"]["frame_id"]}}
    assert r.perception.mark_delivered(oid, holding=False, ball_in_storage=True,
        simulation_time_s=r.bridge.seconds, evidence=evidence)


@pytest.mark.parametrize("source_z,views", [(40,(-25,-41,-57)), (200,(120,136,152))])
def test_near_or_clipped_far_discovery_resolves_then_real_delivery_done(source_z, views):
    r = runtime()
    see_world(r,0,source_z)
    original = copy.deepcopy(r.perception.discovery_evidence()["records"])
    for forward in views:
        see_world(r,0,source_z,forward=forward)
    assert not r.perception.discovery_evidence()["unresolved"]
    oid = next(x["id"] for x in r.perception.objects() if x["category"] == "red-ball")
    assert not r.state()["completion"]["ready_for_done"]
    deliver(r,oid)
    assert r.state()["completion"]["ready_for_done"]
    assert r.actions.execute({"action":"done","params":{}})["success"]
    assert r.perception.discovery_evidence()["records"][:len(original)] == original


def test_retired_tentative_source_is_explained_only_after_new_confirmation_and_delivery():
    r = runtime()
    see_world(r,0,80)
    old = r.perception.objects()[0]["id"]
    r.bridge.seconds = 20
    publish(r)
    assert r.perception.get_object(old)["state"] == "LOST"
    assert r.perception.get_object(old)["ever_confirmed"] is False
    assert not r.actions.done()["success"]
    for forward in (0,16,32):
        see_world(r,0,80,forward=forward)
    current = next(x["id"] for x in r.perception.objects() if x["state"] == "CONFIRMED")
    assert current != old and not r.perception.discovery_evidence()["unresolved"]
    assert not r.actions.done()["success"]
    deliver(r,current)
    assert r.perception.get_object(old)["state"] == "LOST"
    progress = r.state()["completion"]
    assert progress["resolved_discovery_hypotheses"] == {old:current}
    assert r.actions.execute({"action":"done","params":{}})["success"]


def test_known_two_done_keeps_quantity_scope_despite_unrelated_plain_discovery():
    r = runtime("把两个红球送到绿色存放区")
    for origin in (0,500):
        for offset in (0,16,32):
            see_world(r,0,origin+80,forward=origin+offset)
        oid = next(x["id"] for x in r.perception.objects() if x["state"] == "CONFIRMED")
        deliver(r,oid,destination=origin+300)
    publish(r,25,forward=1200)
    assert r.perception.discovery_evidence()["unresolved"]
    assert r.state()["completion"]["delivered_count"] == 2
    assert r.actions.execute({"action":"done","params":{}})["success"]
    r.task_spec=parse_task("把地图上的红球都送到绿色存放区")
    assert not r.actions.done()["success"]


def test_duplicate_camera_frame_rejected_without_new_source_or_resolution():
    r=runtime()
    publish(r,25)
    before=copy.deepcopy(r.perception.discovery_evidence())
    with pytest.raises(ValueError,match="only once"):
        r.perception.update(r.snapshot["observation"],r.snapshot["odometry"],
            simulation_time_s=r.bridge.seconds,observation_index=2)
    assert r.perception.discovery_evidence()==before


def test_model_discovery_summary_is_bounded_and_does_not_promote_actionable_objects():
    r=runtime()
    for index in range(9):
        publish(r,25,right=index*100)
    state=r.state()
    assert state["objects"]==[] and state["discovery"]["pending_count"]==9
    assert len(state["discovery"]["pending"])==6
    assert all("position_m" in row for row in state["discovery"]["pending"])


def test_two_distinct_same_frame_discoveries_need_two_separate_confirmed_identities():
    r=runtime()
    for forward in (0,16,32,48):
        publish(r,forward=forward,items=[world_ball(x,100,forward=forward) for x in (-30,30)])
    ledger=r.perception.discovery_evidence()
    first=[x for x in ledger['records'] if x['frame_id']=='1']
    assert len(first)==2
    resolutions={x['discovery_id']:x for x in ledger['resolutions']}
    assert len({resolutions[x['id']]['canonical_object_id'] for x in first})==2
    assert not ledger['unresolved'] and len(r.perception.objects())==2
    assert not r.actions.done()['success']


def test_position_near_a_confirmed_track_is_not_original_pixel_identity_evidence():
    r=runtime()
    see_world(r,0,100)
    for forward in (16,32,48):
        see_world(r,8,100,forward=forward)
    assert any(x['state']=='CONFIRMED' for x in r.perception.objects())
    assert r.perception.discovery_evidence()['unresolved']
    assert not r.perception.discovery_evidence()['resolutions']


def confirmed_and_delivered_runtime():
    r=runtime()
    for forward in (0,16,32):
        see_world(r,0,80,forward=forward)
    oid=r.perception.objects()[0]['id']
    deliver(r,oid)
    return r,oid


def test_delivered_ball_occluded_then_reobserved_resolves_far_source_without_new_label():
    r,old=confirmed_and_delivered_runtime()
    z=r.perception.get_object(old)['position_m']['z']*100
    source=see_world(r,0,z,forward=z-200)
    assert source['perception']['detections'][0]['track_id'] is None
    assert r.perception.discovery_evidence()['unresolved']
    publish(r,forward=z-200)
    for gap in (60,76):
        current=see_world(r,0,z,forward=z-gap)
        assert current['perception']['detections'][0]['known_delivered_object_id']==old
    assert not r.perception.discovery_evidence()['unresolved']
    assert len([x for x in r.perception.objects() if x['category']=='red-ball'])==1
    assert r.actions.execute({'action':'done','params':{}})['success']


def test_manipulation_boundary_forbids_explaining_an_earlier_ball_with_a_moved_delivery():
    r=runtime()
    # Discover an unexplained far red at the future delivery location first.
    # Moving another confirmed ball into the same pixels does not identify it.
    see_world(r,0,367.9016,forward=167.9016)
    first_id=r.perception.discovery_evidence()['unresolved'][0]['id']
    for forward in (0,16,32):
        see_world(r,0,80,forward=forward)
    oid=next(x['id'] for x in r.perception.objects() if x['state']=='CONFIRMED')
    deliver(r,oid)
    z=r.perception.get_object(oid)['position_m']['z']*100
    for gap in (60,76):
        see_world(r,0,z,forward=z-gap)
    assert first_id in {x['id'] for x in r.perception.discovery_evidence()['unresolved']}
    assert not r.actions.done()['success']


def release_near_old_runtime(separation=32, *, observed_old_x=0, aim_separation=None):
    r,old=confirmed_and_delivered_runtime()
    old_z=r.perception.get_object(old)['position_m']['z']*100
    for forward in (500,516,532):
        see_world(r,0,580,forward=forward)
    new=next(x['id'] for x in r.perception.objects() if x['state']=='CONFIRMED')
    r.bridge.items=[]
    r.actions.move('grab',{})
    post=r.snapshot
    proof=grasp_evidence(r.perception,new);proof['post_observation']=post['observation_index']
    assert r.perception.mark_picked(new,holding=True,original_position_absent=True,
        simulation_time_s=r.bridge.seconds,evidence=proof)
    assert r.perception.begin_release(new,{'x':(separation if aim_separation is None else aim_separation)/100,
                                          'z':old_z/100})
    forward,right=old_z-38,separation/2
    publish(r,forward=forward,right=right)
    r.bridge.items=[world_ball(x,old_z,forward=forward,right=right) for x in (observed_old_x,separation)]
    r.actions.move('release',{})
    post=r.snapshot
    release={'frame_id':post['perception']['frame_id'],'simulation_time_s':r.bridge.seconds,
        'preexisting_ball_ids':[x['id'] for x in r.perception.objects()
                                if x['category']=='red-ball' and x['id']!=new]}
    assert r.perception.mark_release_unverified(new,simulation_time_s=r.bridge.seconds,
        evidence={'holding':False,'release_observation':release,'required_delivered_ids':[old]})
    return r,old,new,old_z,release


def test_new_release_near_old_delivery_resolves_only_after_same_frame_separation_and_views():
    # The old observation initially competes with the intended release. The
    # distinct new raw candidate then anchors the unverified release, allowing
    # later same-frame views to distinguish both under unchanged gates.
    r,old,new,z,release=release_near_old_runtime(35,observed_old_x=3,aim_separation=32)
    assert r.snapshot['perception']['detections'][0]['identity_ambiguity']
    source_ids={x['id'] for x in r.perception.discovery_evidence()['unresolved']}
    assert source_ids and r.perception.get_object(new)['state']=='RELEASED_UNVERIFIED'
    zone={'category':'storage-zone','source':'storage-ground-pixels','confidence':1,
          'bbox':{'x':220,'y':230,'w':410,'h':150}}
    forward=z-60
    post=publish(r,forward=forward,items=[world_ball(x,z,forward=forward) for x in (3,35)]+[zone])
    old_view,witness,storage=post['perception']['detections']
    assert old_view['known_delivered_object_id']==old
    assert not witness.get('known_delivered_object_id') and not witness.get('identity_ambiguity')
    evidence={'holding':False,'candidate_witnesses':1,'release_observation':release,
        'placement':{'ball_track_id':witness['track_id'],'ball_category':'red-ball',
            'ball_position_m':witness['position_m'],'ball_bbox':witness['bbox'],
            'storage_bbox':storage['bbox'],'frame_id':post['perception']['frame_id']}}
    recovery=r.perception.recover_release(new,holding=False,simulation_time_s=r.bridge.seconds,evidence=evidence)
    assert recovery['resolved'], recovery
    assert source_ids <= {x['id'] for x in r.perception.discovery_evidence()['unresolved']}, 'One new view is insufficient'
    for reading in (68,84):
        # Additional public viewpoints with well-conditioned pixel range
        # support; the first recovery view alone is not a resolver shortcut.
        gap=RANGE_CAL['L_cm']+RANGE_CAL['a_cm']+RANGE_CAL['k']*reading
        forward=z-gap
        post=publish(r,forward=forward,items=[world_ball(x,z,forward=forward) for x in (3,35)]+[zone])
    assert {x.get('known_delivered_object_id') for x in post['perception']['detections']} >= {old,new}
    assert not r.perception.discovery_evidence()['unresolved']
    assert r.state()['completion']['delivered_count']==2
    assert r.actions.execute({'action':'done','params':{}})['success']


def test_close_release_competition_and_empty_views_cannot_discharge_discovery_or_release():
    r,old,new,z,release=release_near_old_runtime(separation=8)
    pending=copy.deepcopy(r.perception.discovery_evidence()['unresolved'])
    assert len(pending)>=2
    for _ in range(3):
        publish(r)
    assert r.perception.discovery_evidence()['unresolved'][:len(pending)]==pending
    assert r.perception.get_object(new)['state']=='RELEASED_UNVERIFIED'
    assert not r.actions.done()['success']


def test_unknown_manipulation_intent_blocks_new_geometry_but_keeps_prior_proof():
    r=runtime()
    publish(r,95)
    for forward in (16,32,48):
        publish(r,95-forward,forward=forward)
    old_proof=copy.deepcopy(r.perception.discovery_evidence()['resolutions'])
    assert old_proof
    r.perception.note_manipulation_boundary({'method':'grab','before_observation':r.observation_count,
                                            'outcome_unknown':True},None)
    assert r.perception.discovery_evidence()['resolutions']==old_proof
    publish(r,95,right=200)
    for forward in (16,32,48):
        publish(r,95-forward,forward=forward,right=200)
    ledger=r.perception.discovery_evidence()
    assert ledger['unresolved']
    assert ledger['resolutions']==old_proof
    assert ledger['motion_boundaries'][0]['after_observation'] is None


def test_late_grab_boundary_revokes_crossing_proof_without_deleting_original_sources():
    r=runtime()
    publish(r,95)
    for forward in (16,32,48):
        publish(r,95-forward,forward=forward)
    before=copy.deepcopy(r.perception.discovery_evidence())
    assert before['resolutions']
    r.perception.note_manipulation_boundary({'method':'grab','before_observation':1},2)
    after=r.perception.discovery_evidence()
    assert after['records']==before['records']
    assert after['resolutions']==[] and after['unresolved']
    assert after['resolution_revocations'][0]['resolution']==before['resolutions'][0]


def test_same_tick_manipulation_boundary_uses_observation_order():
    r=runtime()
    publish(r,95)
    for forward in (16,32,48):
        r.bridge.seconds=0
        publish(r,95-forward,forward=forward)
    assert r.perception.discovery_evidence()['resolutions']
    r.perception.note_manipulation_boundary({'method':'release','before_observation':1},2)
    assert r.perception.discovery_evidence()['unresolved']


def test_retired_discovery_needs_all_competing_sources_to_remain_distinct():
    r=runtime()
    publish(r,items=[world_ball(x,80) for x in (-.1,.1)])
    old={x['id'] for x in r.perception.objects()}
    assert len(old)==2
    r.bridge.seconds=20
    publish(r)
    for forward in (0,16,32):
        see_world(r,0,80,forward=forward)
    ledger=r.perception.discovery_evidence()
    assert {x['initial_object_id'] for x in ledger['unresolved']}>=old
    assert not ledger['resolutions']


def test_plain_discovery_and_retired_tentative_views_share_proven_successor():
    r=runtime()
    publish(r,95)
    publish(r,79,forward=16)
    old=r.perception.objects()[0]['id']
    r.bridge.seconds=20
    publish(r,forward=16)
    assert r.perception.get_object(old)['state']=='LOST'
    for forward in (16,32,48):
        publish(r,95-forward,forward=forward)
    ledger=r.perception.discovery_evidence()
    assert not ledger['unresolved']
    first=ledger['records'][:2]
    explanations={p['discovery_id']:p['canonical_object_id'] for p in ledger['resolutions']}
    assert explanations[first[0]['id']]==explanations[first[1]['id']]!=old
    assert r.perception.get_object(old)['state']=='LOST'
