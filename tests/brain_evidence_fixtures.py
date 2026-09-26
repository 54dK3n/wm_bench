"""Small public-sensor transcript; no map geometry or external services."""
import copy
import hashlib
import json

from autonomous_brain.task import parse_task, completion_progress


def task_fixture():
    observations, motions, rounds, events = [], [], [], []
    objects = [{"id": oid, "category": "red-ball", "state": "CONFIRMED", "ever_confirmed": True}
               for oid in ("red-a", "red-b")]
    zone = {"category": "storage-zone", "bbox": {"x": 150, "y": 230, "w": 200, "h": 40}}
    balls = [{"category": "red-ball", "bbox": {"x": x, "y": 220, "w": 30, "h": 30},
              "position_m": {"x": x / 100, "z": 1}}
             for x in (200, 280)]

    def observe(round_number, holding, detections=()):
        index = len(observations) + 1
        converted = [dict(copy.deepcopy(d), frame_id=str(index)) for d in detections]
        raw = [{"category": d["category"], "bbox": copy.deepcopy(d["bbox"])} for d in detections]
        observations.append({"observation_index": index, "round": round_number,
            "simulation_seconds": index * .2, "odometry": {"tick": index * 10},
            "observation": {"frameId": index, "tick": index * 10, "width": 640, "height": 480, "detections": raw},
            "perception": {"detections": converted}, "holding": {"holding": holding}, "objects": copy.deepcopy(objects)})
        return index

    def motion(round_number, method, before, after):
        motions.append({"round": round_number, "method": method, "params": {},
            "before_observation": before, "after_observation": after, "actuator_result": {"accepted": True}})

    for i, obj in enumerate(objects):
        r, oid = i * 2 + 1, obj["id"]
        start = observe(r, False)
        obj["state"] = "HELD"
        picked = observe(r, True)
        motion(r, "grab", start, picked)
        final = observe(r, True)
        basis = {"holding": True, "post_observation": picked}
        events.append({"action": "pick", "object_id": oid, "holding": True, "original_position_absent": True,
                       "evidence": copy.deepcopy(basis)})
        rounds.append({"round": r, "action": {"action": "pick", "params": {"object_id": oid}},
            "state": {"robot": {"held_object_id": None}}, "result": {"success": True,
            "evidence": dict(basis, object_id=oid, before_observation=start, final_observation=final)}})
        r += 1
        start = observe(r, True)
        released = observe(r, False)
        motion(r, "release", start, released)
        obj["state"] = "RELEASED_UNVERIFIED"
        dets = [dict(balls[j], track_id=objects[j]["id"], known_delivered_object_id=objects[j]["id"]) for j in range(i)]
        dets += [balls[i], zone]
        witnessed = observe(r, False, dets)
        release = {"frame_id": released, "simulation_time_s": released * .2,
                   "preexisting_ball_ids": sorted(o["id"] for o in objects if o["id"] != oid)}
        placement = {"frame_id": witnessed, "ball_category": "red-ball", "ball_track_id": None,
                     "ball_bbox": copy.deepcopy(balls[i]["bbox"]), "ball_position_m": copy.deepcopy(balls[i]["position_m"]),
                     "storage_bbox": copy.deepcopy(zone["bbox"])}
        basis = {"holding": False, "post_observation": witnessed, "release_observation": release,
                 "placement": placement, "candidate_witnesses": 1}
        events.append({"action": "place", "object_id": oid, "holding": False, "ball_in_storage": True,
                       "simulation_time_s": witnessed * .2, "evidence": copy.deepcopy(basis)})
        obj["state"] = "DELIVERED"
        final = observe(r, False, dets)
        rounds.append({"round": r, "action": {"action": "place", "params": {}},
            "state": {"robot": {"held_object_id": oid}}, "result": {"success": True,
            "evidence": dict(copy.deepcopy(basis), object_id=oid, before_observation=start, final_observation=final)}})
    before, final = observe(5, False), observe(5, False)
    spec = parse_task("把两个红球送到绿色存放区")
    summary = {"task": spec["source_instruction"], "task_spec": spec, "action_evidence": events,
        "final_objects": copy.deepcopy(objects), "held_object_id": None, "pending_grasp": None,
        "junction_history": [{"exits": [{"completed": False}]}]}
    progress = completion_progress(objects, events, spec, holding=False, nodes=1, unexplored=1)
    request = {"model": "deepseek-flash", "temperature": 0, "thinking": {"type": "disabled"}}
    done = {"action": "done", "params": {}}
    raw = json.dumps(done, separators=(",", ":"))
    call = {"call_index": 1, "action": done, "mode": "live", "request": request,
        "raw_output": raw, "transport_error": None, "validation_error": None,
        "request_sha256": hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        "response_body": json.dumps({"model": "deepseek-flash", "choices": [
            {"message": {"content": raw}, "finish_reason": "stop"}]})}
    rounds.append({"round": 5, "action": done, "state": {}, "llm_output": call,
        "result": {"success": True, "evidence": dict(progress, before_observation=before,
            after_observation=final, frame_id=final, tick=final * 10, holding=False)}})
    bridge = []
    for observation in observations:
        for move in motions:
            if move["after_observation"] == observation["observation_index"]:
                bridge.append({"request": {"requestId": str(len(bridge)), "method": move["method"], "params": move["params"]},
                    "terminal": {"status": "completed", "result": copy.deepcopy(move["actuator_result"])}})
        for method, result in (("holding", observation["holding"]), ("observe", observation["observation"])):
            bridge.append({"request": {"requestId": str(len(bridge)), "method": method, "params": {}},
                           "terminal": {"status": "completed", "result": copy.deepcopy(result)}})
    return summary, observations, rounds, [call], bridge, motions
