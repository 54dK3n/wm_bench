"""Fixed public and evaluator-only native traces, never simulator output."""
import copy
import math


def line_fixture(one_way=False):
    # Units are deliberately 1 world unit/metre; the public forward axis is -Z.
    poses = [(0, 0, 0, 0), (0, 50, 0, 50), (0, 100, 0, 100)]
    if not one_way:
        poses += [(0, 100, -180, 100), (0, 50, -180, 150), (0, 0, -180, 200), (0, 0, 0, 200)]
    observations, motions, samples, bridge = [], [], [], []
    for i, (right, forward, heading, travelled) in enumerate(poses, 1):
        at_node = forward in (0, 100)
        angles = ([0 if forward == 0 else -180] if heading == 0 else [-180 if forward == 0 else 0]) if at_node else []
        if one_way and forward == 100: angles = []
        row = {"observation_index": i,
            "observation": {"frameId": "topology-"+str(i), "tick": i, "detections": []},
            "odometry": {"rightCm": right, "forwardCm": forward, "headingDeg": heading,
                         "distanceCm": travelled, "tick": i},
            "road": {"onRoad": True, "atNode": at_node, "tick": i,
                     "exits": [{"angleDeg": a} for a in angles]},
            "holding": {"holding": False}, "perception": {"detections": []}, "objects": []}
        observations.append(row)
        samples.append({"tick": i, "x": right/100, "z": -forward/100, "heading": 0 if heading == 0 else -3.1416})
        if i > 1:
            method = "turn" if i in (4, 7) else "take_exit" if i in (2, 5) else "follow_road"
            params = {"angleDeg": -180 if i == 4 else 180 if i == 7 else 0} if method != "follow_road" else {"distanceCm": 50}
            outcome = {"completed": True} if method == "turn" else {"accepted": True, "stoppedBy": "junction" if i in (3,6) else "distance"}
            m = {"before_observation": i-1, "after_observation": i, "method": method,
                 "params": params, "actuator_result": outcome}
            motions.append(m)
            bridge.append({"request": {"method": method, "params": copy.deepcopy(params)},
                           "terminal": {"status": "completed", "result": copy.deepcopy(outcome)}})
        for method, key in (("odometry","odometry"),("local_road","road"),("holding","holding"),("observe","observation")):
            bridge.append({"request": {"method": method, "params": {}},
                "terminal": {"status": "completed", "result": copy.deepcopy(row[key])}})
    def refs(first,last):
        return [{"before_observation": i,"after_observation": i+1} for i in range(first,last)]
    def proof(kind,a,b,tids=()):
        return {"kind":kind,"from_observation":a,"to_observation":b,"first_observation":a,"last_observation":b,
                "motion_refs":refs(a,b),"traversal_ids":list(tids)}
    anchors=[]
    for i in (1,3) if one_way else (1,3,4,6,7):
        o=observations[i-1]; n="A" if i in (1,6,7) else "B"
        anchors.append({"observation_index":i,"node_id":n,"candidate_ids":[],
            "position_m":[o["odometry"]["rightCm"]/100,o["odometry"]["forwardCm"]/100],
            "heading_deg":o["odometry"]["headingDeg"],"exit_bindings":[
                {"exit_id":n+"-exit","raw_angle_deg":e["angleDeg"]} for e in o["road"]["exits"]]})
    nodes=[{"id":"A","canonical_id":"A","status":"confirmed","anchor_indices":[1] if one_way else [1,6,7],"merge_evidence_refs":[]},
           {"id":"B","canonical_id":"B","status":"confirmed","anchor_indices":[3] if one_way else [3,4],"merge_evidence_refs":[]}]
    if not one_way:
        for name,canonical,index,p in (("B4","B",4,proof("continuous_node_episode",3,4)),
                ("A6","A",6,proof("structural_revisit",1,6,("T1","T2"))),
                ("A7","A",7,proof("continuous_node_episode",6,7))):
            nodes.append({"id":name,"canonical_id":canonical,"status":"alias","anchor_indices":[index],"merge_evidence_refs":[p]})
            next(n for n in nodes if n["id"]==canonical)["merge_evidence_refs"].append(copy.deepcopy(p))
    exits=[{"id":"A-exit","node_id":"A","state":"verified","heading_deg":0,
            "observation_refs":[1] if one_way else [1,6,7],"completion_traversal_ids":["T1"]}]
    if not one_way: exits.append({"id":"B-exit","node_id":"B","state":"verified","heading_deg":-180,
        "observation_refs":[3,4],"completion_traversal_ids":["T2"]})
    trips=[]
    for name,start,end,a,b in [("T1",1,3,"A","B")]+([] if one_way else [("T2",4,6,"B","A")]):
        trips.append({"id":name,"first_observation":start,"last_observation":end,
            "departure":{"observation_index":start,"node_id":a,"exit_id":a+"-exit","raw_angle":0},
            "arrival":{"observation_index":end,"node_id":b},"motion_refs":refs(start,end)})
    summary={"road_evidence":{"schema":"brain-road-evidence/v1","nodes":nodes,"anchors":anchors,
        "exits":exits,"traversals":trips,"unresolved":[]},
        "exploration_state":{"schema":"brain-road-exploration/v1","complete":True,"pending_exit_count":0,
            "state_counts":{"unexplored":0,"exploring":0,"verified":len(exits),"blocked":0,"unresolved":0},
            "unresolved_node_count":0,"unresolved_connection_count":0}}
    record={"native":{"ruleDefinition":{"unitsPerMeter":1,"vehicleRadius":0,
        "navigationJunctionRadiusCm":10,"roads":[{"id":"line","points":[[0,0],[0,-1]],"width":.2,"oneWay":one_way}]},
        "navigationDefinition":{"schemaVersion":"chenlong.navigation/v6","roadTopology":{"endpointSnapDigits":6}},
        "samples":samples}}
    captures=[{"frameId":o["observation"]["frameId"],"tick":o["observation"]["tick"],
        "robotWorldPose":{"x":o["odometry"]["rightCm"]/100,"z":-o["odometry"]["forwardCm"]/100,
                          "heading":math.radians(o["odometry"]["headingDeg"])},
        "odometryOrigin":{"x":0,"z":0,"heading":0},"worldUnitsToMeters":1} for o in observations]
    return summary,observations,motions,record,bridge,captures


def recorroborate(data):
    """After intentional tampering, also forge bridge copy to test deeper gates."""
    summary,observations,motions,record,bridge,captures=data
    rows=iter(observations)
    current=next(rows)
    by_pair={(m["before_observation"],m["after_observation"]):m for m in motions}
    for call in bridge:
        method=call["request"]["method"]
        key={"local_road":"road","observe":"observation"}.get(method,method)
        if method in {"odometry","local_road","holding","observe"}:
            call["terminal"]["result"]=copy.deepcopy(current[key])
            if method=="observe": current=next(rows,None)
        else:
            m=by_pair[(current["observation_index"]-1,current["observation_index"])]
            call["request"]=copy.deepcopy({"method":m["method"],"params":m["params"]})
            call["terminal"]["result"]=copy.deepcopy(m["actuator_result"])


def use_real_brain_evidence(data):
    from autonomous_brain.navigation import RoadMemory
    summary,observations,motions,_,_,_=data
    memory=RoadMemory()
    by_after={m["after_observation"]:m for m in motions}
    for index,o in enumerate(observations):
        motion=by_after.get(index+1)
        if motion and motion["method"]=="take_exit":
            before=observations[index-1]
            memory.chosen(before["odometry"],motion["params"]["angleDeg"],observation_index=index)
        memory.update(o["odometry"],o["road"],observation_index=index+1)
        memory.observe_traversal(o,motion)
    summary["road_evidence"]=memory.road_evidence()
    summary["exploration_state"]=memory.exploration_status()
    return data


def triangle_fixture():
    summary,observations,motions,record,bridge,captures=line_fixture()
    record["native"]["ruleDefinition"]["roads"]=[
        {"id":"AB","points":[[0,0],[0,-1]],"width":.2,"oneWay":True},
        {"id":"BC","points":[[0,-1],[1,-1]],"width":.2,"oneWay":True},
        {"id":"CA","points":[[1,-1],[0,0]],"width":.2,"oneWay":True}]
    poses=[(0,0,0,0,[0]),(0,50,0,50,[]),(0,100,0,100,[-90]),
        (50,100,-90,150,[]),(100,100,-90,200,[-135]),
        (50,50,135,270.7,[]),(0,0,135,341.4,[-135])]
    observations.clear();motions.clear();bridge.clear();captures.clear();record["native"]["samples"].clear()
    for i,(x,z,h,d,exits) in enumerate(poses,1):
        o={"observation_index":i,"observation":{"frameId":"ring-"+str(i),"tick":i,"detections":[]},
            "odometry":{"rightCm":x,"forwardCm":z,"headingDeg":h,"distanceCm":d,"tick":i},
            "road":{"tick":i,"onRoad":True,"atNode":bool(exits),"exits":[{"angleDeg":a} for a in exits]},
            "holding":{"holding":False},"perception":{"detections":[]},"objects":[]}
        observations.append(o)
        pose={"x":x/100,"z":-z/100,"heading":math.radians(h)}
        record["native"]["samples"].append({"tick":i,**{k:round(v,4 if k=="heading" else 6) for k,v in pose.items()}})
        captures.append({"frameId":"ring-"+str(i),"tick":i,"robotWorldPose":pose,
            "odometryOrigin":{"x":0,"z":0,"heading":0},"worldUnitsToMeters":1})
        if i>1:
            method="take_exit" if i in (2,4,6) else "follow_road"
            params={"angleDeg":{2:0,4:-90,6:-135}[i]} if method=="take_exit" else {"distanceCm":50}
            outcome={"accepted":True,"stoppedBy":"junction" if exits else "distance"}
            motions.append({"before_observation":i-1,"after_observation":i,"method":method,"params":params,"actuator_result":outcome})
            bridge.append({"request":{"method":method,"params":copy.deepcopy(params)},"terminal":{"status":"completed","result":copy.deepcopy(outcome)}})
        for method,key in (("odometry","odometry"),("local_road","road"),("holding","holding"),("observe","observation")):
            bridge.append({"request":{"method":method,"params":{}},"terminal":{"status":"completed","result":copy.deepcopy(o[key])}})
    return use_real_brain_evidence((summary,observations,motions,record,bridge,captures))


def nonroad_return_fixture():
    data=line_fixture()
    summary,observations,motions,record,bridge,captures=data
    for i,x,h,travel,method,params in [(8,0,90,200,"turn",{"angleDeg":90}),
        (9,-20,90,220,"forward",{"distanceCm":20}),(10,0,90,240,"backward",{"distanceCm":20}),
        (11,0,0,240,"turn",{"angleDeg":-90})]:
        o={"observation_index":i,"observation":{"frameId":"topology-"+str(i),"tick":i,"detections":[]},
            "odometry":{"rightCm":x,"forwardCm":0,"headingDeg":h,"distanceCm":travel,"tick":i},
            "road":{"tick":i,"onRoad":x==0,"atNode":x==0,"exits":[{"angleDeg":-h}] if x==0 else []},
            "holding":{"holding":False},"perception":{"detections":[]},"objects":[]}
        observations.append(o)
        pose={"x":x/100,"z":0,"heading":math.radians(h)}
        record["native"]["samples"].append({"tick":i,**{k:round(v,4 if k=="heading" else 6) for k,v in pose.items()}})
        captures.append({"frameId":"topology-"+str(i),"tick":i,"robotWorldPose":pose,
            "odometryOrigin":{"x":0,"z":0,"heading":0},"worldUnitsToMeters":1})
        outcome={"completed":True}
        motions.append({"before_observation":i-1,"after_observation":i,"method":method,"params":params,"actuator_result":outcome})
        bridge.append({"request":{"method":method,"params":copy.deepcopy(params)},"terminal":{"status":"completed","result":copy.deepcopy(outcome)}})
        for method,key in (("odometry","odometry"),("local_road","road"),("holding","holding"),("observe","observation")):
            bridge.append({"request":{"method":method,"params":{}},"terminal":{"status":"completed","result":copy.deepcopy(o[key])}})
    return use_real_brain_evidence(data)
