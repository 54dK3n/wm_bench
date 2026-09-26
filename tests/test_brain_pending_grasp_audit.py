"""Real Actions and Perception produce logs consumed by the independent audit.

Only public synthetic bbox/odometry/holding observations and deterministic fake
actuators are used. This is not a simulator run or a model replay.
"""
import copy
import math
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.perception import Perception
from tools.brain_evidence_audit import audit_observed_ledger
from test_brain_perception import CAMERA, ball
from test_brain_delivery_identity import storage_bbox


class GraspAuditRuntime:
    def __init__(self, *, delayed=True):
        self.perception=Perception(CAMERA)
        self.forward=0.;self.right=0.;self.heading=0.;self.travelled=0.
        self.holding=False;self.released=False;self.delayed=delayed
        self.round=0;self.frame=0;self.pending_grasp=None;self.held_object_id=None
        self.observations=[];self.records=[];self.bridge_records=[];self.rounds=[]
        self.motion_log=SimpleNamespace(write=lambda row:self.records.append(copy.deepcopy(row)))
        self.bridge=SimpleNamespace(sequence=0,seconds=0.,max_seconds=1200,call=self.call)
        self.roads=SimpleNamespace(nodes=[],unexplored=lambda:0)
        self.log_call("camera_parameters",{},CAMERA)
        for forward in (0,16,32):
            self.travelled+=abs(forward-self.forward);self.forward=forward;self.observe()
        self.object_id=self.perception.objects()[0]["id"]
        assert self.perception.confirmed(self.object_id)
        self.actions=Actions(self)

    def log_call(self, method, params, result, *, completed=True):
        self.bridge.sequence+=1
        self.bridge_records.append({"request":{"requestId":f"brain-{self.bridge.sequence:06d}","method":method,"params":copy.deepcopy(params)},
            "terminal":{"status":"completed" if completed else "failed","result":copy.deepcopy(result)}})

    def call(self, method, params):
        self.bridge.seconds+=.1
        if method=="grab": self.holding=True
        elif method=="release": self.holding=False;self.released=True
        elif method=="turn": self.heading=(self.heading+params["angleDeg"]+180)%360-180
        else:
            assert method in {"forward","backward"}
            cm=params["distanceCm"]*(1 if method=="forward" else -1)
            self.right-=math.sin(math.radians(self.heading))*cm
            self.forward+=math.cos(math.radians(self.heading))*cm
            self.travelled+=abs(cm)
        result={"completed":True}
        self.log_call(method,params,result)
        return result

    def observe(self, *, motion=None):
        self.frame+=1
        if self.holding:
            items=([{"category":"blue-ball","source":"virtual-cv","confidence":.9,
                     "bbox":{"x":1,"y":1,"w":638,"h":478}}] if self.delayed and self.round==1 else [])
            items.append(storage_bbox(close=True))
        elif self.released:
            after_retreat=motion and motion.get("method")=="backward" or getattr(self,"retreated",False)
            self.retreated=bool(after_retreat)
            items=[ball(45 if after_retreat else 20),storage_bbox(close=not after_retreat)]
        else: items=[ball(max(20,80-self.forward))]
        raw={"frameId":str(self.frame),"tick":self.frame,"width":640,"height":480,"detections":items}
        odo={"tick":self.frame,"forwardCm":self.forward,"rightCm":self.right,"headingDeg":self.heading,"distanceCm":self.travelled}
        converted=self.perception.update(raw,odo,simulation_time_s=self.bridge.seconds,round_index=self.round)
        road={"tick":self.frame,"onRoad":True,"atNode":False,"exits":[],"frontClearanceCm":100,
              "leftClearanceCm":20,"rightClearanceCm":20,"headingErrorDeg":0}
        self.snapshot={"observation_index":self.frame,"round":self.round,"simulation_seconds":self.bridge.seconds,
            "observation":raw,"odometry":odo,"road":road,"holding":{"holding":self.holding},
            "perception":converted,"objects":self.perception.objects()}
        for method,key in (("odometry","odometry"),("local_road","road"),("holding","holding"),("observe","observation")):
            self.log_call(method,{},self.snapshot[key])
        # The live Runtime's hook records the same post-command sensor evidence.
        if hasattr(self,"actions"):
            self.actions.observe_pending_grasp(self.snapshot)
        self.observations.append(copy.deepcopy(self.snapshot))
        return self.snapshot

    def execute(self, action):
        self.round+=1
        before=copy.deepcopy(self.snapshot)
        outcome=self.actions.execute(action)
        self.rounds.append({"round":self.round,"action":copy.deepcopy(action),
            "state":{"robot":{"held_object_id":None if action["action"]=="pick" else self.object_id}},
            "result":copy.deepcopy(outcome)})
        return outcome

    def audit(self):
        return audit_observed_ledger({"action_evidence":self.perception.action_evidence(),
            "runtime_version":"autonomous-brain-runtime/v15", "final_objects":self.perception.objects()},
            self.observations,self.rounds,self.bridge_records,self.records)


def chain(delayed=True):
    runtime=GraspAuditRuntime(delayed=delayed)
    pick=runtime.execute({"action":"pick","params":{"object_id":runtime.object_id}})
    assert pick["success"] is (not delayed),pick
    if delayed:
        assert runtime.pending_grasp and runtime.held_object_id is None
    place=runtime.execute({"action":"place","params":{}})
    assert place["success"],place
    return runtime


def test_same_action_pick_and_release_positive_control():
    runtime=chain(False)
    assert runtime.audit()["failures"]==[]


def test_delayed_pick_confirmed_by_actual_place_preserves_command_identity_chain():
    runtime=chain(True)
    assert runtime.audit()["failures"]==[]


@pytest.mark.parametrize("fault",["no-grab","wrong-object","old-frame","unknown-holding","drop",
    "unknown-command","wrong-confirm-action","missing-chain","false-absence","interrupted-before-release"])
def test_delayed_confirmation_audit_rejects_broken_original_command_identity_chain(fault):
    runtime=chain(True)
    event=runtime.perception._action_evidence[0]
    proof=event["evidence"]["grasp_chain"]
    after=proof["grab"]["after_observation"];confirmed=proof["confirmation"]["observation_index"]
    if fault=="no-grab":
        runtime.bridge_records[:]=[c for c in runtime.bridge_records if c["request"]["method"]!="grab"]
    elif fault=="wrong-object": proof["grab"]["object_id"]="other-object"
    elif fault=="old-frame": proof["confirmation"]["frame_id"]=proof["holding_observations"][0]["frame_id"]
    elif fault in {"unknown-holding","drop"}:
        runtime.observations[after]["holding"]["holding"]=None if fault=="unknown-holding" else False
    elif fault=="unknown-command":
        command=next(c for c in runtime.bridge_records if c["request"]["method"]=="grab")
        command["terminal"]=None
    elif fault=="wrong-confirm-action": runtime.rounds[-1]["action"]["action"]="look_around"
    elif fault=="missing-chain": del event["evidence"]["grasp_chain"]
    elif fault=="false-absence": event["evidence"]["original_position_observation"]["projected_bbox"]["x"]+=1
    else:
        runtime.observations[confirmed]["holding"]["holding"]=False
    assert runtime.audit()["failures"]


@pytest.mark.parametrize("holding",[False,None])
def test_actual_actions_do_not_recover_pending_identity_after_holding_interruption(holding):
    runtime=GraspAuditRuntime(delayed=True)
    assert not runtime.execute({"action":"pick","params":{"object_id":runtime.object_id}})["success"]
    runtime.holding=holding;runtime.observe()
    runtime.holding=True;runtime.observe()
    outcome=runtime.execute({"action":"place","params":{}})
    assert not outcome["success"] and outcome["reason"]=="grasp_command_or_holding_chain_unresolved"
    assert runtime.pending_grasp["continuity_broken"]
    assert not runtime.perception.action_evidence()
    assert not any(c["request"]["method"]=="release" for c in runtime.bridge_records)


def test_unknown_grab_ack_can_reconcile_only_with_receipt_and_fresh_observed_effect():
    runtime=GraspAuditRuntime(delayed=True)
    normal=runtime.bridge.call
    def lose_ack(method,params):
        result=normal(method,params)
        if method=="grab":
            runtime.bridge_records[-1].update(terminal=None,submission={"status":202,"body":{"status":"queued"}})
            raise ConnectionError("synthetic_ack_loss")
        return result
    runtime.bridge.call=lose_ack
    runtime.round=1;before=runtime.frame
    with pytest.raises(ConnectionError) as caught:
        runtime.actions.execute({"action":"pick","params":{"object_id":runtime.object_id}})
    runtime.rounds.append({"round":1,"action":{"action":"pick","params":{"object_id":runtime.object_id}},
        "result":{"success":False,"evidence":dict(caught.value.action_evidence,final_observation=runtime.frame)}})
    assert runtime.pending_grasp and len([c for c in runtime.bridge_records if c["request"]["method"]=="grab"])==1
    runtime.bridge.call=normal
    result=runtime.execute({"action":"place","params":{}})
    assert result["success"],result
    assert runtime.audit()["failures"]==[]
    next(c for c in runtime.bridge_records if c["request"]["method"]=="grab")["submission"]=None
    assert runtime.audit()["failures"]


@pytest.mark.parametrize('wrong_identity',[False,True])
def test_one_actual_grab_cannot_verify_duplicate_events_or_two_identities(wrong_identity):
    runtime=chain(True)
    original=copy.deepcopy(runtime.perception._action_evidence[0])
    if wrong_identity:
        original['object_id']='another-object'
        original['evidence']['grasp_chain']['object_id']='another-object'
    runtime.perception._action_evidence.insert(1,original)
    result=runtime.audit()
    assert result['picks'][0]['verified'] is True
    assert result['picks'][1]['verified'] is False
    assert 'pick_command_identity_confirmation_chain_invalid' in result['failures']
