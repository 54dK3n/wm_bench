"""Every physical grab needs current public authorization, not past confirmation.

The actuator is synthetic, but pixel conversion, WorldModel, Actions and the
independent evidence consumer are production code. No simulator or model runs.
"""
import copy
import math

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.perception import Perception, calibrate_reading
from tools.brain_evidence_audit import audit_observed_ledger
from test_brain_pending_grasp_audit import GraspAuditRuntime
from test_brain_perception import CAMERA, ball
from test_brain_delivery_identity import storage_bbox
from test_brain_route_contract import normalize


class AuthorizationRuntime(GraspAuditRuntime):
    def __init__(self, *, fault=None, grab_results=(True,), delayed=False):
        self.fault = fault
        self.grab_results = grab_results
        self.grab_count = 0
        self.triggered = False
        self.override_items = None
        self.extra_items = []
        self.sensor_broken = False
        self.authorized_source = None
        super().__init__(delayed=delayed)

    def call(self, method, params):
        normalize(method, params)  # Actual frozen platform contract.
        result = super().call(method, params)
        if method == "grab":
            self.grab_count += 1
            self.holding = self.grab_results[min(self.grab_count - 1, len(self.grab_results)-1)]
            if self.fault == "unknown_receipt":
                self.bridge_records[-1].update(terminal=None, submission={"status":202,"body":{"status":"queued"}})
                raise ConnectionError("synthetic_grab_ack_loss")
            if self.fault == "unknown_receipt_and_sensor":
                self.sensor_broken = True
                self.bridge_records[-1].update(terminal=None, submission={"status":202,"body":{"status":"queued"}})
                raise ConnectionError("synthetic_grab_ack_loss")
        return result

    def observe(self, *, motion=None):
        if self.sensor_broken:
            raise ConnectionError("synthetic_sensor_unavailable")
        self.frame += 1
        method = (motion or {}).get("method")
        fault_now = (not self.triggered and method == "forward" and (
            self.fault == "approach_stale" and self.forward > 60 or self.fault == "retry_stale" and self.grab_count == 1
            or self.fault == "competition"))
        if fault_now:
            self.triggered = True
            if self.fault != "competition":
                self.bridge.seconds += 2
        if self.holding:
            items = ([{"category":"blue-ball","source":"virtual-cv","confidence":.9,
                       "bbox":{"x":1,"y":1,"w":638,"h":478}}] if self.delayed and self.round == 1 else [])
            items.append(storage_bbox(close=True))
        elif self.released:
            self.retreated = bool(method == "backward" or getattr(self, "retreated", False))
            items = [ball(45 if self.retreated else 20), storage_bbox(close=not self.retreated)]
        else:
            # A fixed public synthetic point, rendered through the frozen range
            # formula; no object identity or state is supplied to perception.
            h = math.radians(self.heading)
            x, z = -self.right, calibrate_reading(80, 0)[0] - self.forward
            local_x = math.cos(h) * x + math.sin(h) * z
            local_z = -math.sin(h) * x + math.cos(h) * z - 5.1557
            beta = math.atan2(local_x, local_z)
            reading = (math.hypot(local_x, local_z) - 1.6239) * math.cos(beta) / 1.0187
            red = ball(max(20, reading), bearing=math.degrees(beta)) if abs(beta) < math.radians(60) else None
            if red:
                red["bbox"]["y"] = 100
            items = ([red] if red and red["bbox"]["x"] >= 0
                     and red["bbox"]["x"] + red["bbox"]["w"] <= 640 else [])
            if fault_now and self.fault != "competition":
                items = []
            elif self.fault == "competition" and self.triggered:
                items = [red, copy.deepcopy(red)]
        if self.override_items is not None:
            items = copy.deepcopy(self.override_items)
        items.extend(copy.deepcopy(self.extra_items))
        raw = {"frameId":str(self.frame),"tick":self.frame,"width":640,"height":480,"detections":items}
        odo = {"tick":self.frame,"forwardCm":self.forward,"rightCm":self.right,
               "headingDeg":self.heading,"distanceCm":self.travelled}
        converted = self.perception.update(raw, odo, simulation_time_s=self.bridge.seconds,
                                          round_index=self.round, observation_index=self.frame)
        road = {"tick":self.frame,"onRoad":True,"atNode":False,"exits":[],"frontClearanceCm":100,
                "leftClearanceCm":20,"rightClearanceCm":20,"headingErrorDeg":0}
        self.snapshot = {"observation_index":self.frame,"round":self.round,"simulation_seconds":self.bridge.seconds,
            "observation":raw,"odometry":odo,"road":road,"holding":{"holding":self.holding},
            "perception":converted,"objects":self.perception.objects()}
        for name,key in (("odometry","odometry"),("local_road","road"),("holding","holding"),("observe","observation")):
            self.log_call(name, {}, self.snapshot[key])
        if hasattr(self,"actions"):
            self.actions.observe_pending_grasp(self.snapshot)
        self.observations.append(copy.deepcopy(self.snapshot))
        return self.snapshot

    def pick(self):
        return self.execute({"action":"pick","params":{"object_id":self.object_id}})

    def audit(self):
        return audit_observed_ledger({"runtime_version":"autonomous-brain-runtime/v18",
            "action_evidence":self.perception.action_evidence(), "final_objects":self.perception.objects()},
            self.observations, self.rounds, self.bridge_records, self.records)

    def become_stale(self):
        self.bridge.seconds += 2
        self.override_items = []
        self.observe()
        self.override_items = None
        assert self.perception.get_object(self.object_id)["state"] == "STALE"


def actual_grabs(runtime):
    return [c for c in runtime.bridge_records if c["request"]["method"] == "grab"]


def test_entry_stale_has_no_grab_and_keeps_discovery_identity():
    r = AuthorizationRuntime()
    r.become_stale()
    assert not r.pick()["success"]
    assert actual_grabs(r) == []
    assert r.perception.get_object(r.object_id)["state"] == "STALE"


def test_normal_real_confirmation_grab_and_release_has_independent_audit_chain():
    r = AuthorizationRuntime()
    assert r.pick()["success"]
    assert r.execute({"action":"place","params":{}})["success"]
    assert r.audit()["failures"] == []
    chain = r.perception.action_evidence()[0]["evidence"]["grasp_chain"]
    assert chain["grab"]["authorization"]["object"]["state"] == "CONFIRMED"
    assert chain["grab"]["authorization"]["observation_index"] == chain["grab"]["before_observation"]


def test_failed_grab_with_current_confirmation_can_retry_with_distinct_authorizations():
    r = AuthorizationRuntime(grab_results=(False, True))
    assert r.pick()["success"]
    assert len(actual_grabs(r)) == 2
    before = [m["before_observation"] for m in r.records if m["method"] == "grab"]
    assert len(set(before)) == 2
    assert all(next(o for o in r.observations if o["observation_index"] == index)["objects"][0]["state"] == "CONFIRMED" for index in before)
    attempts = r.rounds[0]["result"]["evidence"]["attempts"]
    assert len({a["grab_ref"]["authorization"]["command_ref"]["bridge_request_id"] for a in attempts}) == 2
    assert r.audit()["failures"] == []


@pytest.mark.parametrize("fault, expected_grabs", [("approach_stale",0),("retry_stale",1),("competition",0)])
def test_current_authorization_invalidated_during_motion_stops_this_pick(fault, expected_grabs):
    r = AuthorizationRuntime(fault=fault, grab_results=(False,True))
    outcome = r.pick()
    assert not outcome["success"]
    assert len(actual_grabs(r)) == expected_grabs
    assert r.held_object_id is None
    assert not r.perception.action_evidence()


def test_unknown_grab_ack_and_missing_readback_keeps_original_pending_reference():
    r = AuthorizationRuntime(fault="unknown_receipt_and_sensor")
    with pytest.raises(ConnectionError):
        r.pick()
    assert len(actual_grabs(r)) == 1
    assert r.pending_grasp is not None
    assert r.pending_grasp["grab_ref"]["bridge_request_id"] == actual_grabs(r)[0]["request"]["requestId"]
    r.sensor_broken = False
    r.fault = None
    r.observe()
    assert not r.pick()["success"]
    assert len(actual_grabs(r)) == 1
    assert r.pending_grasp["initial_readback_missing"]
    assert r.pending_grasp["continuity_broken"]
    assert not r.execute({"action":"place","params":{}})["success"]
    assert not r.perception.action_evidence()
    assert not any(c["request"]["method"] == "release" for c in r.bridge_records)


def test_historical_confirmation_without_command_authorization_cannot_mark_stale_held():
    r = AuthorizationRuntime()
    r.become_stale()
    row = r.perception.get_object(r.object_id)
    view = r.perception.original_position_evidence(tuple(row["position_m"][k] for k in ("x","z")), "red-ball")
    assert view["valid"]
    assert not r.perception.mark_picked(r.object_id, holding=True, original_position_absent=True,
        simulation_time_s=r.bridge.seconds, evidence={"holding":True,"original_position_observation":view})


def test_safe_recorded_return_does_not_promote_stale_but_new_evidence_and_decision_can_pick():
    r = AuthorizationRuntime(fault="approach_stale")
    failed = r.pick()
    restored = failed["evidence"]["authorization_recovery"]
    assert not failed["success"] and restored["success"]
    source = next(o for o in r.observations if o["observation_index"] == restored["source_observation"])
    assert r.forward == source["odometry"]["forwardCm"]
    assert r.perception.get_object(r.object_id)["state"] == "STALE"
    assert actual_grabs(r) == []
    old_hits = r.perception.get_object(r.object_id)["hit_count"]
    r.fault = None
    # A separate public, measured view; the restored old view itself adds no
    # hit. No internal WM flag, confidence, or identity is patched.
    for method, params in (("turn",{"angleDeg":90,"speed":30}),
                           ("backward",{"distanceCm":16,"speed":30}),
                           ("turn",{"angleDeg":-90,"speed":30})):
        r.actions.move(method, params)
    assert r.perception.confirmed(r.object_id)
    assert r.perception.get_object(r.object_id)["hit_count"] == old_hits + 1
    assert r.pick()["success"]
    assert len(actual_grabs(r)) == 1
    assert r.audit()["failures"] == []


def test_unknown_grab_ack_fresh_holding_can_only_reconcile_original_command_then_release():
    r = AuthorizationRuntime(fault="unknown_receipt", delayed=True)
    r.round = 1
    with pytest.raises(ConnectionError) as caught:
        r.actions.execute({"action":"pick","params":{"object_id":r.object_id}})
    r.rounds.append({"round":1,"action":{"action":"pick","params":{"object_id":r.object_id}},
        "result":{"success":False,"evidence":dict(caught.value.action_evidence,final_observation=r.frame)}})
    original = copy.deepcopy(r.pending_grasp["grab_ref"])
    r.fault = None
    assert not r.pick()["success"]
    assert r.pending_grasp["grab_ref"] == original
    assert len(actual_grabs(r)) == 1
    assert r.execute({"action":"place","params":{}})["success"]
    assert r.perception.action_evidence()[0]["evidence"]["grasp_chain"]["grab"] == original
    assert r.audit()["failures"] == []


@pytest.mark.parametrize("holding", [True, None])
def test_gripper_must_be_observed_empty(holding):
    r = AuthorizationRuntime()
    r.holding = holding
    r.observe()
    assert not r.pick()["success"]
    assert actual_grabs(r) == []


def test_restore_refuses_curved_distance_even_when_endpoints_look_collinear():
    r = AuthorizationRuntime(fault="approach_stale")
    original_call = r.bridge.call
    def travelled_curve(method, params):
        result = original_call(method, params)
        if method == "forward" and r.forward > 60:
            r.travelled += 2
        return result
    r.bridge.call = travelled_curve
    result = r.pick()
    assert not result["success"]
    recovery = result["evidence"]["authorization_recovery"]
    assert not recovery["success"] and recovery["motions"] == []
    assert not actual_grabs(r)
    assert not any(c["request"]["method"] == "backward" for c in r.bridge_records)


@pytest.mark.parametrize("fault", ["command", "source", "identity", "missing"])
def test_mark_picked_rejects_rewritten_authorization_from_a_real_pending_grasp(fault):
    r = AuthorizationRuntime(delayed=True)
    assert not r.pick()["success"]
    r.round = 2
    r.actions.move("backward", {"distanceCm":16, "speed":30})
    chain = r.actions.grasp_confirmation_chain(r.pending_grasp, "place", r.frame - 1)
    assert chain
    auth = chain["grab"]["authorization"]
    if fault == "command": chain["grab"]["bridge_request_id"] = "brain-999999"
    elif fault == "source": auth["observation_index"] -= 1
    elif fault == "identity": auth["object"]["state"] = "CONFIRMED"; auth["canonical_object_id"] = "another-ball"
    else: del chain["grab"]["authorization"]
    obj = r.perception.get_object(r.object_id)
    view = r.perception.original_position_evidence(tuple(obj["position_m"][k] for k in ("x","z")), "red-ball")
    assert view["valid"]
    assert not r.perception.mark_picked(r.object_id, holding=True, original_position_absent=True,
        simulation_time_s=r.bridge.seconds, evidence={"holding":True,"grasp_chain":chain,
                                                     "original_position_observation":view})
    assert r.pending_grasp and r.held_object_id is None


def test_unprojectable_storage_keeps_raw_competition_indices_without_blocking_real_grab():
    r = AuthorizationRuntime()
    r.extra_items = [{"category":"storage-zone", "source":"storage-ground-pixels", "confidence":1,
                      "bbox":{"x":310,"y":0,"w":20,"h":5}}]
    r.observe()
    assert r.snapshot["perception"]["detections"][-1]["reason"] == "ground_projection_invalid"
    assert r.pick()["success"]
    proof = r.perception.action_evidence()[0]["evidence"]["grasp_chain"]["grab"]["authorization"]
    assert len(proof["detections"]) == len(proof["candidate_ids_by_detection"]) == 2
    assert proof["candidate_ids_by_detection"][-1] == []
    assert r.audit()["failures"] == []
