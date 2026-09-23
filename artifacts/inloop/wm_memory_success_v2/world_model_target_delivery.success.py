# 广阳岛普通单局：道路图规划器
#
# 这不是“前进多少厘米、转多少度”的固定路线。它只使用公开接口：
# mission / task_state / release_preview / map_graph / road_state /
# follow_road / take_exit / observe / approach / grab / release / holding。
#
# 运行前提：普通单局（不是练习/筛选五局）并且地图已由服务端冻结。
# mission["objects"] 提供的是 role/roadId/progressCm 道路锚点，不是坐标；
# 代码仍自行做 Dijkstra、选择出口、循路、相机确认、抓取和安全投放。

import heapq, json, traceback

PROGRAM_VERSION = "wm-memory-v2-20260921"
print("GY " + json.dumps({"event": "program_version", "version": PROGRAM_VERSION}, ensure_ascii=False))


def road_blocked(road_id, reason="front_clearance"):
    """构造带 road_id 的 RuntimeError，避免 Pyodide 下自定义异常构造异常。"""
    error = RuntimeError(f"{reason}:{road_id}")
    error.road_id = road_id
    error.reason = reason
    return error


def _turn_around_and_block(road_id):
    """front_clearance 重试耗尽后掉头，并把当前行驶方向加入 blocked_directions。"""
    state = robot.road_state()
    edge = edge_by_road.get(road_id)
    if edge is not None:
        progress = float(state.get("roadProgressCm") or 0.0)
        length = float(edge["lengthCm"])
        if progress <= length / 2.0:
            blocked_directions.add((edge["fromNodeId"], edge["toNodeId"], road_id))
        else:
            blocked_directions.add((edge["toNodeId"], edge["fromNodeId"], road_id))
    robot.left_angle(180)

CRUISE_SPEED = 100  # 由道路控制逐 tick 自动钳制到当前道路/限速区的安全上限。
SLOW_SPEED = 30
NODE_NUDGE_CM = 2

mission = robot.mission()
graph = robot.map_graph()
mission_objects = [item for item in mission.get("objects", []) if isinstance(item, dict)]
distractor_anchors = [item for item in mission_objects if item.get("role") == "distractor"]
obstacle_anchors = [item for item in mission_objects if item.get("role") == "obstacle"]
if not obstacle_anchors:
    raise RuntimeError("本程序需要普通单局的任务道路锚点；私有五局不会提供它们")

edge_by_road = {edge["roadId"]: edge for edge in graph["edges"]}
adj = {node["nodeId"]: [] for node in graph["nodes"]}
for edge in graph["edges"]:
    adj[edge["fromNodeId"]].append((edge["toNodeId"], edge["roadId"], edge["lengthCm"]))
    if not edge["oneWay"]:
        adj[edge["toNodeId"]].append((edge["fromNodeId"], edge["roadId"], edge["lengthCm"]))

# 避开障碍物所在道路。是否绕行、选哪条替代路，仍由 Dijkstra 自己决定。
blocked_roads = {item["roadId"] for item in obstacle_anchors}
blocked_directions = set()
obstacle_progress_by_road = {}
for item in obstacle_anchors:
    obstacle_progress_by_road.setdefault(item["roadId"], []).append(float(item.get("progressCm", 0.0)))


def speed_for(road_id):
    # 目标速度由学生设定；follow_road 的第三个参数会在每个仿真 tick
    # 根据冻结道路和限速区自动钳制。这不会选择路线或出口。
    return CRUISE_SPEED


def endpoints(edge):
    if edge["oneWay"]:
        return [edge["fromNodeId"]]
    return [edge["fromNodeId"], edge["toNodeId"]]


def other_end(road_id, node_id):
    edge = edge_by_road[road_id]
    if edge["fromNodeId"] == node_id:
        return edge["toNodeId"]
    if edge["toNodeId"] == node_id and not edge["oneWay"]:
        return edge["fromNodeId"]
    raise RuntimeError("道路方向与图定义不兼容：" + road_id)


def dijkstra(start_node, goal_node, extra_blocked=None):
    """返回 (道路列表, 厘米)，路线由公开 graph 的 lengthCm 计算。"""
    forbidden = set(blocked_roads)
    if extra_blocked:
        forbidden.update(extra_blocked)
    distance = {start_node: 0}
    previous = {}
    closed = set()

    while True:
        current = None
        for node_id, value in distance.items():
            if node_id not in closed and (current is None or value < distance[current]):
                current = node_id
        if current is None or current == goal_node:
            break
        closed.add(current)
        for next_node, road_id, length_cm in adj[current]:
            if road_id in forbidden:
                continue
            if (current, next_node, road_id) in blocked_directions:
                continue
            candidate = distance[current] + length_cm
            if next_node not in distance or candidate < distance[next_node]:
                distance[next_node] = candidate
                previous[next_node] = (current, road_id)

    if goal_node not in distance:
        return None
    route = []
    node_id = goal_node
    while node_id != start_node:
        previous_node, road_id = previous[node_id]
        route.append(road_id)
        node_id = previous_node
    route.reverse()
    return route, distance[goal_node]


def align_to_current_road():
    """视觉接近后重新依据 road_state 校正到道路方向。"""
    state = robot.road_state()
    if not state["onRoad"]:
        raise RuntimeError("车辆已离开道路，停止规划")
    error = state["headingErrorDeg"]
    if error > 1:
        robot.left_angle(error)
    elif error < -1:
        robot.right_angle(-error)


def node_state():
    """只依赖道路控制抵达真实拓扑节点，并处理边界的单次低速前探。"""
    front_clearance_retries = 0
    for _ in range(14):
        state = robot.road_state()
        if state["atNode"]:
            return state
        align_to_current_road()
        result = robot.follow_road(500, speed_for(state["roadId"]), True)
        if result["stoppedBy"] == "front_clearance":
            # 局部安全停车可能是前一个被投放包裹或短时遮挡造成的。
            # 先低速后退并重新对齐同一道路，最多重试三次；仍无法前进时
            # 交由上层捕获并重新规划，避免把车卡死在同一条边上。
            front_clearance_retries += 1
            if front_clearance_retries > 3:
                road_id = state.get("roadId")
                print("GY_STAGE front_turnaround", road_id)
                _turn_around_and_block(road_id)
                result = robot.follow_road(500, speed_for(road_id), True)
                state = robot.road_state()
                if state["atNode"]:
                    return state
                raise road_blocked(road_id, "front_clearance_turnaround")
            robot.backward(NODE_NUDGE_CM)
            align_to_current_road()
            continue
        if result["stoppedBy"] not in ("max_distance", "junction", "road_end"):
            raise RuntimeError("抵达节点前被安全停止：" + result["stoppedBy"])
        state = robot.road_state()
        if state["atNode"]:
            return state
        # follow_road 在节点判定边界停车时，只允许一次受审计的 2cm 前探。
        if result["stoppedBy"] in ("junction", "road_end"):
            robot.forward(NODE_NUDGE_CM)
            state = robot.road_state()
            if state["atNode"]:
                return state
    raise RuntimeError("无法从道路状态确认图节点")


def enter_road(road_id):
    state = node_state()
    legal = {item["roadId"] for item in state["exits"]}
    if road_id not in legal:
        raise RuntimeError("规划道路不在当前合法出口中：" + road_id)
    result = robot.take_exit(road_id, CRUISE_SPEED, True)
    if not result["accepted"]:
        raise RuntimeError("进入道路失败：" + result["stoppedBy"])
    return result


def cross_road(road_id):
    """完整穿过一条图边；不会在遇到障碍时盲目转向。"""
    enter_road(road_id)
    for _ in range(20):
        result = robot.follow_road(500, speed_for(road_id), True)
        if result["stoppedBy"] == "max_distance":
            continue
        if result["stoppedBy"] in ("junction", "road_end"):
            return node_state()["nodeId"]
        if result["stoppedBy"] == "front_clearance":
            _turn_around_and_block(road_id)
            raise road_blocked(road_id, "front_clearance")
        raise RuntimeError("循路失败：" + result["stoppedBy"])
    raise RuntimeError("道路长度超过控制预算：" + road_id)


def go_to_node(goal_node, extra_blocked=None):
    """从 road_state 的真实节点出发，每穿过一条边就重新规划。

    圆形复合路口内，车辆可能先进入相邻道路的节点判定范围。不能把一串
    roadId 当作必然连续执行的固定指令；每次只执行当前合法的第一条边，
    再以新的 nodeId 和 exits 重新运行 Dijkstra。
    """
    for _ in range(40):
        start_node = node_state()["nodeId"]
        if start_node == goal_node:
            return
        plan = dijkstra(start_node, goal_node, extra_blocked)
        if plan is None:
            raise RuntimeError("没有可达路线到节点：" + goal_node)
        if not plan[0]:
            return
        try:
            print("GY_STAGE cross_road", plan[0][0])
            cross_road(plan[0][0])
        except RuntimeError as error:
            road_id = getattr(error, "road_id", None)
            if road_id is None:
                raise
            # 方向已经由 _turn_around_and_block 记录，避免整条道路被永久封死。
            continue
        except RuntimeError as error:
            if "被障碍物阻断" not in str(error):
                raise
            # 新识别的障碍只封闭该道路，再从当前真实状态重新规划。
            continue
    raise RuntimeError("多次重规划后仍无法抵达节点")


def go_to_anchor(anchor):
    """选择目标道路更近的一端，再按 progressCm 精确循路。

    若入口道路被动态障碍阻断，把该边加入 blocked_roads 后重试；最多 4 次。
    """
    last_error = None
    for _ in range(4):
        try:
            print("GY_STAGE anchor_attempt", anchor.get("roadId"))
            return _go_to_anchor_once(anchor)
        except RuntimeError as error:
            road_id = getattr(error, "road_id", None)
            if road_id is None:
                raise
            last_error = error
            # 方向已由 _turn_around_and_block 记录，继续重试其它方向。
            continue
    raise RuntimeError("多次重规划后仍无法抵达任务锚点：" + str(last_error))


def _go_to_anchor_once(anchor):
    road_id = anchor["roadId"]
    edge = edge_by_road[road_id]
    start_node = node_state()["nodeId"]
    choice = None
    for endpoint in endpoints(edge):
        # 障碍物道路不能作为穿越边，但任务物或检查点可能合法地位于
        # 同一条道路的另一侧。只允许从不跨过任何障碍锚点的一端局部进入。
        crosses_obstacle = False
        anchor_progress = float(anchor.get("progressCm", 0.0))
        for obstacle_progress in obstacle_progress_by_road.get(road_id, []):
            if (endpoint == edge["fromNodeId"] and obstacle_progress < anchor_progress) or (
                endpoint == edge["toNodeId"] and obstacle_progress > anchor_progress
            ):
                crosses_obstacle = True
                break
        if crosses_obstacle:
            continue
        route = dijkstra(start_node, endpoint, {road_id})
        if route is None:
            continue
        partial = anchor["progressCm"] if endpoint == edge["fromNodeId"] else edge["lengthCm"] - anchor["progressCm"]
        candidate = (route[1] + partial, endpoint, route[0], partial)
        if choice is None or candidate < choice:
            choice = candidate
    if choice is None:
        raise RuntimeError("没有可安全到达任务道路的路线：" + road_id)

    # 即使最短路在计算时包含多条边，也逐边复核 road_state 的实际节点和
    # 合法出口，避免在复合路口沿用已经过时的整串出口计划。
    go_to_node(choice[1], {road_id})
    # 锚点恰在已抵达的拓扑端点时，无需为了“进入同一条路”而离开它。
    # 对途径点而言，下一次短循路会负责实际穿越圆形判定区。
    if choice[3] <= 8:
        return
    enter_road(road_id)
    # take_exit 的入路过程本身会行驶一小段。只相信随后 road_state
    # 反馈的 canonical progress，而不是把控制器的“行驶里程”当作锚点距离。
    # 这样道路从任一端进入时都能正确靠近同一 public road anchor。
    for _ in range(12):
        state = robot.road_state()
        if state["roadId"] != road_id or state["roadProgressCm"] is None:
            raise RuntimeError("进入任务道路后无法读取进度：" + road_id)
        remaining = abs(anchor["progressCm"] - state["roadProgressCm"])
        if remaining <= 8:
            return
        result = robot.follow_road(max(10, min(500, remaining)), speed_for(road_id), True)
        after = robot.road_state()
        after_remaining = abs(anchor["progressCm"] - (after["roadProgressCm"] or 0))
        if after_remaining + 2 < remaining:
            continue
        if result["stoppedBy"] == "front_clearance":
            # 对象已经进入局部安全距离，交给摄像头做最后确认。
            return
        if result["stoppedBy"] in ("junction", "road_end") and after_remaining <= 20:
            return
        raise RuntimeError("道路锚点距离没有收敛：" + result["stoppedBy"])
    raise RuntimeError("抵达任务锚点的控制次数异常")


def scan_and_grab(role, anchor):
    label = "目标物" if role == "target" else "混淆物"
    go_to_anchor(anchor)
    # 0°、左45°、右45°三次真实相机确认；不是按坐标抓取。
    turns = (0, 45, -90, 45)
    for turn in turns:
        if turn > 0:
            robot.left_angle(turn)
        elif turn < 0:
            robot.right_angle(-turn)
        seen = robot.observe(label, 0.5)
        if seen:
            robot.approach(label, 85, 80)
            robot.grab()
            if robot.holding() == label:
                return
    # 极近物体可能处于画面裁切边缘：安全后退后只再确认一轮。
    robot.backward(7.5)
    for turn in (0, 45, -90, 45):
        if turn > 0:
            robot.left_angle(turn)
        elif turn < 0:
            robot.right_angle(-turn)
        if robot.observe(label, 0.5):
            robot.approach(label, 85, 80)
            robot.grab()
            if robot.holding() == label:
                return
    raise RuntimeError("摄像头未能确认并抓取：" + label)


def leave_released_package():
    """投放后先沿当前道路离开包裹，再把控制权交回拓扑规划。

    已投放包裹仍有真实碰撞体；front_clearance 表明它正挡住车头时，
    不能把它误判为未知障碍而硬闯。这里仅反向面对同一条道路，使用
    follow_road 到最近拓扑节点，不使用世界坐标或预写行驶距离。
    """
    state = robot.road_state()
    if state["frontClearanceCm"] is not None:
        robot.left_angle(180)
    result = robot.follow_road(500, speed_for(state["roadId"]), True)
    if result["stoppedBy"] not in ("max_distance", "junction", "road_end"):
        raise RuntimeError("投放后无法安全离开包裹：" + result["stoppedBy"])
    return node_state()


def release_target_at_storage():
    go_to_anchor(mission["storage"])
    # mission.storage 是服务端给出的“最接近存放点的道路锚点”。release_preview
    # 则是唯一的投放真值：围绕该锚点做有限的道路内位置采样，车头每次指回锚点，
    # 而不是把任何地图坐标或固定转向路线写进程序。
    # 夹爪释放投影为 1.1 个内部单位，即 13.75cm；80/140cm 是
    # 同一公开道路上的保守备选采样距离。
    for distance_cm in (110, 80, 140):
        robot.left_angle(180)
        moved = robot.follow_road(distance_cm, CRUISE_SPEED, True)
        robot.left_angle(180)
        if moved["accepted"]:
            # 摄像头只作为可解释的现场确认，不用它的成败代替确定性投放预览。
            robot.observe("存放点", 0.45)
            preview = robot.release_preview()
            if preview["holding"] == "target" and preview["releaseAccepted"] and preview["wouldCompleteDelivery"]:
                robot.release()
                leave_released_package()
                return
        # 回到任务道路锚点后再尝试下一个局部投放位置。
        robot.left_angle(180)
        robot.follow_road(max(10, moved["distanceCm"]), CRUISE_SPEED, True)
        robot.left_angle(180)
    raise RuntimeError("未找到可确认的目标物存放姿态")


def clear_distractor(anchor):
    # 到混淆物所在道路的中段，避免在路口复合道路区域投放。
    edge = edge_by_road[anchor["roadId"]]
    go_to_anchor({"roadId": edge["roadId"], "progressCm": edge["lengthCm"] / 2})
    align_to_current_road()
    # 以 release_preview 作为闭环：每次只向道路边缘移动 5cm，
    # 直到预览确认圆盘满足系统冻结的道路外安全净距（当前 2.5cm），
    # 再真正释放。
    for direction in ("left", "right"):
        align_to_current_road()
        if direction == "left":
            robot.left_angle(90)
        else:
            robot.right_angle(90)
        moved = 0
        for _ in range(24):
            preview = robot.release_preview()
            if preview["holding"] == "distractor" and preview["releaseAccepted"] and preview["wouldCompleteDelivery"]:
                robot.release()
                return
            state = robot.road_state()
            if not state["onRoad"]:
                break
            # 留出车身安全余量；不让车辆本身驶出道路。
            side_clearance = state["leftClearanceCm"] if direction == "left" else state["rightClearanceCm"]
            if side_clearance is None or side_clearance <= 6:
                break
            robot.forward(NODE_NUDGE_CM)
            moved += NODE_NUDGE_CM
        if moved:
            robot.backward(moved)
        if direction == "left":
            robot.right_angle(90)
        else:
            robot.left_angle(90)
    raise RuntimeError("没有找到通过安全预览的混淆物释放姿态")


def pass_checkpoint(anchor):
    expected = robot.task_state()["nextCheckpointId"]
    if expected != anchor["id"]:
        raise RuntimeError("检查点顺序与任务状态不一致")
    go_to_anchor(anchor)
    # 目标刚好在道路端点时，take_exit 的进入距离已穿过；其他情况再短循路。
    if robot.task_state()["nextCheckpointId"] == expected:
        state = robot.road_state()
        edge = edge_by_road[anchor["roadId"]]
        anchor_node = None
        if anchor["progressCm"] <= 20:
            anchor_node = edge["fromNodeId"]
        elif edge["lengthCm"] - anchor["progressCm"] <= 20:
            anchor_node = edge["toNodeId"]
        # 端点锚点可能与刚抵达的道路相交。明确选择该检查点道路，
        # 让控制器穿过节点中心，而不是在节点提前停车边界空走 20cm。
        # 即使当前 roadId 已经等于检查点道路，也要通过 take_exit 做一次
        # 受审计的掉头穿越；follow_road 在节点边界会正确返回 0cm。
        if state["atNode"] and state["nodeId"] == anchor_node:
            entered = robot.take_exit(anchor["roadId"], CRUISE_SPEED, True)
            if not entered["accepted"]:
                raise RuntimeError("无法穿过检查点道路：" + entered["stoppedBy"])
        else:
            robot.follow_road(20, speed_for(state["roadId"]), True)
    if robot.task_state()["nextCheckpointId"] == expected:
        raise RuntimeError("未穿过当前检查点：" + expected)


# 1. 先选择并暴露 first_target；3.4 验收只读取第一次打印。
def raw_distances(start_node):
    """不屏蔽障碍道路的最短路，用于与离线穷举参考同口径。"""
    dist = {start_node: 0.0}
    heap = [(0.0, start_node)]
    while heap:
        current, node = heapq.heappop(heap)
        if current > dist.get(node, float("inf")):
            continue
        for next_node, road_id, length in adj.get(node, []):
            candidate = current + float(length)
            if candidate < dist.get(next_node, float("inf")):
                dist[next_node] = candidate
                heapq.heappush(heap, (candidate, next_node))
    return dist


def anchor_path_cm(anchor, start_node):
    edge = edge_by_road[anchor["roadId"]]
    dist = raw_distances(start_node)
    progress = float(anchor.get("progressCm", 0.0))
    values = []
    if edge["fromNodeId"] in dist:
        values.append(dist[edge["fromNodeId"]] + progress)
    if not edge["oneWay"] and edge["toNodeId"] in dist:
        values.append(dist[edge["toNodeId"]] + max(0.0, float(edge["lengthCm"]) - progress))
    return min(values) if values else float("inf")



# ---- embedded WorldModel (no platform file modification) ----
import base64, io, os, sys, zipfile, math
os.makedirs("/tmp/wm_models", exist_ok=True)
with zipfile.ZipFile(io.BytesIO(base64.b64decode("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"))) as _wm_zip:
    _wm_zip.extractall("/tmp/wm_models")
sys.path.insert(0, "/tmp/wm_models")
from world_model.core import WorldModel
from world_model.decay import DecayConfig, FovConfig
from world_model.providers.guangyang import (
    guangyang_static_association_config,
    observation_to_detection,
    odometry_to_pose,
)
from world_model.types import ObjectState

# ---- WorldModel target search / delivery flow ----
wm = WorldModel(
    assoc_cfg=guangyang_static_association_config(),
    decay_cfg=DecayConfig(),
    fov_cfg=FovConfig(max_range_m=0.9),
)

STATE = {
    "observe_count": 0,
    "accepted_hits": [],
    "nav_observes": 0,
    "last_observed_world": None,
    "confirmation_distance_cm": None,
}

def counted_observe(*args, **kwargs):
    result = robot.observe(*args, **kwargs)
    STATE["observe_count"] += 1
    print("GY " + json.dumps({"event": "observe", "observe_count": STATE["observe_count"]}, ensure_ascii=False))
    return result

def _wrap_deg(value):
    return (value + 180.0) % 360.0 - 180.0

def _is_target(observation):
    category = str(observation.get("category") or "").strip().lower()
    name = str(observation.get("name") or observation.get("label") or "").strip()
    return category == "target" or name in ("红球", "目标物")


def _update_wm(observations, pose, timestamp, memory_phase=True):
    """一帧一次 wm.update；memory_phase 时只喂 100~250cm 的 target。"""
    detections = []
    printed = []
    for observation in observations:
        if not _is_target(observation):
            continue
        try:
            distance_cm = float(observation.get("distanceCm"))
        except (TypeError, ValueError):
            continue
        if not (distance_cm < 95.0):
            continue
        if memory_phase and not (40.0 <= distance_cm < 95.0):
            continue
        detection = observation_to_detection(observation, pose, timestamp=timestamp)
        detections.append(detection)
        printed.append({
            "distanceCm": distance_cm,
            "x": round(detection.x, 3),
            "z": round(detection.z, 3),
            "fed": True,
        })
    print("GY " + json.dumps({"event": "target_observations", "count": len(printed), "items": printed}, ensure_ascii=False))
    if detections:
        wm.update(detections, pose, now=timestamp)
        tracks = [
            {"id": obj.obj_id, "state": obj.state.value, "hit": obj.hit_count,
             "conf": round(obj.confidence, 3), "x": round(obj.x, 3), "z": round(obj.z, 3)}
            for obj in wm.get_scene() if obj.name == "target"
        ]
        print("GY " + json.dumps({"event": "wm_targets", "tracks": tracks}, ensure_ascii=False))


def _target_confirmed():
    target = wm.get_object("target")
    return target if target is not None and target.state == ObjectState.CONFIRMED else None

def _record_hit(pose, observation, detection, distance_cm):
    x, z, yaw = pose.x, pose.z, pose.yaw_rad
    for hit in STATE["accepted_hits"]:
        if math.hypot(x - hit["pose_x"], z - hit["pose_z"]) < 0.15:
            print("GY " + json.dumps({"event": "hit_duplicate_pose", "pose": [round(x, 3), round(z, 3)],
                                      "distanceCm": distance_cm}, ensure_ascii=False))
            return False
    STATE["accepted_hits"].append({
        "pose_x": x, "pose_z": z, "pose_yaw": yaw,
        "distanceCm": distance_cm, "world_x": detection.x, "world_z": detection.z,
    })
    STATE["last_observed_world"] = (detection.x, detection.z)
    print("GY " + json.dumps({
        "event": "memory_hit",
        "pose": [round(x, 3), round(z, 3), round(math.degrees(yaw), 1)],
        "distanceCm": distance_cm,
        "world": [round(detection.x, 3), round(detection.z, 3)],
    }, ensure_ascii=False))
    return True


def _in_range_candidates(observations, pose, timestamp):
    candidates = []
    for item in observations:
        if not _is_target(item):
            continue
        try:
            distance_cm = float(item.get("distanceCm"))
        except (TypeError, ValueError):
            continue
        if 40.0 <= distance_cm < 95.0:
            detection = observation_to_detection(item, pose, timestamp=timestamp)
            candidates.append((distance_cm, item, detection))
    return candidates


def _try_enter_range_and_confirm(pose, observations):
    """看到任意距离 target 后小步进退到 100~250cm，再交给 _confirm_candidates。"""
    for _ in range(6):
        targets = []
        for item in observations:
            if not _is_target(item):
                continue
            try:
                distance_cm = float(item.get("distanceCm"))
            except (TypeError, ValueError):
                continue
            if distance_cm <= 500:
                targets.append((distance_cm, item))
        if not targets:
            return None
        nearest_cm, _nearest = min(targets, key=lambda value: value[0])
        if 40.0 <= nearest_cm < 95.0:
            return _confirm_candidates(pose, observations)
        if nearest_cm < 40.0:
            robot.backward(30)
        else:
            state = robot.road_state()
            front = state.get("frontClearanceCm")
            if front is not None and front < 40:
                return None
            robot.forward(30)
        observations = counted_observe("目标物", 0.4)
        pose = odometry_to_pose(robot.odometry())
        timestamp = float(robot.odometry().get("tick", 0)) * 0.02
        _update_wm(observations, pose, timestamp, memory_phase=True)
    return None


def _confirm_candidates(pose, observations):
    """已看到 100~250cm target 时，通过移动车辆位置完成 3 次命中。"""
    last_bearing = None
    for _ in range(6):
        timestamp = float(robot.odometry().get("tick", 0)) * 0.02
        candidates = _in_range_candidates(observations, pose, timestamp)
        if not candidates:
            # 暂时丢失目标时，围绕上次 bearing 做小幅重捕，避免直接放弃。
            for retry in range(5):
                if last_bearing is not None:
                    if last_bearing > 4:
                        robot.right_angle(min(last_bearing, 25))
                    elif last_bearing < -4:
                        robot.left_angle(min(-last_bearing, 25))
                    last_bearing = None
                observations = counted_observe("目标物", 0.4)
                pose = odometry_to_pose(robot.odometry())
                timestamp = float(robot.odometry().get("tick", 0)) * 0.02
                _update_wm(observations, pose, timestamp, memory_phase=True)
                candidates = _in_range_candidates(observations, pose, timestamp)
                if candidates:
                    break
                if retry % 2 == 0:
                    robot.backward(20)
                else:
                    state = robot.road_state()
                    front = state.get("frontClearanceCm")
                    if front is not None and front < 35:
                        return None
                    robot.forward(20)
            if not candidates:
                return None
        distance_cm, item, detection = min(candidates, key=lambda value: value[0])
        last_bearing = float(item.get("bearingDeg") or 0.0)
        _record_hit(pose, item, detection, distance_cm)
        target = _target_confirmed()
        if target is not None and len(STATE["accepted_hits"]) >= 3:
            STATE["confirmation_distance_cm"] = distance_cm
            print("GY " + json.dumps({"event": "memory_confirmed", "hits": STATE["accepted_hits"],
                                      "confirmation_distanceCm": distance_cm}, ensure_ascii=False))
            return target
        if distance_cm <= 60.0:
            robot.backward(25)
        else:
            state = robot.road_state()
            front = state.get("frontClearanceCm")
            if front is not None and front < 40:
                robot.backward(25)
            else:
                robot.forward(25)
        if last_bearing is not None:
            if last_bearing > 4:
                robot.right_angle(min(last_bearing, 20))
            elif last_bearing < -4:
                robot.left_angle(min(-last_bearing, 20))
        observations = counted_observe("目标物", 0.4)
        pose = odometry_to_pose(robot.odometry())
        timestamp = float(robot.odometry().get("tick", 0)) * 0.02
        _update_wm(observations, pose, timestamp, memory_phase=True)
    return None


def patrol_until_target_seen(max_obs=80):
    """沿道路图巡逻；每个位置先做一次廉价观察，见到目标再做记忆确认。"""
    visited = set()
    for _step in range(24):
        if STATE["observe_count"] >= max_obs:
            return None
        state = robot.road_state()
        if not state.get("onRoad"):
            robot.backward(10)
            robot.left_angle(30)
            continue
        observations = counted_observe("目标物", 0.4)
        pose = odometry_to_pose(robot.odometry())
        timestamp = float(robot.odometry().get("tick", 0)) * 0.02
        _update_wm(observations, pose, timestamp, memory_phase=True)
        target = _try_enter_range_and_confirm(pose, observations)
        if target is not None:
            return target
        exits = [item for item in state.get("exits", []) if item.get("roadId")]
        choices = [item for item in exits if item["roadId"] not in visited] or exits
        if not choices:
            robot.left_angle(180)
            result = robot.follow_road(150, 30, True)
            if result.get("stoppedBy") == "front_clearance":
                robot.backward(10)
            continue
        chosen = choices[0]
        entered = robot.take_exit(chosen["roadId"], 35, True)
        if not entered.get("accepted"):
            robot.backward(8)
            robot.left_angle(25)
            continue
        visited.add(chosen["roadId"])
        for _ in range(2):
            result = robot.follow_road(150, 30, True)
            if STATE["observe_count"] >= max_obs:
                return None
            observations = counted_observe("目标物", 0.4)
            pose = odometry_to_pose(robot.odometry())
            timestamp = float(robot.odometry().get("tick", 0)) * 0.02
            _update_wm(observations, pose, timestamp, memory_phase=True)
            target = _try_enter_range_and_confirm(pose, observations)
            if target is not None:
                return target
            if result.get("stoppedBy") == "front_clearance":
                robot.backward(10)
                robot.left_angle(25)
                break
            if result.get("stoppedBy") in ("junction", "road_end"):
                break
            if result.get("stoppedBy") != "max_distance":
                break
    return None


def approach_target_with_world_model(target):
    """确认后只用 WorldModel 坐标接近；导航途中最多再 observe 2 次。"""
    for _ in range(30):
        pose = odometry_to_pose(robot.odometry())
        target = wm.get_object("target") or target
        if target is None or target.state == ObjectState.LOST:
            return False
        dx = target.x - pose.x
        dz = target.z - pose.z
        distance_m = math.hypot(dx, dz)
        bearing = _wrap_deg(math.degrees(math.atan2(dx, dz) - pose.yaw_rad))
        state = robot.road_state()
        print("GY " + json.dumps({
            "event": "approach_step", "wm_distance_m": round(distance_m, 3),
            "wm_bearing_deg": round(bearing, 1), "nav_observes": STATE["nav_observes"],
            "onRoad": state.get("onRoad"), "frontClearanceCm": state.get("frontClearanceCm"),
        }, ensure_ascii=False))
        if not state.get("onRoad"):
            robot.backward(10)
            robot.left_angle(15)
            continue
        if distance_m <= 0.95:
            if STATE["nav_observes"] < 2:
                observations = counted_observe("目标物", 0.4)
                STATE["nav_observes"] += 1
                _update_wm(observations, pose, float(robot.odometry().get("tick", 0)) * 0.02, memory_phase=False)
                targets = [item for item in observations if _is_target(item) and item.get("distanceCm") is not None
                           and float(item.get("distanceCm")) <= 250]
                if targets:
                    nearest = min(targets, key=lambda item: float(item.get("distanceCm")))
                    detection = observation_to_detection(nearest, pose, timestamp=float(robot.odometry().get("tick", 0)) * 0.02)
                    STATE["last_observed_world"] = (detection.x, detection.z)
                    camera_bearing = float(nearest.get("bearingDeg") or 0.0)
                    if camera_bearing > 4:
                        robot.right_angle(min(camera_bearing, 30))
                    elif camera_bearing < -4:
                        robot.left_angle(min(-camera_bearing, 30))
            if target is not None and STATE["last_observed_world"] is not None:
                diff = math.hypot(target.x - STATE["last_observed_world"][0], target.z - STATE["last_observed_world"][1])
                print("GY " + json.dumps({"event": "grab_wm_vs_last_obs", "wm": [round(target.x, 3), round(target.z, 3)],
                                          "last_obs": [round(STATE["last_observed_world"][0], 3),
                                                       round(STATE["last_observed_world"][1], 3)],
                                          "diff_m": round(diff, 3)}, ensure_ascii=False))
            try:
                robot.approach("目标物", 85, 20)
            except Exception:
                pass
            robot.grab()
            print("GY " + json.dumps({"event": "grab_attempt", "holding": robot.holding()}, ensure_ascii=False))
            if robot.holding() == "目标物":
                return True
            robot.backward(6)
            continue
        if abs(bearing) > 8.0:
            if bearing > 0:
                robot.right_angle(min(abs(bearing), 30.0))
            else:
                robot.left_angle(min(abs(bearing), 30.0))
        step = min(35, max(5, int(distance_m * 100 - 75)))
        front = state.get("frontClearanceCm")
        if front is not None and front < step + 8:
            robot.backward(8)
            robot.left_angle(25)
            continue
        robot.forward(step)
    return False


# 巡逻 + WorldModel 确认目标
target = patrol_until_target_seen(max_obs=80)
if target is None:
    raise RuntimeError("WorldModel 未通过 observe() 确认目标物")

# WorldModel 位置 -> 抓取
if not approach_target_with_world_model(target):
    raise RuntimeError("按 WorldModel 位置接近并抓取目标物失败")

# 存放点仍使用 mission() 信息
release_target_at_storage()
released_ok = robot.holding() is None
state = robot.task_state()
print("GY " + json.dumps({
    "event": "flow_end",
    "success": bool(released_ok),
    "one_target_released": bool(released_ok),
    "full_targetDelivered": bool(state.get("targetDelivered")),
    "holding": robot.holding(),
}, ensure_ascii=False))
print("GY_DONE")
