# 广阳岛普通单局：道路图规划器
#
# 这不是“前进多少厘米、转多少度”的固定路线。它只使用公开接口：
# mission / task_state / release_preview / map_graph / road_state /
# follow_road / take_exit / observe / approach / grab / release / holding。
#
# 运行前提：普通单局（不是练习/筛选五局）并且地图已由服务端冻结。
# mission["objects"] 提供的是 role/roadId/progressCm 道路锚点，不是坐标；
# 代码仍自行做 Dijkstra、选择出口、循路、相机确认、抓取和安全投放。

import hashlib, heapq, json, sys, traceback

PROGRAM_VERSION = "wm-opt2-r2-20260924"
try:
    _main_module = sys.modules.get("__main__")
    _student_source = getattr(_main_module, "__dict__", {}).get("student_source")
    if isinstance(_student_source, str):
        PROGRAM_SHA256 = hashlib.sha256(_student_source.encode("utf-8")).hexdigest()
    else:
        PROGRAM_SHA256 = "unavailable"
except Exception:
    PROGRAM_SHA256 = "unavailable"
# 内嵌 world_model 包对应的 wm_kit 提交（由 tools/embed_world_model.py 写入；program_version 行在包解压后打印）
DETECTION_FILTER_SHA256 = "57ea75300c330bea5b4ecdb7a529cdc802e617a76572c75f4f76fe6d319f7322"
TURN_COST_K = 0.060290462706043484
TURN_CALIBRATION_SHA256 = "be38032897487e85cf36d994b308cba0c4ed9dc6821485e16bd6982123f3a195"
WM_KIT_COMMIT = "326a5f8892b9da11996b5f3d3d0fc56341aca6e4"

class MissionFailure(Exception):
    """明确记录的任务约束失败；不用于捕获编程异常。"""

"""Cache read-only navigation snapshots until an action changes simulator state.

Limits are public platform API limits (app.js), not scene-fitted thresholds.
"""
NAVIGATION_QUERY_LIMIT = 1000
NAVIGATION_CONTROL_LIMIT = 300
NAV_STATE = {"cache": {}, "queries": 0, "controls": 0}


def _nav_reserve(kind, limit):
    if NAV_STATE[kind] >= limit:
        print("GY " + json.dumps({"event": "navigation_budget_exhausted", "kind": kind,
                                  "used": NAV_STATE[kind], "limit": limit}, ensure_ascii=False))
        raise MissionFailure("navigation_" + kind + "_budget_exhausted")
    NAV_STATE[kind] += 1


def _nav_invalidate():
    NAV_STATE["cache"].clear()


def nav_odometry():
    if "odometry" not in NAV_STATE["cache"]:
        _nav_reserve("queries", NAVIGATION_QUERY_LIMIT)
        NAV_STATE["cache"]["odometry"] = robot.odometry()
    return dict(NAV_STATE["cache"]["odometry"] or {})


def nav_road_state():
    if "road_state" not in NAV_STATE["cache"]:
        _nav_reserve("queries", NAVIGATION_QUERY_LIMIT)
        NAV_STATE["cache"]["road_state"] = robot.road_state()
    return dict(NAV_STATE["cache"]["road_state"] or {})


def nav_mission():
    _nav_reserve("queries", NAVIGATION_QUERY_LIMIT)
    return robot.mission()


def nav_map_graph():
    _nav_reserve("queries", NAVIGATION_QUERY_LIMIT)
    return robot.map_graph()


def nav_task_state():
    if "task_state" not in NAV_STATE["cache"]:
        _nav_reserve("queries", NAVIGATION_QUERY_LIMIT)
        NAV_STATE["cache"]["task_state"] = robot.task_state()
    return dict(NAV_STATE["cache"]["task_state"] or {})


def nav_release_preview():
    if "release_preview" not in NAV_STATE["cache"]:
        _nav_reserve("queries", NAVIGATION_QUERY_LIMIT)
        NAV_STATE["cache"]["release_preview"] = robot.release_preview()
    return dict(NAV_STATE["cache"]["release_preview"] or {})


def motion_forward(distance_cm):
    _nav_invalidate()
    return robot.forward(distance_cm)


def motion_backward(distance_cm):
    _nav_invalidate()
    return robot.backward(distance_cm)


def motion_left_angle(angle_deg):
    _nav_invalidate()
    return robot.left_angle(angle_deg)


def motion_right_angle(angle_deg):
    _nav_invalidate()
    return robot.right_angle(angle_deg)


def motion_follow_road(max_cm, speed, obey_speed_limit):
    _nav_reserve("controls", NAVIGATION_CONTROL_LIMIT)
    _nav_invalidate()
    return robot.follow_road(max_cm, speed, obey_speed_limit)


def motion_take_exit(road_id, speed, obey_speed_limit):
    _nav_reserve("controls", NAVIGATION_CONTROL_LIMIT)
    _nav_invalidate()
    return robot.take_exit(road_id, speed, obey_speed_limit)


def motion_approach(target, distance_cm, max_steps):
    _nav_invalidate()
    return robot.approach(target, distance_cm, max_steps)


def motion_grab():
    _nav_invalidate()
    return robot.grab()


def motion_release():
    _nav_invalidate()
    return robot.release()


def query_observe(category, confidence):
    _nav_invalidate()
    return robot.observe(category, confidence)


MAX_OBSERVES = 92
PATROL_OBSERVE_BUDGET = 60
APPROACH_DISTANCE_M = 0.25
APPROACH_FOLLOW_STEP_CM = 10.0
APPROACH_MAX_MEMORY_STEPS = 30
APPROACH_JUNCTION_FRONT_MIN_CM = 10.0
APPROACH_NODE_NUDGE_CM = 2.0
APPROACH_IMPROVE_M = 0.005
APPROACH_MAX_CALLS = 3
MEMORY_FORWARD_MIN_CM = 30.0
# v24：记忆行驶不再在 0.25m 就停。视觉测距在 40~90cm 系统性偏短 8~19cm（v23 真值复核），
# WorldModel 目标比真球近约 13cm，而平台 grab 只接受正前方 4.75~16.9cm、横向 <=4.75cm。
# 因此继续沿路走到 0.06m（v24 的 MEMORY_STOP_DISTANCE_M，v26 已改为 GRAB_STANDOFF_M）以内，或连续两步距离增大（已越过最近点），或
# follow_road 在近距离被前方物体挡停（视为到达）。
# 平台 follow_road 最小 10cm，且 take_exit 一次会扫过约 38cm（v24 实测），球若在路口附近
# 沿路穿过路口会直接撞球。所以记忆距离 <= APPROACH_FINE_DISTANCE_M 后退出 follow_road，
# 原地转向 WM 目标，用 APPROACH_FINE_STEP_CM 的直行盲步（仍不 observe）收到
# 停止距离，再交给 approach(max_steps=1)+grab 用视觉精修最后几厘米
# （单次 approach 前进脉冲仅约 0.75cm，所以允许多次调用）。
# v26：WM 已做测距标定（见 RANGE_CAL），不再用"开到 6cm"抵消偏短；细步把 WM 目标停在正前方
# GRAB_STANDOFF_M（grab 窗口前向 4.75~16.9cm 的中部），最后一步按剩余距离精确给出。
# v27：标定后按球留一的留出偏差仍有 −15.5…+25.5cm（逐球系统偏差，读数/方位无法区分），WM 精度不再
# 作为抓取依据：在 WM 前向 GRAB_STANDOFF_M 处停车对准，然后 grab → holding()，未抓到就直行
# GRAB_STEP_CM 再抓，累计前进不超过 GRAB_MAX_ADVANCE_CM（覆盖 +25.5cm 的最坏情况）。
GRAB_STANDOFF_M = 0.22
GRAB_AIM_TOL_DEG = 3.0
GRAB_STEP_CM = 6.0
GRAB_MAX_ADVANCE_CM = 42.0
APPROACH_FINE_DISTANCE_M = 0.30
APPROACH_FINE_STEP_CM = 4.0
APPROACH_FINE_MAX_STEPS = 12
APPROACH_FINE_REAIM_DEG = 20.0
APPROACH_BLOCKED_ARRIVAL_MAX_M = 0.35  # 近距离被挡停时视为到达而非失败
CONFIRM_MIN_CM = 40.0
CONFIRM_MAX_CM = 90.0
CONFIRM_MIN_GAP_M = 0.15
CONFIRM_LAST_MIN_DIST_M = 0.50
# v28：采样方向按"移动后预测的原始读数"选（修正模型反算），不再用按未修正距离写的 0.65/0.68/0.70m 阈值。
CONFIRM_PREDICT_MIN_CM = 45.0
CONFIRM_PREDICT_MAX_CM = 85.0
# 阶段1直接采用验收给定值，不增加经验拟合阈值。
VIEW_GRID_CM = 5.0
OBS_MIN_TRANSLATION_CM = 5.0
OBS_MIN_TURN_DEG = 10.0
CONFIRM_VIEW_MAX_BEARING_DEG = 30.0


# v25：送货阶段（抓到球之后）每次 follow_road / take_exit 的详细日志。
# 只在 DELIVERY_LOG["on"] 为 True 时打印，确认与接近阶段的输出保持不变。
DELIVERY_LOG = {"on": False}


def _delivery_event(event, **fields):
    if not DELIVERY_LOG["on"]:
        return
    try:
        odo = nav_odometry() or {}
        pose = [round(float(odo.get("rightCm", 0.0)) / 100.0, 3),
                round(float(odo.get("forwardCm", 0.0)) / 100.0, 3),
                round(float(odo.get("headingDeg", 0.0)), 1)]
    except Exception:
        pose = None
    try:
        rs = nav_road_state() or {}
        road = {"roadId": rs.get("roadId"), "roadProgressCm": rs.get("roadProgressCm"), "onRoad": rs.get("onRoad"),
                "atNode": rs.get("atNode"), "nodeId": rs.get("nodeId"), "frontClearanceCm": rs.get("frontClearanceCm")}
    except Exception:
        road = None
    payload = {"event": event}
    payload.update(fields)
    payload["pose"] = pose
    payload["road"] = road
    print("GY " + json.dumps(payload, ensure_ascii=False))


def _dl_follow(stage, road_id, max_cm, speed):
    result = motion_follow_road(max_cm, speed, True)
    _delivery_event("delivery_follow_road", stage=stage, roadId=road_id, requestCm=max_cm,
                    distanceCm=result.get("distanceCm"), stoppedBy=result.get("stoppedBy"),
                    accepted=result.get("accepted"))
    return result


def _dl_take_exit(stage, road_id, speed):
    result = motion_take_exit(road_id, speed, True)
    _delivery_event("delivery_take_exit", stage=stage, roadId=road_id,
                    distanceCm=result.get("distanceCm"), stoppedBy=result.get("stoppedBy"),
                    accepted=result.get("accepted"))
    return result


def road_blocked(road_id, reason="front_clearance"):
    """构造带 road_id 的 RuntimeError，避免 Pyodide 下自定义异常构造异常。"""
    error = RuntimeError(f"{reason}:{road_id}")
    error.road_id = road_id
    error.reason = reason
    return error


def _turn_around_and_block(road_id):
    """Remember the actual local clearance stop before turning around."""
    state = nav_road_state()
    if state.get("roadId") == road_id:
        _vp_block_current_direction(state)
    motion_left_angle(180)

CRUISE_SPEED = 100  # 由道路控制逐 tick 自动钳制到当前道路/限速区的安全上限。
SLOW_SPEED = 30
NODE_NUDGE_CM = 2

mission = nav_mission()
graph = nav_map_graph()
obstacle_anchors = [item for item in mission.get("objects", [])
                    if isinstance(item, dict) and item.get("role") == "obstacle"]
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
    raise MissionFailure("道路方向与图定义不兼容：" + road_id)


def _road_progress_limit(road_id, start, end):
    """Return the reachable part of a directed road interval, in public cm.

    A clearance stop describes a boundary at the measured progress, not the
    whole road direction. Ending at that boundary is allowed; crossing is not.
    """
    if end == start:
        return end
    edge = edge_by_road[road_id]
    direction = 1 if end > start else -1
    a, b = ((edge["fromNodeId"], edge["toNodeId"]) if direction > 0
            else (edge["toNodeId"], edge["fromNodeId"]))
    if (a, b, road_id) in blocked_directions:
        return start
    stops = [(max(start, stop) if direction > 0 else min(start, stop))
             for (name, sign, _key), stop in VP_STATE.get("local_blocks", {}).items()
             if name == road_id and sign == direction
             and round(direction * (stop - start), 1) >= 0 and direction * (end - stop) > 0]
    if stops:
        return min(stops) if direction > 0 else max(stops)
    return end


def _road_progress_blocked(road_id, start, end):
    return _road_progress_limit(road_id, start, end) != end


def _vp_block_revision():
    return len(blocked_directions), tuple(sorted(VP_STATE.get("local_blocks", {}).items()))


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
            edge = edge_by_road[road_id]
            start = 0.0 if current == edge["fromNodeId"] else float(length_cm)
            end = float(length_cm) - start
            if _road_progress_blocked(road_id, start, end):
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
    state = nav_road_state()
    if not state["onRoad"]:
        raise MissionFailure("车辆已离开道路，停止规划")
    error = state["headingErrorDeg"]
    if error > 1:
        motion_left_angle(error)
    elif error < -1:
        motion_right_angle(-error)


def node_state():
    """只依赖道路控制抵达真实拓扑节点，并处理边界的单次低速前探。"""
    front_clearance_retries = 0
    for _ in range(14):
        state = nav_road_state()
        if state["atNode"]:
            return state
        align_to_current_road()
        result = _dl_follow("node_state", state["roadId"], 500, speed_for(state["roadId"]))
        if result["stoppedBy"] == "front_clearance":
            # 局部安全停车可能是前一个被投放包裹或短时遮挡造成的。
            # 先低速后退并重新对齐同一道路，最多重试三次；仍无法前进时
            # 交由上层捕获并重新规划，避免把车卡死在同一条边上。
            front_clearance_retries += 1
            if front_clearance_retries > 3:
                road_id = state.get("roadId")
                print("GY_STAGE front_turnaround", road_id)
                _turn_around_and_block(road_id)
                result = _dl_follow("node_state_turnaround", road_id, 500, speed_for(road_id))
                state = nav_road_state()
                if state["atNode"]:
                    return state
                raise road_blocked(road_id, "front_clearance_turnaround")
            motion_backward(NODE_NUDGE_CM)
            align_to_current_road()
            continue
        if result["stoppedBy"] not in ("max_distance", "junction", "road_end"):
            raise MissionFailure("抵达节点前被安全停止：" + result["stoppedBy"])
        state = nav_road_state()
        if state["atNode"]:
            return state
        # follow_road 在节点判定边界停车时，只允许一次受审计的 2cm 前探。
        if result["stoppedBy"] in ("junction", "road_end"):
            motion_forward(NODE_NUDGE_CM)
            state = nav_road_state()
            _delivery_event("delivery_node_nudge", nudgeCm=NODE_NUDGE_CM, atNode=state.get("atNode"), nodeId=state.get("nodeId"))
            if state["atNode"]:
                return state
    raise MissionFailure("无法从道路状态确认图节点")


def enter_road(road_id):
    state = node_state()
    legal = {item["roadId"] for item in state["exits"]}
    if road_id not in legal:
        raise MissionFailure("规划道路不在当前合法出口中：" + road_id)
    result = _dl_take_exit("enter_road", road_id, CRUISE_SPEED)
    if not result["accepted"]:
        raise MissionFailure("进入道路失败：" + result["stoppedBy"])
    return result


def cross_road(road_id):
    """完整穿过一条图边；不会在遇到障碍时盲目转向。"""
    enter_road(road_id)
    for _ in range(20):
        result = _dl_follow("cross_road", road_id, 500, speed_for(road_id))
        if result["stoppedBy"] == "max_distance":
            continue
        if result["stoppedBy"] in ("junction", "road_end"):
            return node_state()["nodeId"]
        if result["stoppedBy"] == "front_clearance":
            _turn_around_and_block(road_id)
            raise road_blocked(road_id, "front_clearance")
        raise MissionFailure("循路失败：" + result["stoppedBy"])
    raise MissionFailure("道路长度超过控制预算：" + road_id)


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
            raise MissionFailure("没有可达路线到节点：" + goal_node)
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
    raise MissionFailure("多次重规划后仍无法抵达节点")


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
    raise MissionFailure("多次重规划后仍无法抵达任务锚点：" + str(last_error))


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
        raise MissionFailure("没有可安全到达任务道路的路线：" + road_id)

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
        state = nav_road_state()
        if state["roadId"] != road_id or state["roadProgressCm"] is None:
            raise MissionFailure("进入任务道路后无法读取进度：" + road_id)
        remaining = abs(anchor["progressCm"] - state["roadProgressCm"])
        if remaining <= 8:
            return
        result = _dl_follow("anchor_progress", road_id, max(10, min(500, remaining)), speed_for(road_id))
        after = nav_road_state()
        after_remaining = abs(anchor["progressCm"] - (after["roadProgressCm"] or 0))
        if after_remaining + 2 < remaining:
            continue
        if result["stoppedBy"] == "front_clearance":
            # 对象已经进入局部安全距离，交给摄像头做最后确认。
            return
        if result["stoppedBy"] in ("junction", "road_end") and after_remaining <= 20:
            return
        raise MissionFailure("道路锚点距离没有收敛：" + result["stoppedBy"])
    raise MissionFailure("抵达任务锚点的控制次数异常")



def leave_released_package():
    """投放后先沿当前道路离开包裹，再把控制权交回拓扑规划。

    已投放包裹仍有真实碰撞体；front_clearance 表明它正挡住车头时，
    不能把它误判为未知障碍而硬闯。这里仅反向面对同一条道路，使用
    follow_road 到最近拓扑节点，不使用世界坐标或预写行驶距离。
    """
    state = nav_road_state()
    if state["frontClearanceCm"] is not None:
        motion_left_angle(180)
    result = _dl_follow("leave_released_package", state["roadId"], 500, speed_for(state["roadId"]))
    if result["stoppedBy"] not in ("max_distance", "junction", "road_end"):
        raise MissionFailure("投放后无法安全离开包裹：" + result["stoppedBy"])
    return node_state()


def release_target_at_storage():
    go_to_anchor(mission["storage"])
    # mission.storage 是服务端给出的“最接近存放点的道路锚点”。release_preview
    # 则是唯一的投放真值：围绕该锚点做有限的道路内位置采样，车头每次指回锚点，
    # 而不是把任何地图坐标或固定转向路线写进程序。
    # 夹爪释放投影为 1.1 个内部单位，即 13.75cm；80/140cm 是
    # 同一公开道路上的保守备选采样距离。
    for distance_cm in (110, 80, 140):
        motion_left_angle(180)
        moved = _dl_follow("release_sample", None, distance_cm, CRUISE_SPEED)
        motion_left_angle(180)
        if moved["accepted"]:
            # 摄像头只作为可解释的现场确认，不用它的成败代替确定性投放预览。
            if _observe_motion()[0]:
                counted_observe("存放点", 0.45)
            else:
                _delivery_event("delivery_observe_not_needed", reason="no_new_observation_motion")
            preview = nav_release_preview()
            if preview["holding"] == "target" and preview["releaseAccepted"] and preview["wouldCompleteDelivery"]:
                motion_release()
                leave_released_package()
                return True
        # 回到任务道路锚点后再尝试下一个局部投放位置。
        motion_left_angle(180)
        _dl_follow("release_return", None, max(10, moved["distanceCm"]), CRUISE_SPEED)
        motion_left_angle(180)
    return False


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
            motion_left_angle(90)
        else:
            motion_right_angle(90)
        moved = 0
        for _ in range(24):
            preview = nav_release_preview()
            if preview["holding"] == "distractor" and preview["releaseAccepted"] and preview["wouldCompleteDelivery"]:
                motion_release()
                return
            state = nav_road_state()
            if not state["onRoad"]:
                break
            # 留出车身安全余量；不让车辆本身驶出道路。
            side_clearance = state["leftClearanceCm"] if direction == "left" else state["rightClearanceCm"]
            if side_clearance is None or side_clearance <= 6:
                break
            motion_forward(NODE_NUDGE_CM)
            moved += NODE_NUDGE_CM
        if moved:
            motion_backward(moved)
        if direction == "left":
            motion_right_angle(90)
        else:
            motion_left_angle(90)
    raise MissionFailure("没有找到通过安全预览的混淆物释放姿态")


def pass_checkpoint(anchor):
    expected = nav_task_state()["nextCheckpointId"]
    if expected != anchor["id"]:
        raise MissionFailure("检查点顺序与任务状态不一致")
    go_to_anchor(anchor)
    # 目标刚好在道路端点时，take_exit 的进入距离已穿过；其他情况再短循路。
    if nav_task_state()["nextCheckpointId"] == expected:
        state = nav_road_state()
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
            entered = motion_take_exit(anchor["roadId"], CRUISE_SPEED, True)
            if not entered["accepted"]:
                raise MissionFailure("无法穿过检查点道路：" + entered["stoppedBy"])
        else:
            motion_follow_road(20, speed_for(state["roadId"]), True)
    if nav_task_state()["nextCheckpointId"] == expected:
        raise MissionFailure("未穿过当前检查点：" + expected)


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
_WM_ZIP_BYTES = base64.b64decode("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")
WM_EMBED_SHA256 = hashlib.sha256(_WM_ZIP_BYTES).hexdigest()
with zipfile.ZipFile(io.BytesIO(_WM_ZIP_BYTES)) as _wm_zip:
    _wm_zip.extractall("/tmp/wm_models")
sys.path.insert(0, "/tmp/wm_models")
from world_model.core import WorldModel
from world_model.association import associate
from world_model.decay import DecayConfig, FovConfig
from world_model.providers.guangyang import (
    guangyang_static_association_config,
    observation_to_detection,
    odometry_to_pose,
)
from world_model.types import ObjectState

print("GY " + json.dumps({
    "event": "program_version",
    "version": PROGRAM_VERSION,
    "file_sha256": PROGRAM_SHA256,
    "wm_kit_commit": WM_KIT_COMMIT,
    "wm_embed_sha256": WM_EMBED_SHA256,
    "turn_cost_k": TURN_COST_K,
    "turn_calibration_sha256": TURN_CALIBRATION_SHA256,
    "log_conventions": {"pose": "[x_m 右, z_m 前, headingDeg 左转为正 = odometry.headingDeg]",
                        "bearingDeg": "右为正（observe / WM 方位同号）"},
}, ensure_ascii=False))

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
    "last_observe_distance_m": None,
    "last_observe_camera_distance_cm": None,
    "forward_after_last_observe_cm": 0.0,
    "approach_calls": 0,
    "last_observe_pose": None,
    "confirmation_track_id": None,
    "frame_track_ids": {},
}



def _observe_motion(odo=None):
    odo = odo if odo is not None else nav_odometry()
    last = STATE.get("last_observe_pose")
    current = [float(odo.get("rightCm", 0.0)), float(odo.get("forwardCm", 0.0)),
               float(odo.get("headingDeg", 0.0))]
    if last is None:
        return True, current, None, None
    moved = math.hypot(current[0] - last[0], current[1] - last[1])
    turned = abs(_wrap_deg(current[2] - last[2]))
    return moved >= OBS_MIN_TRANSLATION_CM or turned >= OBS_MIN_TURN_DEG, current, moved, turned


# BEGIN EXACT STANDALONE DETECTION FILTER
"""Conservative red/blue confidence filter; runtime inputs only.

The two cutoffs were selected on the authorized development observations.
They preserve the lowest-confidence labelled true observation of each class.
See the offline development provenance for support and unknown-label coverage.

This module does not modify observations, query a robot, estimate range, alter
confirmation, or use coordinates, layouts, package identities, or truth labels.
Confidence suppression is limited to the existing WM raw-distance window.
Outside that window, or without a finite measurement, the rule abstains.
This v2 scope change was proposed after v1 test feedback: that test is no
longer held out, even though supporting evidence uses development data only.
"""
import math

FILTER_VERSION = "confidence-floor-wm-window-v2"
CONFIDENCE_FLOORS = {"target": 0.84, "distractor": 0.80}


def detection_filter_update(observations, odometry=None, road_state=None, tick=None):
    """Return an exact, ordered partition of the original detection indices.

    Odometry, road state and tick are accepted for interface compatibility;
    no rule depends on them. In particular, clipped distance readings are
    never treated as localization points. The caller retains all raw logs.
    The runtime calls this top-level name for platform async transformation.
    """
    kept, rejected, diagnostics = [], [], []
    for index, observation in enumerate(observations):
        category = str(observation.get("category") or "").strip().lower()
        floor = CONFIDENCE_FLOORS.get(category)
        confidence = observation.get("confidence")
        valid = type(confidence) in (int, float) and math.isfinite(confidence)
        distance = observation.get("distanceCm")
        valid_distance = type(distance) in (int, float) and math.isfinite(distance)
        in_window = valid_distance and 40 <= distance < 90
        reject = floor is not None and valid and in_window and confidence < floor
        if reject:
            rejected.append(index)
            reason = "confidence_below_class_floor"
        else:
            kept.append(index)
            reason = ("class_not_filtered" if floor is None else
                      "unknown_confidence_retained" if not valid else
                      "unknown_distance_retained" if not valid_distance else
                      "outside_wm_window_retained" if not in_window else
                      "confidence_at_or_above_class_floor")
        diagnostics.append({"index": index, "keep": not reject, "reason": reason,
                            "category": category, "confidence": confidence,
                            "confidence_floor": floor, "distance_cm": distance,
                            "wm_window_eligible": in_window})
    return {"kept_indices": kept, "rejected_indices": rejected,
            "decisions": diagnostics, "filter_version": FILTER_VERSION}


class DetectionFilter:
    """Offline adapter; the robot runtime uses the top-level function."""

    def update(self, observations, odometry=None, road_state=None, tick=None):
        return detection_filter_update(observations, odometry, road_state, tick)
# END EXACT STANDALONE DETECTION FILTER


def counted_observe(category=None, confidence=0.6, targets_only=False):
    if STATE["observe_count"] >= MAX_OBSERVES:
        print("GY " + json.dumps({
            "event": "observe_budget_exhausted",
            "observe_count": STATE["observe_count"],
            "max_observes": MAX_OBSERVES,
        }, ensure_ascii=False))
        raise MissionFailure("observe_budget_exhausted")
    odo = nav_odometry() or {}
    ready, observed_pose, moved, turned = _observe_motion(odo)
    if not ready:
        print("GY " + json.dumps({"event": "observe_motion_violation", "tick": odo.get("tick"),
                                  "translationCm": moved, "turnDeg": turned, "odo": observed_pose,
                                  "requiredTranslationCm": OBS_MIN_TRANSLATION_CM,
                                  "requiredTurnDeg": OBS_MIN_TURN_DEG}, ensure_ascii=False))
        raise MissionFailure("observe_motion_violation")
    # 单次公开视觉查询取全部类别、全部置信度；日志之后才按调用目的筛选。
    result = query_observe(None, 0.0)
    STATE["observe_count"] += 1
    STATE["last_observe_pose"] = observed_pose
    raw = []
    for item in result or []:
        cat = str(item.get("category") or "").strip().lower()
        if cat in ("target", "distractor"):
            raw.append({"category": cat, "distanceCm": item.get("distanceCm"),
                        "bearingDeg": item.get("bearingDeg"), "confidence": item.get("confidence")})
    # 全部红/蓝原始检测（含窗口外、未喂给 WM 的）；tick 为 observe 前里程计 tick
    print("GY " + json.dumps({"event": "observe", "observe_count": STATE["observe_count"],
                              "tick": odo.get("tick"), "query": None, "confidence": 0.0,
                              "requested_category": category, "requested_confidence": confidence,
                              "odo": observed_pose, "translationSinceObserveCm": moved,
                              "turnSinceObserveDeg": turned,
                              "raw": raw}, ensure_ascii=False))
    # The raw red/blue log above is complete; filtering never mutates it.
    filter_input = list(result or [])
    filter_result = detection_filter_update(filter_input, odometry=odo, road_state=None, tick=odo.get("tick"))
    print("GY " + json.dumps({"event": "detection_filter", "tick": odo.get("tick"),
                              "observe_count": STATE["observe_count"],
                              "filter_sha256": DETECTION_FILTER_SHA256,
                              **filter_result}, ensure_ascii=False))
    result = [filter_input[index] for index in filter_result["kept_indices"]]
    result = [item for item in (result or []) if float(item.get("confidence") or 0.0) >= confidence]
    if category is not None:
        requested = str(category).strip().lower().replace("_", "-")
        requested = {"目标物": "target", "红球": "target", "混淆物": "distractor", "干扰物": "distractor",
                     "障碍物": "obstacle", "障碍": "obstacle", "存放点": "storage-zone", "存放区": "storage-zone",
                     "清理点": "cleanup-zone", "清理区": "cleanup-zone"}.get(requested, requested)
        result = [item for item in result if str(item.get("category") or "").lower() == requested]
    result = _demo_filter_observations(result, odometry_to_pose(odo))
    if targets_only:
        return [item for item in (result or []) if _is_target(item)]
    return result

def _wrap_deg(value):
    return (value + 180.0) % 360.0 - 180.0


def _pose_log(pose):
    """日志位姿 [x_m, z_m, headingDeg]。headingDeg 与 nav_odometry()["headingDeg"] 同号（左转为正），
    接近阶段与送货阶段统一用它；WorldModel 内部 yaw_rad（右转为正）不再直接打印。"""
    return [round(pose.x, 3), round(pose.z, 3), round(-math.degrees(pose.yaw_rad), 1)]

# ---- v26 测距标定：WorldModel 唯一观测入口 ----
# 常数来自 tools/calib_analyze.py（标定程序 programs/calib_range.py 在 map-03 以外布局采样，
# 真值由 driver 按 tick 从 record.samples 取）。只用运行时可得的 distanceCm / bearingDeg：
#   相机量程 rho = a + k * d / cos(beta)^p，相机位于车体中心前方 L cm；
#   车体系 forward = L + rho*cos(beta)，right = rho*sin(beta)；再换回车体中心的距离与方位。
# 选型 M5（artifacts/inloop/calib/ANALYSIS.md）：7 个布局 110 个样本（红 49 / 蓝 61），按站点 2/3 训练、
# 1/3 验证；验证集位置 RMSE 9.5cm（不修正 13.0cm），残差主要是逐球的系统偏差（±15cm，
# 读数与方位无法区分）。拟合出的 L=5.16cm 与平台相机前移 0.43 单位=5.375cm 一致。
# 取值只用于原始读数 40~95cm、|方位|<=35° 的范围（确认窗口 40~90cm 在其内）。
RANGE_CAL = {"L_cm": 5.1557, "a_cm": 1.6239, "k": 1.0187, "p": 1.0, "fit": "M5-calib-range-20260923"}


def calibrate_reading(distance_cm, bearing_deg):
    """(读数 cm, 方位 deg 右为正) → (车体中心距离 cm, 方位 deg)。"""
    beta = math.radians(float(bearing_deg))
    rho = RANGE_CAL["a_cm"] + RANGE_CAL["k"] * float(distance_cm) / (math.cos(beta) ** RANGE_CAL["p"])
    forward = RANGE_CAL["L_cm"] + rho * math.cos(beta)
    right = rho * math.sin(beta)
    return math.hypot(forward, right), math.degrees(math.atan2(right, forward))


def calibrated_detection(observation, pose, timestamp):
    """所有喂给 WorldModel 的检测都经过这里：先修正距离/方位，再做极坐标→世界坐标。"""
    raw_bearing = observation.get("bearingDeg")
    if raw_bearing is None or raw_bearing == "":
        return observation_to_detection(observation, pose, timestamp=timestamp)
    distance_cm, bearing_deg = calibrate_reading(observation.get("distanceCm"), raw_bearing)
    corrected = dict(observation)
    corrected["distanceCm"] = distance_cm
    corrected["bearingDeg"] = bearing_deg
    return observation_to_detection(corrected, pose, timestamp=timestamp)


def _is_target(observation):
    category = str(observation.get("category") or "").strip().lower()
    name = str(observation.get("name") or observation.get("label") or "").strip()
    return category == "target" or name in ("红球", "目标物")


def _update_wm(observations, pose, timestamp, memory_phase=True):
    """一帧一次 wm.update；memory_phase 时只喂 40~95cm 的 target。"""
    detections = []
    source_items = []
    STATE["frame_track_ids"] = {}
    printed = []
    for observation in observations:
        if not _is_target(observation):
            continue
        try:
            distance_cm = float(observation.get("distanceCm"))
        except (TypeError, ValueError):
            continue
        if not (distance_cm < CONFIRM_MAX_CM):
            continue
        if memory_phase and not (CONFIRM_MIN_CM <= distance_cm < CONFIRM_MAX_CM):
            continue
        detection = calibrated_detection(observation, pose, timestamp)
        detections.append(detection)
        source_items.append(observation)
        corr_cm, corr_deg = calibrate_reading(distance_cm, observation.get("bearingDeg") or 0.0)
        printed.append({
            "distanceCm": distance_cm,
            "bearingDeg": observation.get("bearingDeg"),
            "calDistanceCm": round(corr_cm, 1),
            "calBearingDeg": round(corr_deg, 2),
            "x": round(detection.x, 3),
            "z": round(detection.z, 3),
            "fed": True,
        })
    seen = [item for item in observations if _is_target(item)]
    outside = [{"distanceCm": item.get("distanceCm"), "bearingDeg": item.get("bearingDeg")}
               for item in seen if not any(p["distanceCm"] == item.get("distanceCm") and p["bearingDeg"] == item.get("bearingDeg")
                                           for p in printed)]
    # count = 喂给 WM 的数量；seen = 看到的红球总数；outside_window = 看到但不在 40~90cm 窗口、未喂给 WM 的
    print("GY " + json.dumps({"event": "target_observations", "count": len(printed), "seen": len(seen),
                              "items": printed, "outside_window": outside}, ensure_ascii=False))
    if detections:
        previous_tracks = wm.get_scene()
        assignments = associate(previous_tracks, detections, wm.aliases, wm.assoc_cfg, now=timestamp)
        previous_ids = {obj.obj_id for obj in previous_tracks}
        wm.update(detections, pose, now=timestamp)
        for track_index, detection_index in assignments.matches:
            STATE["frame_track_ids"][id(source_items[detection_index])] = previous_tracks[track_index].obj_id
        new_tracks = [obj for obj in wm.get_scene() if obj.obj_id not in previous_ids]
        for detection_index, obj in zip(assignments.unmatched_detections, new_tracks):
            STATE["frame_track_ids"][id(source_items[detection_index])] = obj.obj_id
        print("GY " + json.dumps({"event": "wm_associations", "tick": nav_odometry().get("tick"),
                                  "items": [{"distanceCm": item.get("distanceCm"),
                                             "bearingDeg": item.get("bearingDeg"),
                                             "track_id": STATE["frame_track_ids"].get(id(item))}
                                            for item in source_items]}, ensure_ascii=False))
        tracks = [
            {"id": obj.obj_id, "state": obj.state.value, "hit": obj.hit_count,
             "conf": round(obj.confidence, 3), "x": round(obj.x, 3), "z": round(obj.z, 3)}
            for obj in wm.get_scene() if obj.name == "target"
        ]
        print("GY " + json.dumps({"event": "wm_targets", "tracks": tracks}, ensure_ascii=False))

    # 每次 observe 后，以 WorldModel 当前目标位置重新起算记忆导航里程。
    target = _wm_target()
    if target is not None and target.state != ObjectState.LOST:
        distance_m = math.hypot(target.x - pose.x, target.z - pose.z)
        nearest_camera_cm = min((item["distanceCm"] for item in printed), default=None)
        STATE["last_observe_distance_m"] = distance_m
        STATE["last_observe_camera_distance_cm"] = nearest_camera_cm
        STATE["forward_after_last_observe_cm"] = 0.0
        print("GY " + json.dumps({
            "event": "last_observe",
            "wm_distance_m": round(distance_m, 3),
            "camera_distanceCm": nearest_camera_cm,
            "target": [round(target.x, 3), round(target.z, 3)],
            "pose": _pose_log(pose),
            "forward_after_last_observe_cm": 0.0,
        }, ensure_ascii=False))


def _target_confirmed():
    target = _wm_target()
    return target if target is not None and target.state == ObjectState.CONFIRMED else None

def _record_hit(pose, observation, detection, distance_cm):
    track_id = STATE["frame_track_ids"].get(id(observation))
    selected_id = STATE.get("confirmation_track_id")
    if track_id is None or (selected_id is not None and selected_id != track_id):
        _confirm_fail("hit_other_track", selected_track_id=selected_id, observed_track_id=track_id)
        return False
    x, z, yaw = pose.x, pose.z, pose.yaw_rad
    for hit in STATE["accepted_hits"]:
        gap_m = math.hypot(x - hit["pose_x"], z - hit["pose_z"])
        if gap_m < 0.15:
            distances = []
            for index, existing in enumerate(STATE["accepted_hits"]):
                distances.append({
                    "sample": index + 1,
                    "distance_m": round(math.hypot(x - existing["pose_x"], z - existing["pose_z"]), 4),
                })
            print("GY " + json.dumps({
                "event": "hit_duplicate_pose",
                "pose": [round(x, 3), round(z, 3)],
                "distanceCm": distance_cm,
                "nearest_gap_m": round(gap_m, 4),
                "required_gap_m": 0.15,
                "distances_to_existing_m": distances,
            }, ensure_ascii=False))
            return False
    STATE["accepted_hits"].append({
        "track_id": track_id,
        "pose_x": x, "pose_z": z, "pose_heading_deg": round(-math.degrees(yaw), 2),
        "distanceCm": distance_cm, "world_x": detection.x, "world_z": detection.z,
    })
    STATE["confirmation_track_id"] = track_id
    STATE["last_observed_world"] = (detection.x, detection.z)
    print("GY " + json.dumps({
        "event": "memory_hit",
        "pose": [round(x, 3), round(z, 3), round(-math.degrees(yaw), 1)],
        "distanceCm": distance_cm,
        "world": [round(detection.x, 3), round(detection.z, 3)],
        "track_id": track_id,
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
        if (CONFIRM_MIN_CM <= distance_cm < CONFIRM_MAX_CM
                and abs(float(item.get("bearingDeg") or 0.0)) <= CONFIRM_VIEW_MAX_BEARING_DEG):
            detection = calibrated_detection(item, pose, timestamp)
            candidates.append((distance_cm, item, detection))
    return candidates


def _confirm_fail(event, **fields):
    payload = {"event": event}
    payload.update(fields)
    print("GY " + json.dumps(payload, ensure_ascii=False))
    return None


def _ensure_confirmation_on_road(stage):
    state = nav_road_state()
    if not state.get("onRoad"):
        return _confirm_fail("confirmation_off_road",
                             stage=stage,
                             roadId=state.get("roadId"),
                             lateralOffsetCm=state.get("lateralOffsetCm"),
                             leftClearanceCm=state.get("leftClearanceCm"),
                             rightClearanceCm=state.get("rightClearanceCm"))
    return state


def _wm_target():
    target = wm.get_object(STATE.get("confirmation_track_id") or "target")
    if target is None or target.state == ObjectState.LOST:
        return None
    return target


def _wm_distance_m(pose):
    target = _wm_target()
    if target is None:
        return None
    return math.hypot(target.x - pose.x, target.z - pose.z)


def _wm_bearing_deg(pose):
    target = _wm_target()
    if target is None:
        return None
    return _wrap_deg(math.degrees(math.atan2(target.x - pose.x, target.z - pose.z) - pose.yaw_rad))


def _turn_to_wm_target_in_place(max_turns=10, tol_deg=8.0):
    """原地转向让 WorldModel 目标进入视野；不改变车辆位置。"""
    pose = odometry_to_pose(nav_odometry())
    start_bearing = _wm_bearing_deg(pose)
    turns = []
    ok = False
    for _ in range(max_turns):
        target = _wm_target()
        if target is None:
            break
        pose = odometry_to_pose(nav_odometry())
        bearing = _wm_bearing_deg(pose)
        if bearing is None:
            break
        if abs(bearing) <= tol_deg:
            ok = True
            break
        turn = min(abs(bearing), 40.0)
        if bearing > 0:
            motion_right_angle(turn)
            turns.append(round(-turn, 1))
        else:
            motion_left_angle(turn)
            turns.append(round(turn, 1))
    pose = odometry_to_pose(nav_odometry())
    bearing = _wm_bearing_deg(pose)
    if not ok:
        ok = bearing is not None and abs(bearing) <= max(12.0, tol_deg)
    _approach_event("approach_turn_in_place",
                    start_bearing_deg=round(start_bearing, 1) if start_bearing is not None else None,
                    end_bearing_deg=round(bearing, 1) if bearing is not None else None,
                    turnsDeg=turns, ok=bool(ok),
                    pose=_pose_log(pose))
    return ok


def _nearest_candidate(observations, pose, timestamp):
    candidates = _in_range_candidates(observations, pose, timestamp)
    track_id = STATE.get("confirmation_track_id")
    if track_id is not None:
        candidates = [candidate for candidate in candidates
                      if STATE["frame_track_ids"].get(id(candidate[1])) == track_id]
    if not candidates:
        return None
    return min(candidates, key=lambda value: value[0])


def uncalibrate_reading(distance_cm, bearing_deg):
    """calibrate_reading 的逆：车体中心距离/方位 → 预测的原始读数 distanceCm（相机量程反算）。"""
    beta_c = math.radians(float(bearing_deg))
    forward = float(distance_cm) * math.cos(beta_c) - RANGE_CAL["L_cm"]
    right = float(distance_cm) * math.sin(beta_c)
    rho = math.hypot(forward, right)
    beta = math.atan2(right, forward)
    return (rho - RANGE_CAL["a_cm"]) * (math.cos(beta) ** RANGE_CAL["p"]) / RANGE_CAL["k"]


def _record_candidate_sample(pose, candidate):
    distance_cm, item, detection = candidate
    if not _record_hit(pose, item, detection, distance_cm):
        return False
    previous_gap = None
    if len(STATE["accepted_hits"]) >= 2:
        latest = STATE["accepted_hits"][-1]
        previous = STATE["accepted_hits"][-2]
        previous_gap = math.hypot(latest["pose_x"] - previous["pose_x"],
                                 latest["pose_z"] - previous["pose_z"])
    print("GY " + json.dumps({
        "event": "confirmation_sample",
        "hits": len(STATE["accepted_hits"]),
        "camera_distanceCm": distance_cm,
        "wm_distance_m": _wm_distance_m(pose),
        "gap_to_previous_m": round(previous_gap, 3) if previous_gap is not None else None,
        "pose": [round(pose.x, 3), round(pose.z, 3)],
    }, ensure_ascii=False))
    return True




"""Runtime-only road geometry and viewpoint planning; embedded by the main program."""

VP_STATE = {"roads": {}, "intervals": {}, "explored": set(), "failed": set(), "nudged": set(), "canonical_hints": {}, "travel_attempts": set()}

# Public API contract: competition-core.js controller.exitEntryCm (line 117),
# take_exit landing construction (lines 3896-3910); not a scene-derived distance.
VP_EXIT_ENTRY_CM = 25.0


def _vp_event(event, **fields):
    print("GY " + json.dumps(dict(event=event, **fields), ensure_ascii=False))


def _vp_remember():
    odo = nav_odometry() or {}
    pose = odometry_to_pose(odo)
    state = nav_road_state() or {}
    road_id, progress = state.get("roadId"), state.get("roadProgressCm")
    if state.get("onRoad") and road_id in edge_by_road and progress is not None:
        yaw = pose.yaw_rad - math.radians(float(state.get("headingErrorDeg") or 0.0))
        offset = float(state.get("lateralOffsetCm") or 0.0) / 100.0
        sample = {"s": float(progress), "x": pose.x - offset * math.cos(yaw),
                  "z": pose.z + offset * math.sin(yaw), "yaw": yaw}
        samples = VP_STATE["roads"].setdefault(road_id, [])
        samples[:] = [item for item in samples if round(item["s"], 1) != round(sample["s"], 1)]
        samples.append(sample)
        samples.sort(key=lambda item: item["s"])
    return pose, state


def _vp_goal_unit(goal, pose):
    if "x" in goal:
        dx, dz = float(goal["x"]) - pose.x, float(goal["z"]) - pose.z
    else:
        dx, dz = float(goal["ux"]), float(goal["uz"])
    length = math.hypot(dx, dz)
    return (dx / length, dz / length) if length else (0.0, 0.0)


def _vp_canonical_unit(road_id, progress):
    samples = VP_STATE["roads"].get(road_id, [])
    pairs = [(a, b) for a, b in zip(samples, samples[1:])
             if b["s"] > a["s"] and any(start <= a["s"] and end >= b["s"]
                                        for start, end in VP_STATE["intervals"].get(road_id, []))]
    if not pairs:
        return VP_STATE.get("canonical_hints", {}).get(road_id)
    a, b = min(pairs, key=lambda pair: abs(progress - (pair[0]["s"] + pair[1]["s"]) / 2))
    dx, dz = b["x"] - a["x"], b["z"] - a["z"]
    length = math.hypot(dx, dz)
    return (dx / length, dz / length) if length else None


def _vp_path(state, road_id, progress, enter_only=False):
    current = edge_by_road.get(state.get("roadId"))
    target = edge_by_road.get(road_id)
    if current is None or target is None or state.get("roadProgressCm") is None:
        return None
    if road_id in blocked_roads:
        return None
    start_s = float(state["roadProgressCm"])
    plans = []
    if current["roadId"] == road_id and (not current["oneWay"] or progress >= start_s):
        direction = 1 if progress >= start_s else -1
        if not _road_progress_blocked(road_id, start_s, progress):
            plans.append({"cost_cm": abs(progress - start_s), "direct": True,
                          "direction": direction, "route": []})
    starts = [(current["toNodeId"], float(current["lengthCm"]) - start_s, 1)]
    if not current["oneWay"]:
        starts.append((current["fromNodeId"], start_s, -1))
    ends = [(target["fromNodeId"], progress)]
    if not target["oneWay"]:
        ends.append((target["toNodeId"], float(target["lengthCm"]) - progress))
    if enter_only:
        # A gateway names one endpoint of an unknown interval. Entering from
        # the other endpoint does not reach that gateway, even if it is cheaper.
        endpoint = target["fromNodeId"] if progress == 0.0 else target["toNodeId"]
        ends = [(node, distance) for node, distance in ends if node == endpoint]
    for node, initial_cm, direction in starts:
        endpoint_s = float(current["lengthCm"]) if direction > 0 else 0.0
        if _road_progress_blocked(current["roadId"], start_s, endpoint_s):
            continue
        for end_node, final_cm in ends:
            length = float(target["lengthCm"])
            entry_s = 0.0 if end_node == target["fromNodeId"] else length
            entry_sign = 1 if entry_s == 0.0 else -1
            nominal_landing = entry_s + entry_sign * min(length, VP_EXIT_ENTRY_CM)
            # take_exit may legally stop at an already measured clearance
            # boundary before its public 25cm maximum entry distance.
            landing = _road_progress_limit(road_id, entry_s, nominal_landing)
            entry_cm = abs(landing - entry_s)
            if entry_cm == 0:
                continue
            if enter_only:
                # An unknown frontier at the endpoint is a gateway, not a demand
                # to stop before the public take_exit landing position.
                final_cost_cm = entry_cm
            elif target["oneWay"] and final_cm < entry_cm:
                continue
            else:
                final_cost_cm = entry_cm + abs(final_cm - entry_cm)
            if not enter_only and _road_progress_blocked(road_id, landing, progress):
                continue
            route = dijkstra(node, end_node)
            if route is not None:
                plans.append({"cost_cm": initial_cm + route[1] + final_cost_cm, "direct": False,
                              "direction": direction, "entry_node": node,
                              "target_entry_node": end_node,
                              "landing_progress_cm": landing,
                              "route": list(route[0]) + [road_id]})
    return min(plans, key=lambda plan: plan["cost_cm"]) if plans else None


def _vp_points(pose, state):
    """Measured road samples and five-centimetre interpolation, without task filters."""
    points = {}
    grid = float(VIEW_GRID_CM)
    for road_id, samples in VP_STATE["roads"].items():
        for sample in samples:
            key = road_id + "@" + str(round(sample["s"], 1))
            points[key] = {"key": key, "roadId": road_id, "progressCm": sample["s"],
                           "x": sample["x"], "z": sample["z"], "geometry": "measured"}
        for left, right in zip(samples, samples[1:]):
            span = right["s"] - left["s"]
            traversed = any(start <= left["s"] and end >= right["s"]
                            for start, end in VP_STATE["intervals"].get(road_id, []))
            if span <= 0 or not traversed:
                continue
            for index in range(math.ceil(left["s"] / grid), math.floor(right["s"] / grid) + 1):
                progress = index * grid
                fraction = (progress - left["s"]) / span
                key = road_id + "@" + str(round(progress, 1))
                if key not in points:
                    points[key] = {"key": key, "roadId": road_id, "progressCm": progress,
                                   "x": left["x"] + fraction * (right["x"] - left["x"]),
                                   "z": left["z"] + fraction * (right["z"] - left["z"]),
                                   "geometry": "interpolated_measured_interval"}
    if state.get("roadId") and state.get("roadProgressCm") is not None:
        key = state["roadId"] + "@" + str(round(float(state["roadProgressCm"]), 1))
        points[key] = {"key": key, "roadId": state["roadId"], "progressCm": float(state["roadProgressCm"]),
                       "x": pose.x, "z": pose.z, "geometry": "current_pose"}
    return points


def _vp_candidates(goal, final_sample, tried):
    pose, state = _vp_remember()
    points = _vp_points(pose, state)
    candidates = []
    for key, point in points.items():
        reason = None
        if key in tried or key in VP_STATE["failed"]:
            reason = "already_tried"
        elif any(math.hypot(point["x"] - hit["pose_x"], point["z"] - hit["pose_z"]) < CONFIRM_MIN_GAP_M
                 for hit in STATE["accepted_hits"]):
            reason = "near_previous_hit"
        elif "x" in goal:
            distance = math.hypot(point["x"] - goal["x"], point["z"] - goal["z"])
            point["predicted_raw_cm"] = uncalibrate_reading(distance * 100.0, 0.0)
            if not CONFIRM_PREDICT_MIN_CM <= point["predicted_raw_cm"] <= CONFIRM_PREDICT_MAX_CM:
                reason = "predicted_raw_outside_window"
            elif final_sample and distance < CONFIRM_LAST_MIN_DIST_M:
                reason = "final_sample_too_close"
        elif ((point["x"] - goal["ray_x"]) * goal["ux"]
              + (point["z"] - goal["ray_z"]) * goal["uz"]) < 0:
            reason = "behind_bearing_ray"
        plan = None if reason else _vp_path(state, point["roadId"], point["progressCm"])
        if not reason and plan is None:
            reason = "no_legal_road_path"
        if reason:
            _vp_event("viewpoint_candidate_rejected", key=key, reason=reason,
                      predicted_raw_cm=point.get("predicted_raw_cm"))
            continue
        point["plan"] = plan
        point["path_cm"] = plan["cost_cm"]
        point["predicted_bearing_after_turn_deg"] = 0.0
        candidates.append(point)
    candidates.sort(key=lambda point: (point["path_cm"], point["key"]))
    _vp_event("viewpoint_candidates", count=len(candidates),
              chosen=candidates[0]["key"] if candidates else None)
    return candidates


def _vp_follow(max_cm, speed):
    """Follow in existing 10cm control steps; record geometry after every step."""
    remaining = float(max_cm)
    total = 0.0
    result = {"accepted": True, "distanceCm": 0.0, "stoppedBy": "max_distance"}
    _vp_remember()
    while round(remaining, 1) > 0:
        _, road_before = _vp_remember()
        before = nav_odometry() or {}
        if remaining < APPROACH_FOLLOW_STEP_CM:
            # The public drive API permits small final grid corrections; follow_road does not.
            state = nav_road_state() or {}
            if not state.get("onRoad"):
                return {"accepted": False, "distanceCm": total, "stoppedBy": "off_road"}
            align_to_current_road()
            motion_forward(round(remaining, 1))
            after = nav_odometry() or {}
            moved = max(0.0, float(after.get("distanceCm") or 0.0) - float(before.get("distanceCm") or 0.0))
            _, state = _vp_remember()
            result = {"accepted": bool(state.get("onRoad")), "distanceCm": moved,
                      "stoppedBy": "max_distance" if state.get("onRoad") else "off_road"}
        else:
            requested = min(remaining, float(APPROACH_FOLLOW_STEP_CM))
            result = motion_follow_road(requested, speed, True)
            _vp_remember()
            moved = float(result.get("distanceCm") or 0.0)
        _, road_after = _vp_remember()
        if (road_before.get("roadId") == road_after.get("roadId")
                and road_before.get("roadProgressCm") is not None
                and road_after.get("roadProgressCm") is not None):
            start, end = sorted((float(road_before["roadProgressCm"]), float(road_after["roadProgressCm"])))
            if start < end:
                intervals = VP_STATE["intervals"].setdefault(road_after["roadId"], [])
                intervals.append((start, end))
                merged = []
                for left, right in sorted(intervals):
                    if merged and left <= merged[-1][1]:
                        merged[-1] = (merged[-1][0], max(merged[-1][1], right))
                    else:
                        merged.append((left, right))
                intervals[:] = merged
        total += moved
        remaining -= moved
        if moved <= 0 or result.get("stoppedBy") != "max_distance" or not result.get("accepted", True):
            break
        if remaining > 0 and moved < float(APPROACH_FOLLOW_STEP_CM) and round(remaining, 1) > 0:
            break
    return dict(result, distanceCm=total)


def _vp_face_progress(direction, state):
    road_id = state.get("roadId")
    unit = _vp_canonical_unit(road_id, float(state.get("roadProgressCm") or 0.0))
    if unit is None:
        return False
    pose, state = _vp_remember()
    yaw = pose.yaw_rad - math.radians(float(state.get("headingErrorDeg") or 0.0))
    ahead = math.sin(yaw) * unit[0] + math.cos(yaw) * unit[1]
    align_to_current_road()
    if (ahead >= 0) != (direction > 0):
        motion_left_angle(180)
    _, now = _vp_remember()
    return bool(now.get("onRoad") and now.get("roadId") == road_id)


def _vp_prepare_node():
    pose, state = _vp_remember()
    if state.get("atNode") and state.get("exits"):
        return pose, state
    key = (state.get("roadId"), round(float(state.get("roadProgressCm") or 0.0), 1))
    if key not in VP_STATE["nudged"] and state.get("onRoad"):
        VP_STATE["nudged"].add(key)
        front = state.get("frontClearanceCm")
        if front is None or float(front) >= NODE_NUDGE_CM:
            motion_forward(NODE_NUDGE_CM)
            pose, state = _vp_remember()
            _vp_event("viewpoint_node_nudge", distanceCm=NODE_NUDGE_CM,
                      atNode=state.get("atNode"), nodeId=state.get("nodeId"))
    return pose, state



def _vp_block_current_direction(before_state, planned_direction=None):
    """Record a local clearance boundary in the actual attempted direction."""
    pose, state = _vp_remember()
    road_id = state.get("roadId")
    edge = edge_by_road.get(road_id)
    if edge is None or not state.get("onRoad"):
        return False
    direction = None
    if before_state.get("roadId") == road_id:
        delta = float(state.get("roadProgressCm") or 0.0) - float(before_state.get("roadProgressCm") or 0.0)
        if round(delta, 1) != 0:
            direction = 1 if delta > 0 else -1
    unit = _vp_canonical_unit(road_id, float(state.get("roadProgressCm") or 0.0))
    if direction is None and unit is not None:
        yaw = pose.yaw_rad - math.radians(float(state.get("headingErrorDeg") or 0.0))
        direction = 1 if math.sin(yaw) * unit[0] + math.cos(yaw) * unit[1] >= 0 else -1
    if direction is None and before_state.get("roadId") == road_id:
        direction = planned_direction
    if direction is None:
        return False
    progress = float(state.get("roadProgressCm") or 0.0)
    key = (road_id, direction, round(progress, 1))
    blocks = VP_STATE.setdefault("local_blocks", {})
    previous = blocks.get(key)
    stop = progress if previous is None else (min(previous, progress) if direction > 0 else max(previous, progress))
    changed = previous != stop
    blocks[key] = stop
    _vp_event("viewpoint_local_clearance_blocked", roadId=road_id, direction=direction,
              roadProgressCm=progress, stopProgressCm=stop, changed=changed,
              scope="crossing_measured_stop_only")
    return changed


def _vp_enter(road_id):
    before, state = _vp_prepare_node()
    if not state.get("onRoad") or not any(item.get("roadId") == road_id for item in state.get("exits", [])):
        return False
    result = motion_take_exit(road_id, SLOW_SPEED, True)
    after, now = _vp_remember()
    moved = math.hypot(after.x - before.x, after.z - before.z)
    edge = edge_by_road.get(road_id)
    if (edge is not None and now.get("roadId") == road_id and now.get("onRoad")
            and state.get("nodeId") in (edge["fromNodeId"], edge["toNodeId"]) and moved > 0):
        # The entry endpoint fixes canonical direction; this is a local tangent, not a road extrapolation.
        sign = 1 if state["nodeId"] == edge["fromNodeId"] else -1
        yaw = after.yaw_rad - math.radians(float(now.get("headingErrorDeg") or 0.0))
        VP_STATE.setdefault("canonical_hints", {})[road_id] = (sign * math.sin(yaw), sign * math.cos(yaw))
    if result.get("stoppedBy") == "front_clearance":
        _vp_block_current_direction(state)
    _vp_event("viewpoint_take_exit", roadId=road_id, distanceCm=result.get("distanceCm"),
              stoppedBy=result.get("stoppedBy"), actualRoadId=now.get("roadId"),
              actualProgressCm=now.get("roadProgressCm"))
    return bool(result.get("accepted") and now.get("onRoad") and moved > 0)


def _vp_finish_travel(result):
    VP_STATE["travel_attempts"] = set()
    VP_STATE["travel_active"] = None
    return result


def _vp_travel(candidate):
    if VP_STATE.get("travel_active") != candidate["key"]:
        VP_STATE["travel_attempts"] = set()
        VP_STATE["travel_active"] = candidate["key"]
    pose, state = _vp_remember()
    plan = _vp_path(state, candidate["roadId"], candidate["progressCm"], candidate.get("enter_only", False))
    reason = None
    if plan is not None:
        key = (candidate["key"], state.get("roadId"), round(float(state.get("roadProgressCm") or 0.0), 1),
               plan["direction"], plan.get("entry_node"), tuple(plan["route"]), _vp_block_revision())
        attempted = VP_STATE.setdefault("travel_attempts", set())
        if key in attempted:
            _vp_event("viewpoint_unreachable", key=candidate["key"], reason="repeated_travel_state")
            return _vp_finish_travel("unreachable")
        attempted.add(key)
    if plan is None:
        reason = "no_legal_road_path"
    elif plan["direct"]:
        delta = candidate["progressCm"] - float(state["roadProgressCm"])
        if round(delta, 1) == 0:
            return _vp_finish_travel("arrived")
        if not _vp_face_progress(plan["direction"], state):
            reason = "canonical_direction_unknown_or_road_changed"
        else:
            result = _vp_follow(abs(delta), SLOW_SPEED)
            _, now = _vp_remember()
            if result.get("stoppedBy") == "front_clearance" and _vp_block_current_direction(state, plan["direction"]):
                return "replan"
            if now.get("roadId") != candidate["roadId"]:
                if result.get("distanceCm", 0) > 0:
                    return "replan"
                VP_STATE["failed"].add(candidate["key"])
                _vp_event("viewpoint_unreachable", key=candidate["key"], reason="road_changed_without_translation")
                return _vp_finish_travel("unreachable")
            if round(float(now.get("roadProgressCm") or 0.0) - candidate["progressCm"], 1) == 0:
                return _vp_finish_travel("arrived")
            if (result.get("stoppedBy") == "max_distance"
                    and round(float(now.get("roadProgressCm") or 0.0) - float(state["roadProgressCm"]), 1) != 0):
                _vp_event("viewpoint_progress_replan", key=candidate["key"],
                          actualProgressCm=now.get("roadProgressCm"), requestedProgressCm=candidate["progressCm"])
                return "replan"
            reason = "stopped_before_candidate:" + str(result.get("stoppedBy"))
    else:
        if not _vp_face_progress(plan["direction"], state):
            reason = "canonical_direction_unknown_or_road_changed"
        else:
            edge = edge_by_road[state["roadId"]]
            distance = (float(edge["lengthCm"]) - float(state["roadProgressCm"]) if plan["direction"] > 0
                        else float(state["roadProgressCm"]))
            if round(distance, 1) > 0:
                result = _vp_follow(distance, SLOW_SPEED)
                if result.get("stoppedBy") == "front_clearance" and _vp_block_current_direction(state, plan["direction"]):
                    return "replan"
                if result.get("stoppedBy") not in ("junction", "road_end", "max_distance"):
                    reason = "transition_approach:" + str(result.get("stoppedBy"))
            if reason is None:
                _, now = _vp_prepare_node()
                if now.get("nodeId") != plan["entry_node"]:
                    reason = "different_transition_node"
                else:
                    blocked_before = _vp_block_revision()
                    if _vp_enter(plan["route"][0]) or _vp_block_revision() != blocked_before:
                        return "replan"
                    reason = "planned_exit_unavailable_or_blocked"
    VP_STATE["failed"].add(candidate["key"])
    _vp_event("viewpoint_unreachable", key=candidate["key"], reason=reason)
    return _vp_finish_travel("unreachable")


def _vp_explore_unit(goal, pose):
    """Choose exploration travel direction; do not change target aiming semantics."""
    unit = _vp_goal_unit(goal, pose)
    if "x" in goal:
        distance_cm = math.hypot(goal["x"] - pose.x, goal["z"] - pose.z) * 100.0
        if uncalibrate_reading(distance_cm, 0.0) < CONFIRM_PREDICT_MIN_CM:
            return -unit[0], -unit[1]
    return unit


def _vp_explore(goal, tried):
    pose, state = _vp_remember()
    road_id = state.get("roadId")
    if not state.get("onRoad") or road_id not in edge_by_road or road_id in blocked_roads:
        return False
    if state.get("atNode") and state.get("exits"):
        unit = _vp_explore_unit(goal, pose)
        desired = math.atan2(unit[0], unit[1])
        choices = []
        for item in state["exits"]:
            exit_road = item.get("roadId")
            key = (state.get("nodeId"), exit_road)
            if exit_road not in edge_by_road or exit_road in blocked_roads or key in VP_STATE["explored"]:
                continue
            edge = edge_by_road[exit_road]
            if edge["oneWay"] and state.get("nodeId") != edge["fromNodeId"]:
                continue
            entry_s = 0.0 if state.get("nodeId") == edge["fromNodeId"] else float(edge["lengthCm"])
            end_s = float(edge["lengthCm"]) - entry_s
            if _road_progress_limit(exit_road, entry_s, end_s) == entry_s:
                continue
            yaw = pose.yaw_rad - math.radians(float(item.get("turnDeg") or 0.0))
            covered = sum(end - start for start, end in VP_STATE["intervals"].get(exit_road, []))
            choices.append((covered >= float(edge["lengthCm"]), abs(_wrap_deg(math.degrees(yaw - desired))), exit_road, key))
        for _, _, exit_road, key in sorted(choices):
            VP_STATE["explored"].add(key)
            if _vp_enter(exit_road):
                return True
        return False
    before = pose
    unit = _vp_explore_unit(goal, pose)
    yaw = pose.yaw_rad - math.radians(float(state.get("headingErrorDeg") or 0.0))
    edge = edge_by_road[road_id]
    toward = math.sin(yaw) * unit[0] + math.cos(yaw) * unit[1] >= 0
    directions = [False] if edge["oneWay"] else ([False, True] if toward else [True, False])
    canonical = _vp_canonical_unit(road_id, float(state.get("roadProgressCm") or 0.0))
    for going_back in directions:
        planned_yaw = yaw + (math.pi if going_back else 0.0)
        key = ("step", road_id, round(float(state.get("roadProgressCm") or 0.0), 1),
               round(_wrap_deg(math.degrees(planned_yaw)), 1))
        if key in VP_STATE["explored"]:
            continue
        if canonical is not None:
            positive = math.sin(planned_yaw) * canonical[0] + math.cos(planned_yaw) * canonical[1] >= 0
            start_s = float(state.get("roadProgressCm") or 0.0)
            end_s = float(edge["lengthCm"]) if positive else 0.0
            if _road_progress_limit(road_id, start_s, end_s) == start_s or (edge["oneWay"] and not positive):
                continue
        elif (any(item[2] == road_id for item in blocked_directions)
              or any(item[0] == road_id for item in VP_STATE.get("local_blocks", {}))):
            # Do not guess canonical orientation when a directional restriction exists.
            continue
        VP_STATE["explored"].add(key)
        live_pose, live_state = _vp_remember()
        if live_state.get("roadId") != road_id:
            return False
        live_yaw = live_pose.yaw_rad - math.radians(float(live_state.get("headingErrorDeg") or 0.0))
        align_to_current_road()
        if math.cos(live_yaw - planned_yaw) < 0:
            motion_left_angle(180)
        _, aligned = _vp_remember()
        if aligned.get("roadId") != road_id or not aligned.get("onRoad"):
            return False
        result = _vp_follow(APPROACH_FOLLOW_STEP_CM, SLOW_SPEED)
        after, now = _vp_remember()
        if math.hypot(after.x - before.x, after.z - before.z) > 0:
            return True
        if result.get("stoppedBy") in ("junction", "road_end"):
            after, now = _vp_prepare_node()
            if math.hypot(after.x - before.x, after.z - before.z) > 0:
                return True
            if now.get("atNode") and now.get("exits") and _vp_explore(goal, tried):
                return True
        elif result.get("stoppedBy") in ("off_road", "wrong_way", "collision"):
            return False
        _vp_event("viewpoint_exploration_direction_failed", roadId=road_id,
                  roadProgressCm=state.get("roadProgressCm"), stoppedBy=result.get("stoppedBy"),
                  distanceCm=result.get("distanceCm"))
    _vp_event("viewpoint_exploration_exhausted", roadId=road_id,
              roadProgressCm=state.get("roadProgressCm"))
    return False


def _planning_goal(pose, observations, previous=None):
    target = _wm_target()
    if target is not None:
        return {"x": target.x, "z": target.z, "source": "world_model", "track_id": target.obj_id}
    visible = [item for item in observations if _is_target(item) and item.get("distanceCm") is not None]
    if not visible:
        return previous
    item = min(visible, key=lambda value: float(value["distanceCm"]))
    if float(item["distanceCm"]) < 100.0:
        det = calibrated_detection(item, pose, float(nav_odometry().get("tick", 0)) * 0.02)
        return {"x": det.x, "z": det.z, "source": "uncapped_planning_only"}
    yaw = pose.yaw_rad + math.radians(float(item.get("bearingDeg") or 0.0))
    return {"ray_x": pose.x, "ray_z": pose.z, "ux": math.sin(yaw), "uz": math.cos(yaw),
            "source": "capped_bearing_only"}


def _aim_planning_goal(goal):
    pose, state = _vp_remember()
    if not state.get("onRoad"):
        raise MissionFailure("confirmation_off_road")
    ux, uz = _vp_goal_unit(goal, pose)
    bearing = _wrap_deg(math.degrees(math.atan2(ux, uz) - pose.yaw_rad))
    # The motion API accepts angles >= 1 degree. This is an API limit, not a fit.
    if abs(bearing) >= 1.0:
        if bearing > 0:
            motion_right_angle(abs(bearing))
        else:
            motion_left_angle(abs(bearing))
    pose, state = _vp_remember()
    ux, uz = _vp_goal_unit(goal, pose)
    final_bearing = _wrap_deg(math.degrees(math.atan2(ux, uz) - pose.yaw_rad))
    _vp_event("viewpoint_aim", beforeBearingDeg=bearing, afterBearingDeg=final_bearing,
              onRoad=state.get("onRoad"), pose=_pose_log(pose))
    if not state.get("onRoad"):
        raise MissionFailure("confirmation_off_road")
    return abs(final_bearing) <= CONFIRM_VIEW_MAX_BEARING_DEG


def _viewpoint_actual_constraints(goal, final_sample):
    pose, state = _vp_remember()
    if not state.get("onRoad"):
        raise MissionFailure("confirmation_off_road")
    gaps = [math.hypot(pose.x - hit["pose_x"], pose.z - hit["pose_z"])
            for hit in STATE["accepted_hits"]]
    if any(gap < CONFIRM_MIN_GAP_M for gap in gaps):
        return "actual_pose_near_previous_hit"
    if "x" in goal:
        distance = math.hypot(goal["x"] - pose.x, goal["z"] - pose.z)
        predicted = uncalibrate_reading(distance * 100.0, 0.0)
        if not CONFIRM_PREDICT_MIN_CM <= predicted <= CONFIRM_PREDICT_MAX_CM:
            return "actual_predicted_raw_outside_window"
        if final_sample and distance < CONFIRM_LAST_MIN_DIST_M:
            return "actual_final_sample_too_close"
    return None


def _confirmation_result(pose):
    target = _target_confirmed()
    if target is None:
        return _confirm_fail("confirmation_failed", reason="target_not_confirmed")
    hits = STATE["accepted_hits"]
    if len(hits) != 3 or any(hit["track_id"] != target.obj_id for hit in hits):
        return _confirm_fail("confirmation_failed", reason="three_hits_same_track_required")
    last_distance = _wm_distance_m(pose)
    if last_distance is None or last_distance < CONFIRM_LAST_MIN_DIST_M:
        return _confirm_fail("confirmation_failed", reason="last_sample_too_close", wm_distance_m=last_distance)
    if any(math.hypot(a["pose_x"] - b["pose_x"], a["pose_z"] - b["pose_z"]) < CONFIRM_MIN_GAP_M
           for index, a in enumerate(hits) for b in hits[index + 1:]):
        return _confirm_fail("confirmation_failed", reason="sample_gap_too_small")
    STATE["confirmation_distance_cm"] = hits[-1]["distanceCm"]
    _vp_event("memory_confirmed", hits=hits, track_id=target.obj_id,
              confirmation_distanceCm=STATE["confirmation_distance_cm"],
              last_sample_wm_distance_m=last_distance)
    return target


def _try_enter_range_and_confirm(pose, observations):
    """One graph planner handles range entry and all confirmation viewpoints."""
    goal = _planning_goal(pose, observations)
    if goal is None:
        return None
    tried, failures = set(), []
    timestamp = float(nav_odometry().get("tick", 0)) * 0.02
    first = _nearest_candidate(observations, pose, timestamp)
    if first is not None:
        _record_candidate_sample(pose, first)
    while len(STATE["accepted_hits"]) < 3:
        goal = _planning_goal(pose, [], goal)
        final_sample = len(STATE["accepted_hits"]) == 2
        candidates = _vp_candidates(goal, final_sample, tried)
        if not candidates:
            if _vp_explore(goal, tried):
                pose, _ = _vp_remember()
                continue
            return _confirm_fail("confirmation_failed", reason="all_viewpoints_tried_or_unreachable",
                                 hits=len(STATE["accepted_hits"]), failures=failures)
        selected = candidates[0]
        _vp_event("viewpoint_selected", key=selected["key"], roadId=selected["roadId"],
                  progressCm=selected["progressCm"], point=[selected["x"], selected["z"]],
                  pathCm=selected["path_cm"], predictedRawCm=selected.get("predicted_raw_cm"),
                  reason="shortest_legal_road_path", goalSource=goal["source"], candidates=len(candidates))
        result = _vp_travel(selected)
        if result == "replan":
            pose, _ = _vp_remember()
            continue
        tried.add(selected["key"])
        reason = "unreachable" if result != "arrived" else _viewpoint_actual_constraints(goal, final_sample)
        if reason is None and not _aim_planning_goal(goal):
            reason = "target_outside_bearing_window_after_turn"
        if reason is None and not _observe_motion()[0]:
            reason = "no_new_observation_motion"
        if reason is None:
            observations = counted_observe(None, 0.4, targets_only=True)
            pose, _ = _vp_remember()
            timestamp = float(nav_odometry().get("tick", 0)) * 0.02
            _opt2_update_observations(observations, pose, timestamp, memory_phase=True)
            if _opt2_planning_evidence_expired(goal, observations):
                return None
            goal = _planning_goal(pose, observations, goal)
            candidate = _nearest_candidate(observations, pose, timestamp)
            distance = _wm_distance_m(pose)
            if candidate is None:
                reason = "no_same_track_hit_in_window"
            elif final_sample and (distance is None or distance < CONFIRM_LAST_MIN_DIST_M):
                reason = "fused_final_sample_too_close"
            elif not _record_candidate_sample(pose, candidate):
                reason = "hit_rejected"
        if reason is not None:
            failures.append({"key": selected["key"], "reason": reason})
            _vp_event("viewpoint_failed", key=selected["key"], reason=reason)
    return _confirmation_result(pose)


def patrol_until_target_seen(max_obs=80):
    """Patrol public roads; only query after real movement or a sufficient turn."""
    visited = set()
    for _step in range(24):
        if STATE["observe_count"] >= max_obs:
            return None
        pose, state = _vp_remember()
        if not state.get("onRoad"):
            raise MissionFailure("patrol_off_road")
        if _observe_motion()[0]:
            observations = counted_observe(None, 0.4, targets_only=True)
            timestamp = float(nav_odometry().get("tick", 0)) * 0.02
            _opt2_update_observations(observations, pose, timestamp, memory_phase=True)
            target = _try_enter_range_and_confirm(pose, observations)
            if target is not None:
                return target
            if _opt2_confirmation_should_abort():
                return _confirm_fail("confirmation_aborted", reason="target_seen_but_confirmation_failed")
        _, state = _vp_remember()
        exits = [item for item in state.get("exits", []) if item.get("roadId")]
        choices = [item for item in exits if item["roadId"] not in visited] or exits
        if not choices:
            align_to_current_road()
            motion_left_angle(180)
            _opt2_patrol_follow(150, 30)
            _vp_prepare_node()
            continue
        chosen = choices[0]
        if not _opt2_patrol_enter(chosen["roadId"]):
            return _confirm_fail("patrol_failed", reason="exit_unavailable", roadId=chosen["roadId"])
        visited.add(chosen["roadId"])
        for _ in range(2):
            result = _opt2_patrol_follow(150, 30)
            if STATE["observe_count"] >= max_obs:
                return None
            pose, state = _vp_remember()
            if not state.get("onRoad"):
                raise MissionFailure("patrol_off_road")
            if _observe_motion()[0]:
                observations = counted_observe(None, 0.4, targets_only=True)
                timestamp = float(nav_odometry().get("tick", 0)) * 0.02
                _opt2_update_observations(observations, pose, timestamp, memory_phase=True)
                target = _try_enter_range_and_confirm(pose, observations)
                if target is not None:
                    return target
                if _opt2_confirmation_should_abort():
                    return _confirm_fail("confirmation_aborted", reason="target_seen_but_confirmation_failed")
            if result.get("stoppedBy") != "max_distance":
                _vp_prepare_node()
                break
    return None


def _approach_event(event, **fields):
    payload = {"event": event}
    payload.update(fields)
    print("GY " + json.dumps(payload, ensure_ascii=False))


def _approach_on_road(stage):
    state = nav_road_state()
    if not state.get("onRoad"):
        _approach_event("approach_on_road_violation", stage=stage,
                        roadId=state.get("roadId"), onRoad=False,
                        lateralOffsetCm=state.get("lateralOffsetCm"))
        return None
    return state


def _turn_toward_bearing(bearing):
    if bearing > 8.0:
        motion_right_angle(min(abs(bearing), 30.0))
    elif bearing < -8.0:
        motion_left_angle(min(abs(bearing), 30.0))




def _approach_memory_move(step_cm):
    """小步 follow_road；0cm 由调用方按路口处理。"""
    state = _approach_on_road("before_memory_follow")
    if state is None:
        return None
    pose = odometry_to_pose(nav_odometry())
    target = _wm_target()
    if target is None or target.state == ObjectState.LOST:
        _approach_event("approach_failed", reason="target_lost_before_memory_follow")
        return None
    bearing = _wm_bearing_deg(pose)
    if bearing is None:
        return None
    if abs(bearing) > 90.0:
        motion_left_angle(180.0)
        state = _approach_on_road("after_memory_turn_around")
        if state is None:
            return None
    result = motion_follow_road(float(step_cm), SLOW_SPEED, True)
    state = _approach_on_road("after_memory_follow")
    if state is None:
        return None
    moved_cm = float(result.get("distanceCm") or 0.0)
    STATE["forward_after_last_observe_cm"] += moved_cm
    stopped = str(result.get("stoppedBy") or "")
    blocked = stopped in ("front_clearance", "collision", "safety_limit")
    if blocked:
        pose = odometry_to_pose(nav_odometry())
        near_m = _wm_distance_m(pose)
        if near_m is not None and near_m <= APPROACH_BLOCKED_ARRIVAL_MAX_M:
            _approach_event("approach_blocked_near_target", stoppedBy=stopped,
                            distanceCm=round(moved_cm, 1), wm_distance_m=round(near_m, 3))
            return {"moved_cm": moved_cm, "result": result, "state": state, "blocked": True}
    if stopped in ("front_clearance", "collision", "safety_limit", "off_road", "wrong_way"):
        _approach_event("approach_failed", reason="memory_follow_stopped",
                        stoppedBy=stopped, distanceCm=moved_cm)
        return None
    return {"moved_cm": moved_cm, "result": result, "state": state, "blocked": False}






"""Road-graph approach using runtime geometry only; embedded by the main program."""


def _mag_candidates(pose, state, target, tried):
    candidates = []
    for point in _vp_points(pose, state).values():
        if point["key"] in tried:
            continue
        distance = math.hypot(point["x"] - target.x, point["z"] - target.z)
        if distance > APPROACH_FINE_DISTANCE_M:
            continue
        plan = _vp_path(state, point["roadId"], point["progressCm"])
        if plan is not None:
            candidates.append(dict(point, plan=plan, path_cm=plan["cost_cm"], wm_distance_m=distance))
    return sorted(candidates, key=lambda point: (point["path_cm"], point["key"]))


def _mag_node_bounds(target, points):
    """Triangle-inequality lower bounds to the existing capture disk, in cm.

    At a measured point p, h(p)=max(0, |p-target|-fine_radius). An endpoint
    at road-arc distance d has h(node)>=h(p)-d. Propagating that inequality
    through graph lengths gives bounds without inventing endpoint coordinates.
    Directional blocks do not remove the geometric inequality of a real road.
    """
    bounds = {}
    adjacency = {}
    for road_id, edge in edge_by_road.items():
        a, b, length = edge["fromNodeId"], edge["toNodeId"], float(edge["lengthCm"])
        bounds.setdefault(a, 0.0)
        bounds.setdefault(b, 0.0)
        adjacency.setdefault(a, []).append((b, length))
        adjacency.setdefault(b, []).append((a, length))
    for point in points.values():
        edge = edge_by_road[point["roadId"]]
        center = point
        if point.get("geometry") == "current_pose":
            samples = VP_STATE["roads"].get(point["roadId"], [])
            center = next((item for item in samples if round(item["s"] - point["progressCm"], 1) == 0), None)
            if center is None:
                continue
        bound = max(0.0, (math.hypot(center["x"] - target.x, center["z"] - target.z)
                          - APPROACH_FINE_DISTANCE_M) * 100.0)
        for node, distance in ((edge["fromNodeId"], point["progressCm"]),
                               (edge["toNodeId"], float(edge["lengthCm"]) - point["progressCm"])):
            bounds[node] = max(bounds[node], bound - distance)
    remaining = set(bounds)
    while remaining:
        node = max(remaining, key=lambda item: bounds[item])
        remaining.remove(node)
        for neighbor, length in adjacency[node]:
            if neighbor in remaining:
                bounds[neighbor] = max(bounds[neighbor], bounds[node] - length)
    return bounds


def _mag_frontiers(pose, state, target, failed):
    """Plan to measured boundaries of unknown intervals, including unseen graph edges."""
    candidates = []
    points = _vp_points(pose, state)
    node_bounds = _mag_node_bounds(target, points)
    for road_id, edge in edge_by_road.items():
        if road_id in blocked_roads:
            continue
        length = float(edge["lengthCm"])
        covered = list(VP_STATE["intervals"].get(road_id, []))
        covered.extend((item["s"], item["s"]) for item in VP_STATE["roads"].get(road_id, []))
        merged = []
        for left, right in sorted(covered):
            left, right = max(0.0, float(left)), min(length, float(right))
            if merged and left <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], right))
            else:
                merged.append((left, right))
        cursor = 0.0
        gaps = []
        for left, right in merged:
            if round(left - cursor, 1) > 0:
                gaps.append((cursor, left))
            cursor = max(cursor, right)
        if round(length - cursor, 1) > 0:
            gaps.append((cursor, length))
        for left, right in gaps:
            for progress, end, direction in ((left, right, 1), (right, left, -1)):
                if edge["oneWay"] and direction < 0:
                    continue
                end = _road_progress_limit(road_id, progress, end)
                if round(direction * (end - progress), 1) <= 0:
                    continue
                frontier_key = (road_id, direction, round(end, 1))
                if frontier_key in failed:
                    continue
                key = road_id + "@" + str(round(progress, 1))
                point = points.get(key)
                enter_only = point is None and progress in (0.0, length)
                plan = _vp_path(state, road_id, progress, enter_only)
                if plan is None:
                    continue
                # Unknown boundaries get graph-propagated distance bounds, not coordinates.
                distance = (math.hypot(point["x"] - target.x, point["z"] - target.z)
                            if point is not None else None)
                evaluation_progress = (plan["landing_progress_cm"]
                                       if enter_only and not plan["direct"] else progress)
                if (enter_only and not plan["direct"]
                        and any(round(evaluation_progress - left, 1) >= 0
                                and round(right - evaluation_progress, 1) >= 0 for left, right in merged)):
                    # An unknown endpoint cannot be explored by re-entering at
                    # the same known landing. The measured landing instead has
                    # its own directed frontier into each still-unknown gap.
                    _approach_event("approach_frontier_rejected", key=key,
                                    reason="gateway_landing_already_measured",
                                    landingProgressCm=evaluation_progress)
                    continue
                remaining_bound = (max(0.0, (distance - APPROACH_FINE_DISTANCE_M) * 100.0)
                                   if distance is not None else
                                   max(0.0, node_bounds[edge["fromNodeId"]] - evaluation_progress,
                                       node_bounds[edge["toNodeId"]] - (length - evaluation_progress)))
                unit = _vp_canonical_unit(road_id, progress)
                toward = 0.0
                if point is not None and unit is not None:
                    toward = direction * (unit[0] * (target.x - point["x"])
                                          + unit[1] * (target.z - point["z"]))
                candidates.append({"key": key, "roadId": road_id, "progressCm": progress,
                                   "endCm": end, "direction": direction, "frontier_key": frontier_key,
                                   "plan": plan, "path_cm": plan["cost_cm"],
                                   "enter_only": enter_only, "remaining_bound_cm": remaining_bound,
                                   "score_cm": plan["cost_cm"] + remaining_bound,
                                   "boundary_distance_m": distance, "toward": toward})
    return sorted(candidates, key=lambda point: (point["score_cm"], point["path_cm"],
                                                -point["toward"], point["key"], point["direction"]))


def _mag_frontier_step(frontier, state):
    """Extend one selected unknown interval without reacting to target bearing."""
    road_id = frontier["roadId"]
    if (state.get("roadId") != road_id
            or round(float(state["roadProgressCm"]) - frontier["progressCm"], 1) != 0):
        return _vp_travel(frontier)
    direction = frontier["direction"]
    if not _vp_face_progress(direction, state):
        _approach_event("approach_frontier_failed", roadId=road_id,
                        reason="canonical_direction_unknown_or_road_changed")
        return "unreachable"
    _, aligned = _vp_remember()
    before = float(aligned.get("roadProgressCm") or 0.0)
    remaining = direction * (frontier["endCm"] - before)
    if round(remaining, 1) <= 0:
        return "replan"
    result = _vp_follow(min(float(APPROACH_FOLLOW_STEP_CM), remaining), SLOW_SPEED)
    _, after = _vp_remember()
    _approach_event("approach_frontier_step", roadId=road_id, direction=direction,
                    beforeProgressCm=before, afterProgressCm=after.get("roadProgressCm"),
                    distanceCm=result.get("distanceCm"), stoppedBy=result.get("stoppedBy"))
    if not after.get("onRoad"):
        return "off_road"
    if result.get("stoppedBy") == "front_clearance" and _vp_block_current_direction(state, direction):
        return "replan"
    if after.get("roadId") != road_id:
        return "replan" if result.get("distanceCm", 0) > 0 else "unreachable"
    if result.get("stoppedBy") in ("junction", "road_end"):
        # Even a positive 7cm junction stop needs an exit decision. Do not reverse
        # toward the local Euclidean minimum or repeatedly nudge the same endpoint.
        _vp_prepare_node()
        return "unreachable"
    moved = direction * (float(after.get("roadProgressCm") or 0.0) - before)
    if moved <= 0 or not result.get("accepted", True):
        return "unreachable"
    if result.get("stoppedBy") != "max_distance":
        return "unreachable"
    return "replan"


def _approach_graph_navigation(target):
    """Reach an actual on-road pose within the existing fine-approach distance."""
    tried, failed_frontiers, attempted = set(), set(), set()
    track_id = target.obj_id
    while True:
        pose, state = _vp_remember()
        live_target = _wm_target()
        if live_target is None or live_target.obj_id != track_id or live_target.state == ObjectState.LOST:
            _approach_event("approach_failed", reason="memory_graph_target_lost_or_changed", track_id=track_id)
            return False
        target = live_target
        if not state.get("onRoad") or state.get("roadId") not in edge_by_road:
            _approach_event("approach_failed", reason="memory_graph_off_road", roadId=state.get("roadId"))
            return False
        distance = math.hypot(target.x - pose.x, target.z - pose.z)
        if distance <= APPROACH_FINE_DISTANCE_M:
            _approach_event("approach_memory_stop", reason="graph_fine_phase", track_id=track_id,
                            wm_distance_m=round(distance, 3), roadId=state.get("roadId"), onRoad=True)
            return True
        candidates = _mag_candidates(pose, state, target, tried)
        kind = "candidate" if candidates else "frontier"
        options = candidates or _mag_frontiers(pose, state, target, failed_frontiers)
        if not options:
            _approach_event("approach_min_distance_failed", reason="memory_graph_exhausted",
                            current_wm_distance_m=round(distance, 3), required_m=APPROACH_FINE_DISTANCE_M,
                            roadId=state.get("roadId"), onRoad=True)
            return False
        chosen = options[0]
        plan = chosen.get("plan", {})
        coverage = tuple((road_id, tuple((round(left, 1), round(right, 1)) for left, right
                                         in VP_STATE["intervals"].get(road_id, [])))
                         for road_id in sorted(VP_STATE["roads"]))
        operation_key = (kind, chosen["key"], chosen.get("direction"), state.get("roadId"),
                         round(float(state.get("roadProgressCm") or 0.0), 1),
                         plan.get("direction"), plan.get("entry_node"), tuple(plan.get("route", [])),
                         _vp_block_revision(), coverage)
        if operation_key in attempted:
            if kind == "candidate":
                tried.add(chosen["key"])
            else:
                failed_frontiers.add(chosen["frontier_key"])
            _approach_event("approach_graph_rejected", kind=kind, key=chosen["key"],
                            reason="repeated_road_state_without_new_route_progress")
            continue
        attempted.add(operation_key)
        _approach_event("approach_graph_selected", kind=kind, key=chosen["key"],
                        pathCm=chosen["path_cm"], wm_distance_m=chosen.get("wm_distance_m"),
                        direction=chosen.get("direction"), remainingBoundCm=chosen.get("remaining_bound_cm"),
                        scoreCm=chosen.get("score_cm"),
                        reason="shortest_legal_road_path" if kind == "candidate" else "path_plus_capture_distance_bound")
        result = _vp_travel(chosen) if kind == "candidate" else _mag_frontier_step(chosen, state)
        actual_pose, actual_state = _vp_remember()
        if not actual_state.get("onRoad") or result == "off_road":
            _approach_event("approach_failed", reason="memory_graph_off_road_after_move")
            return False
        if kind == "candidate" and result != "replan":
            tried.add(chosen["key"])
            actual_distance = math.hypot(target.x - actual_pose.x, target.z - actual_pose.z)
            if actual_distance > APPROACH_FINE_DISTANCE_M:
                _approach_event("approach_graph_rejected", kind=kind, key=chosen["key"],
                                reason="actual_pose_outside_fine_range" if result == "arrived" else result,
                                wm_distance_m=round(actual_distance, 3))
        elif kind == "frontier" and result == "unreachable":
            failed_frontiers.add(chosen["frontier_key"])


def approach_target_with_world_model(target):
    """Navigate the road graph from memory, then retain the existing fine/grab rules."""
    start_distance = float(nav_odometry().get("distanceCm") or 0.0)
    reached = _opt2_memory_navigation(target)
    end_distance = float(nav_odometry().get("distanceCm") or 0.0)
    memory_cm = max(0.0, end_distance - start_distance)
    STATE["forward_after_last_observe_cm"] += memory_cm
    _approach_event("approach_graph_memory_distance", movedCm=memory_cm,
                    forward_after_last_observe_cm=STATE["forward_after_last_observe_cm"], reached=reached)
    if not reached:
        return False
    pose = odometry_to_pose(nav_odometry())
    state = _approach_on_road("after_memory_graph")
    target = _wm_target()
    if state is None or target is None:
        return False
    distance_m = math.hypot(target.x - pose.x, target.z - pose.z)
    best_distance_m = distance_m
    stop_reason = "graph_fine_phase"

    # 原地转向记忆中的目标方向，然后才允许 approach(max_steps=1)+grab。
    # v24：若是因"越过最近点"停下且 WM 目标已在车后方，不掉头——视觉测距偏短意味着
    # 真球更可能仍在前方；掉头会背对真球。
    stop_bearing = _wm_bearing_deg(pose) or 0.0
    if stop_reason == "passed_nearest_point" and abs(stop_bearing) > 90.0:
        _approach_event("approach_skip_turn_wm_behind", wm_bearing_deg=round(stop_bearing, 1),
                        wm_distance_m=round(distance_m, 3))
    elif not _turn_to_wm_target_in_place():
        _approach_event("approach_failed", reason="turn_to_target_before_approach")
        return False
    if _approach_on_road("after_target_turn") is None:
        return False
    pose = odometry_to_pose(nav_odometry())
    target = _wm_target() or target
    if target is None or target.state == ObjectState.LOST:
        _approach_event("approach_failed", reason="target_lost_before_approach")
        return False
    distance_m = math.hypot(target.x - pose.x, target.z - pose.z)

    # 细步盲行：沿当前朝向直行 4cm 一步，最后一步按剩余距离缩短，直到 WM 距离 <= GRAB_STANDOFF_M、
    # 连续两步距离增大、离路或被挡；v27 若已比 GRAB_STANDOFF_M 近则后退到该处。全程不 observe。
    fine_prev = distance_m
    fine_inc = 0
    fine_reason = "max_fine_steps"
    fine_steps = []
    state = nav_road_state()
    for _ in range(APPROACH_FINE_MAX_STEPS):
        if abs(distance_m - GRAB_STANDOFF_M) <= 0.005:
            fine_reason = "at_grab_standoff"
            break
        bearing = _wm_bearing_deg(pose) or 0.0
        if abs(bearing) > APPROACH_FINE_REAIM_DEG:
            _turn_toward_bearing(bearing)
        odo_before = float((nav_odometry() or {}).get("distanceCm") or 0.0)
        step_cm = min(APPROACH_FINE_STEP_CM, abs(distance_m - GRAB_STANDOFF_M) * 100.0)
        if step_cm < 0.5:
            fine_reason = "at_grab_standoff"
            break
        backing = distance_m < GRAB_STANDOFF_M
        if backing:
            motion_backward(round(step_cm, 1))
        else:
            motion_forward(round(step_cm, 1))
        odo_after = float((nav_odometry() or {}).get("distanceCm") or 0.0)
        moved = odo_after - odo_before if odo_after >= odo_before else 0.0
        STATE["forward_after_last_observe_cm"] += -moved if backing else moved
        state = nav_road_state()
        pose = odometry_to_pose(nav_odometry())
        distance_m = _wm_distance_m(pose)
        if distance_m is None:
            _approach_event("approach_failed", reason="target_lost_during_fine_drive")
            return False
        fine_steps.append({"movedCm": round(-moved if backing else moved, 1), "wm_distance_m": round(distance_m, 3),
                           "wm_bearing_deg": round(_wm_bearing_deg(pose) or 0.0, 1),
                           "onRoad": state.get("onRoad")})
        if not state.get("onRoad"):
            fine_reason = "off_road"
            break
        if moved < step_cm * 0.5:
            fine_reason = "blocked"
            break
        if not backing and distance_m > fine_prev + APPROACH_IMPROVE_M:
            fine_inc += 1
        else:
            fine_inc = 0
        fine_prev = distance_m
        if fine_inc >= 2:
            fine_reason = "passed_nearest_point"
            break
    _approach_event("approach_fine_stop", reason=fine_reason, steps=fine_steps,
                    wm_distance_m=round(distance_m, 3),
                    wm_bearing_deg=round(_wm_bearing_deg(pose) or 0.0, 1),
                    pose=_pose_log(pose),
                    roadId=state.get("roadId"), onRoad=state.get("onRoad"),
                    forward_after_last_observe_cm=round(STATE["forward_after_last_observe_cm"], 1))
    if fine_reason == "passed_nearest_point":
        # 越过最近点时不掉头（真球更可能在前方）。
        pass
    elif abs(_wm_bearing_deg(pose) or 0.0) > GRAB_AIM_TOL_DEG:
        _turn_to_wm_target_in_place(tol_deg=GRAB_AIM_TOL_DEG)
        pose = odometry_to_pose(nav_odometry())
        distance_m = _wm_distance_m(pose) or distance_m

    if distance_m > APPROACH_DISTANCE_M:
        _approach_event("approach_min_distance_failed",
                        reason="outside_threshold_after_fine_drive",
                        min_wm_distance_m=round(best_distance_m, 3),
                        current_wm_distance_m=round(distance_m, 3),
                        roadId=state.get("roadId"),
                        required_m=APPROACH_DISTANCE_M,
                        onRoad=state.get("onRoad"))
        return False
    if _approach_on_road("before_grab_loop") is None:
        return False

    # 先测不改：最后一次命中的视线方向 与 最终接近航向 的夹角。距离偏差 e 沿视线方向，
    # 投到接近方向的侧向约为 e*sin(夹角)；侧向窗口只有 ±4.75cm。
    last_hit = STATE["accepted_hits"][-1] if STATE["accepted_hits"] else None
    if last_hit is not None:
        sight_deg = math.degrees(math.atan2(last_hit["world_x"] - last_hit["pose_x"],
                                            last_hit["world_z"] - last_hit["pose_z"]))  # 右为正（WM 内部系）
        approach_deg = math.degrees(pose.yaw_rad)
        _approach_event("grab_geometry",
                        last_hit_distanceCm=last_hit["distanceCm"],
                        last_hit_pose=[round(last_hit["pose_x"], 3), round(last_hit["pose_z"], 3), last_hit["pose_heading_deg"]],
                        sight_vs_approach_deg=round(_wrap_deg(approach_deg - sight_deg), 1),
                        wm_forward_cm=round(distance_m * 100.0 * math.cos(math.radians(_wm_bearing_deg(pose) or 0.0)), 1),
                        wm_right_cm=round(distance_m * 100.0 * math.sin(math.radians(_wm_bearing_deg(pose) or 0.0)), 1),
                        pose=_pose_log(pose))

    if STATE["forward_after_last_observe_cm"] < MEMORY_FORWARD_MIN_CM:
        _approach_event("memory_navigation_metric_failed",
                        reason="less_than_required_before_approach",
                        forward_after_last_observe_cm=round(STATE["forward_after_last_observe_cm"], 1),
                        required_forward_cm=MEMORY_FORWARD_MIN_CM)
        return False

    # 一次 approach(max_steps=1)：视觉只做最后一个转向/前进脉冲，不读距离。全局上限 APPROACH_MAX_CALLS。
    if STATE["approach_calls"] >= APPROACH_MAX_CALLS:
        _approach_event("approach_failed", reason="approach_call_cap", approach_calls=STATE["approach_calls"])
        return False
    STATE["approach_calls"] += 1
    _approach_event("approach_call", count=STATE["approach_calls"], max_steps=1,
                    wm_distance_m=round(distance_m, 3),
                    forward_after_last_observe_cm=round(STATE["forward_after_last_observe_cm"], 1))
    try:
        approach_ok = bool(motion_approach("目标物", 85, 1))
    except Exception as error:
        _approach_event("approach_failed", reason="approach_exception", error=str(error))
        return False
    if _approach_on_road("after_approach") is None:
        return False
    pose = odometry_to_pose(nav_odometry())
    _approach_event("approach_result", approach_call=STATE["approach_calls"], reached=approach_ok,
                    wm_distance_m=round(_wm_distance_m(pose) or 0.0, 3),
                    wm_bearing_deg=round(_wm_bearing_deg(pose) or 0.0, 1),
                    pose=_pose_log(pose))

    return _opt2_grab_loop()


# BEGIN EXACT OPT2 FRAGMENT: target_selection.py
"""P3 target scoring from public WM, road topology and measured road geometry.

All helpers are top-level functions: the platform turns them into async functions
and awaits direct Name calls when this file is embedded. No robot API is called.
Candidate/geometry x,z are WM-frame metres; public progress/length are cm.
The caller must supply the measured k (cm/degree); no default or inferred k.
"""
import heapq
import math

TARGET_SELECTION_VERSION = "public-road-initial-turn-v1"
_TS_EPS = 1e-9  # Arithmetic equality only, not a geometry/calibration threshold.


def _ts_finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def selection_shortest_turn(current_deg, target_deg):
    """Signed shortest target-current angle in (-180,180]; left positive."""
    if not _ts_finite(current_deg) or not _ts_finite(target_deg):
        raise ValueError("turn headings must be finite numbers")
    delta = (target_deg - current_deg + 180.0) % 360.0 - 180.0
    return 180.0 if delta == -180.0 else 0.0 if delta == 0.0 else delta


def _ts_graph(graph):
    edges, adjacency, errors = {}, {}, []
    for edge in graph.get("edges", []):
        road = edge.get("roadId")
        start, end, length = edge.get("fromNodeId"), edge.get("toNodeId"), edge.get("lengthCm")
        if (not isinstance(road, str) or not road or not isinstance(start, str)
                or not isinstance(end, str) or not _ts_finite(length) or length < 0
                or type(edge.get("oneWay", False)) is not bool or road in edges):
            errors.append("invalid_or_duplicate_public_edge")
            continue
        item = {"roadId": road, "fromNodeId": start, "toNodeId": end,
                "lengthCm": float(length), "oneWay": edge.get("oneWay", False)}
        edges[road] = item
        adjacency.setdefault(start, []).append((end, float(length), road, 1))
        adjacency.setdefault(end, [])
        if not item["oneWay"]:
            adjacency[end].append((start, float(length), road, -1))
    return edges, adjacency, errors


def _ts_leg(road, begin, end, kind):
    return {"roadId": road, "from_progress_cm": begin, "to_progress_cm": end,
            "distance_cm": abs(end - begin), "direction": 1 if end >= begin else -1,
            "kind": kind}


def _ts_route(edges, adjacency, current_road, current_s, goal_road, goal_s):
    """Multi-source Dijkstra with start and goal edge fractions, including oneWay."""
    current, goal = edges[current_road], edges[goal_road]
    distance, paths, queue, plans = {}, {}, [], []
    starts = [(current["toNodeId"], current["lengthCm"], current["lengthCm"] - current_s)]
    if not current["oneWay"] or current_s == 0:
        starts.append((current["fromNodeId"], 0.0, current_s))
    for node, endpoint, initial in starts:
        if initial < distance.get(node, math.inf):
            distance[node] = initial
            paths[node] = [] if initial == 0 else [_ts_leg(current_road, current_s, endpoint, "current_partial")]
            heapq.heappush(queue, (initial, node))
    while queue:
        value, node = heapq.heappop(queue)
        if value != distance[node]:
            continue
        for neighbor, length, road, direction in sorted(adjacency.get(node, [])):
            proposed = value + length
            if proposed < distance.get(neighbor, math.inf):
                distance[neighbor] = proposed
                begin, end = (0.0, length) if direction > 0 else (length, 0.0)
                paths[neighbor] = paths[node] + [_ts_leg(road, begin, end, "full_road")]
                heapq.heappush(queue, (proposed, neighbor))
    if current_road == goal_road and (not current["oneWay"] or goal_s >= current_s):
        plans.append({"distance_cm": abs(goal_s - current_s), "segments":
                      [] if goal_s == current_s else [_ts_leg(current_road, current_s, goal_s, "same_road_partial")]})
    ends = [(goal["fromNodeId"], 0.0, goal_s)]
    if not goal["oneWay"] or goal_s == goal["lengthCm"]:
        ends.append((goal["toNodeId"], goal["lengthCm"], goal["lengthCm"] - goal_s))
    for node, endpoint, final in ends:
        if node in distance:
            tail = [] if final == 0 else [_ts_leg(goal_road, endpoint, goal_s, "target_partial")]
            plans.append({"distance_cm": distance[node] + final, "segments": paths[node] + tail})
    if not plans:
        return None
    # Stable input order and node/road IDs resolve equal-length routes.
    return min(plans, key=lambda item: item["distance_cm"])


def _ts_measured_segments(edges, geometry):
    segments, incomplete_roads, invalid_points = [], [], []
    roads, intervals = geometry.get("roads", {}), geometry.get("intervals", {})
    for road, edge in sorted(edges.items()):
        points = []
        for point in roads.get(road, []):
            s, x, z = point.get("s"), point.get("x"), point.get("z")
            if not all([_ts_finite(s), _ts_finite(x), _ts_finite(z)]) or not 0 <= s <= edge["lengthCm"]:
                invalid_points.append(road)
            else:
                points.append({"s": float(s), "x": float(x), "z": float(z)})
        points.sort(key=lambda item: item["s"])
        spans = []
        for span in intervals.get(road, []):
            if (isinstance(span, (list, tuple)) and len(span) == 2 and _ts_finite(span[0])
                    and _ts_finite(span[1]) and 0 <= span[0] <= span[1] <= edge["lengthCm"]):
                spans.append((span[0], span[1]))
        covered = []
        for left, right in zip(points, points[1:]):
            if right["s"] <= left["s"] or (right["x"] == left["x"] and right["z"] == left["z"]):
                continue
            # Samples must be joined by recorded traversal; two isolated fixes
            # do not establish the road between them.
            cursor = left["s"]
            for begin, end in sorted(spans):
                if begin <= cursor + _TS_EPS:
                    cursor = max(cursor, end)
            if cursor + _TS_EPS >= right["s"]:
                segments.append({"roadId": road, "left": left, "right": right,
                                 "length_cm": edge["lengthCm"]})
                covered.append((left["s"], right["s"]))
        cursor = 0.0
        for begin, end in covered:
            if begin <= cursor + _TS_EPS:
                cursor = max(cursor, end)
        if cursor + _TS_EPS < edge["lengthCm"] or not covered:
            incomplete_roads.append(road)
    return segments, {"incomplete_road_ids": incomplete_roads,
                      "invalid_point_road_ids": sorted(set(invalid_points)),
                      "global_nearest_road_status": "unknown" if incomplete_roads else "known_measured_polyline"}


def _ts_project(x, z, measured):
    candidates = []
    for segment in measured:
        a, b = segment["left"], segment["right"]
        dx, dz = b["x"] - a["x"], b["z"] - a["z"]
        fraction = ((x - a["x"]) * dx + (z - a["z"]) * dz) / (dx * dx + dz * dz)
        clamped = min(1.0, max(0.0, fraction))
        px, pz = a["x"] + clamped * dx, a["z"] + clamped * dz
        progress = a["s"] + clamped * (b["s"] - a["s"])
        unsupported = ((fraction < -_TS_EPS and a["s"] > _TS_EPS)
                       or (fraction > 1.0 + _TS_EPS and b["s"] < segment["length_cm"] - _TS_EPS))
        candidates.append({"roadId": segment["roadId"], "progress_cm": progress,
                           "x": px, "z": pz, "lateral_distance_cm": math.hypot(x - px, z - pz) * 100.0,
                           "sample_progress_cm": [a["s"], b["s"]], "fraction": fraction,
                           "supported": not unsupported,
                           "source": "orthogonal_projection_on_traversed_measured_segment"})
    if not candidates:
        return [], "no_measured_traversed_road_segment"
    nearest = min(item["lateral_distance_cm"] for item in candidates)
    nearest_items = [item for item in candidates if abs(item["lateral_distance_cm"] - nearest) <= _TS_EPS]
    supported = [item for item in nearest_items if item["supported"]]
    return supported, None if supported else "nearest_measured_boundary_requires_unseen_geometry"


def select_target(candidates, graph, road_state, odometry, measured_geometry, k):
    """Return JSON-safe scores; caller logs the result and maps selected ID to WM.

    WM candidates are dictionaries with obj_id,x,z; optional name/state/confidence
    are diagnostics. Caller excludes delivered targets. Initial absolute target
    heading = -atan2(dx,dz), matching public odometry's left-positive heading.
    Cost = shortest public road distance to measured projection + k*abs(turn).
    This is not accumulated route steering, API execution time, nor a promised
    collision-free/grabbable trajectory. Unknown geometry/cost stays explicit.
    """
    result = {"version": TARGET_SELECTION_VERSION, "status": "unknown", "reason": None,
              "selected_candidate_id": None, "k_cm_per_deg": k if _ts_finite(k) else None,
              "turn_definition": "current_heading_to_target_absolute_bearing_initial_shortest",
              "projection_scope": "nearest_traversed_measured_geometry_only",
              "optimality_scope": "scorable_public_model_candidates_only", "candidates": []}
    if not _ts_finite(k) or k < 0:
        result["reason"] = "measured_turn_cost_k_unavailable_or_invalid"
        return result
    needed = [odometry.get("rightCm"), odometry.get("forwardCm"), odometry.get("headingDeg")]
    if not all([_ts_finite(needed[0]), _ts_finite(needed[1]), _ts_finite(needed[2])]):
        result["reason"] = "public_odometry_unavailable"
        return result
    edges, adjacency, graph_errors = _ts_graph(graph)
    current, start_s = road_state.get("roadId"), road_state.get("roadProgressCm")
    if (graph_errors or current not in edges or not _ts_finite(start_s)
            or not 0 <= start_s <= edges[current]["lengthCm"] or road_state.get("onRoad") is not True):
        result["reason"] = "public_graph_or_current_road_invalid"
        result["graph_errors"] = graph_errors
        return result
    measured, coverage = _ts_measured_segments(edges, measured_geometry)
    result["geometry_coverage"] = coverage
    x0, z0, heading = needed[0] / 100.0, needed[1] / 100.0, needed[2]
    seen_ids, scored = set(), []
    for candidate in candidates:
        cid, x, z = candidate.get("obj_id"), candidate.get("x"), candidate.get("z")
        item = {"candidate_id": cid, "status": "unknown", "reason": None, "cost_cm": None,
                "path_distance_cm": None, "turn_deg": None, "projection": None, "path": None}
        result["candidates"].append(item)
        if not isinstance(cid, str) or not cid or cid in seen_ids:
            result["reason"] = "invalid_or_duplicate_candidate_id"
            return result
        seen_ids.add(cid)
        if not _ts_finite(x) or not _ts_finite(z):
            item["reason"] = "wm_position_unavailable"
            continue
        if candidate.get("name", "target") != "target" or str(candidate.get("state", "")).lower() == "lost":
            item.update(status="excluded", reason="not_an_active_target")
            continue
        dx, dz = x - x0, z - z0
        euclidean = math.hypot(dx, dz) * 100.0
        absolute_heading = -math.degrees(math.atan2(dx, dz)) if euclidean else heading
        turn = selection_shortest_turn(heading, absolute_heading)
        item.update(wm_position_m=[x, z], euclidean_cm=euclidean, absolute_target_heading_deg=absolute_heading,
                    turn_deg=turn, turn_cost_cm=k * abs(turn), zero_range_turn_defined_as_zero=euclidean == 0)
        projections, why = _ts_project(x, z, measured)
        item["projection_options"] = projections
        if why:
            item["reason"] = why
            continue
        options = []
        for projection in projections:
            route = _ts_route(edges, adjacency, current, start_s, projection["roadId"], projection["progress_cm"])
            if route is not None:
                options.append({"projection": projection, "path": route["segments"],
                                "path_distance_cm": route["distance_cm"], "cost_cm": route["distance_cm"] + k * abs(turn)})
        if not options:
            item.update(status="unreachable", reason="no_directed_public_graph_path")
            continue
        best = min(options, key=lambda option: (option["cost_cm"], option["projection"]["roadId"], option["projection"]["progress_cm"]))
        item.update(best)
        item["status"] = "scored"
        item["known_geometry_estimate_only"] = bool(coverage["incomplete_road_ids"])
        scored.append(item)
    result["complete_candidate_costs"] = all(item["status"] in ("scored", "excluded", "unreachable") for item in result["candidates"])
    if scored:
        best = min(scored, key=lambda item: (item["cost_cm"], abs(item["turn_deg"]), item["candidate_id"]))
        result.update(status="selected", selected_candidate_id=best["candidate_id"],
                      selected_cost_cm=best["cost_cm"], selected_path_distance_cm=best["path_distance_cm"],
                      selected_turn_deg=best["turn_deg"])
    else:
        result["reason"] = "no_scorable_candidates" if candidates else "no_candidates"
    return result
# END EXACT OPT2 FRAGMENT: target_selection.py

# BEGIN EXACT OPT2 FRAGMENT: opt2_flow_fragment.py
"""Stage-2 two-target orchestration with public-road P3 selection and per-ball approach budgets."""

DEMO_REQUIRED_TARGETS = 2
# Existing public release projection: 1.1 world units / 8 units per metre.
DEMO_RELEASE_PROJECTION_CM = 13.75
DEMO_STATE = {
    "ball_index": 0,
    "target_source": None,
    "collected_track_ids": set(),
    "delivered_track_ids": set(),
    "deliveries": [],
    "selection_snapshot": None,
    "ball_start_track_ids": set(),
}


def _demo_event(event, **fields):
    odo = NAV_STATE["cache"].get("odometry")
    if odo is None and NAV_STATE["queries"] < NAVIGATION_QUERY_LIMIT:
        odo = nav_odometry()
    payload = {"event": event, "tick": (odo or {}).get("tick"),
               "ball_index": DEMO_STATE["ball_index"],
               "track_id": STATE.get("confirmation_track_id"),
               "target_source": DEMO_STATE["target_source"]}
    payload.update(fields)
    if event == "flow_end":
        payload["navigation_queries"] = NAV_STATE["queries"]
        payload["navigation_controls"] = NAV_STATE["controls"]
    print("GY " + json.dumps(payload, ensure_ascii=False))


def _demo_detection_excluded(detection, track_id=None):
    if track_id in DEMO_STATE["collected_track_ids"] or track_id in DEMO_STATE["delivered_track_ids"]:
        return True
    # The same fixed association gate already used by the unchanged static WM.
    radius = float(wm.assoc_cfg.gate_distance_m)
    return any(math.hypot(detection.x - delivery["x"], detection.z - delivery["z"]) <= radius
               for delivery in DEMO_STATE["deliveries"])


def _demo_observation_eligible(observation, pose):
    try:
        distance = float(observation.get("distanceCm"))
    except (TypeError, ValueError):
        return False
    if not math.isfinite(distance):
        return False
    if distance >= 100.0:
        # A capped reading is only a bearing ray; never project it to a 100cm point.
        return True
    detection = calibrated_detection(observation, pose, float(nav_odometry().get("tick", 0)) * 0.02)
    return not _demo_detection_excluded(detection)


def _demo_filter_observations(observations, pose):
    """Filter acquisition input after the complete raw log, before unchanged confirmation."""
    eligible = []
    for item in observations:
        if not _is_target(item) or _demo_observation_eligible(item, pose):
            eligible.append(item)
        else:
            _demo_event("delivered_target_excluded", reason="successful_release_region",
                        category=item.get("category"), distanceCm=item.get("distanceCm"),
                        bearingDeg=item.get("bearingDeg"), confidence=item.get("confidence"))
    return eligible


def _demo_memory_target():
    candidates = [obj for obj in wm.get_scene()
                  if obj.name == "target" and obj.state != ObjectState.LOST
                  and math.isfinite(obj.x) and math.isfinite(obj.z)
                  and not _demo_detection_excluded(obj, obj.obj_id)]
    if not candidates:
        DEMO_STATE["selection_snapshot"] = None
        return None
    # Measured geometry is updated from the same cached public pose used below.
    _vp_remember()
    odo, state = nav_odometry(), nav_road_state()
    public_candidates = [{"obj_id": obj.obj_id, "name": obj.name, "x": obj.x, "z": obj.z,
                          "state": obj.state.value, "confidence": obj.confidence}
                         for obj in candidates]
    geometry = {"roads": VP_STATE["roads"], "intervals": VP_STATE["intervals"]}
    graph = {"edges": list(edge_by_road.values())}
    selection = select_target(public_candidates, graph, state, odo, geometry, TURN_COST_K)
    selected_id = selection.get("selected_candidate_id")
    if selected_id is None and len(candidates) == 1:
        # A unique known object needs no ranking. Preserve its confirmation even
        # when the road projection is still unknown; do not call that optimal.
        selected_id = candidates[0].obj_id
        selection["execution_choice_reason"] = "unique_memory_candidate_cost_unknown"
        selection["execution_candidate_id"] = selected_id
    DEMO_STATE["selection_snapshot"] = {
        "selected_track_id": selected_id, "graph": graph, "road_state": state,
        "odometry": odo, "measured_geometry": geometry,
        "wm_candidates": public_candidates, "selection": selection}
    return next((obj for obj in candidates if obj.obj_id == selected_id), None)


def _demo_lock_target(target):
    STATE["confirmation_track_id"] = target.obj_id
    DEMO_STATE["target_source"] = ("memory" if target.obj_id in DEMO_STATE["ball_start_track_ids"]
                                   else "new_observations")
    snapshot = DEMO_STATE.get("selection_snapshot")
    if snapshot is not None and snapshot.get("selected_track_id") == target.obj_id:
        _demo_event("target_selection", **snapshot)
    _demo_event("ball_selection", wm_position=[target.x, target.z],
                wm_state=target.state.value, wm_hit_count=target.hit_count)
    return target


def _wm_target():
    track_id = STATE.get("confirmation_track_id")
    if track_id is not None:
        target = wm.get_object(track_id)
        if (target is None or target.state == ObjectState.LOST
                or _demo_detection_excluded(target, track_id)):
            return None
        return target
    target = _demo_memory_target()
    if target is not None and DEMO_STATE["ball_index"]:
        return _demo_lock_target(target)
    return target


def _demo_reset_ball(ball_index):
    # These counters and motion guard remain global: observe_count,
    # last_observe_pose, NAV_STATE and all WM observations. Approach is per ball.
    STATE.update({"accepted_hits": [], "confirmation_track_id": None, "approach_calls": 0,
                  "frame_track_ids": {}, "nav_observes": 0,
                  "last_observed_world": None, "confirmation_distance_cm": None,
                  "last_observe_distance_m": None, "last_observe_camera_distance_cm": None,
                  "forward_after_last_observe_cm": 0.0})
    # Geometry and physical road restrictions remain; target-specific dead ends
    # and unfinished travel chains must not reject the next target's viewpoints.
    for name in ("explored", "failed", "nudged", "travel_attempts"):
        VP_STATE[name] = set()
    VP_STATE["travel_active"] = None
    DELIVERY_LOG["on"] = False
    DEMO_STATE["ball_index"] = ball_index
    DEMO_STATE["target_source"] = None
    DEMO_STATE["selection_snapshot"] = None
    DEMO_STATE["ball_start_track_ids"] = {obj.obj_id for obj in wm.get_scene()
                                         if obj.name == "target" and obj.state != ObjectState.LOST}


def _demo_release_active_target(preview):
    track_id = STATE.get("confirmation_track_id")
    before = nav_task_state()
    pose = odometry_to_pose(nav_odometry())
    motion_release()
    holding_after = robot.holding()
    after = nav_task_state()
    released = holding_after is None
    progressed = (isinstance(before.get("completed"), (int, float))
                  and isinstance(after.get("completed"), (int, float))
                  and after["completed"] > before["completed"])
    valid_preview = (preview.get("holding") == "target" and preview.get("releaseAccepted")
                     and preview.get("wouldCompleteDelivery"))
    if not released or not progressed or not valid_preview or track_id is None:
        _demo_event("ball_release_unverified", preview=preview, holding_after=holding_after,
                    completed_before=before.get("completed"), completed_after=after.get("completed"),
                    reason="release_requires_valid_preview_empty_gripper_and_task_progress")
        return False
    distance = DEMO_RELEASE_PROJECTION_CM / 100.0
    delivery = {"track_id": track_id, "x": pose.x + distance * math.sin(pose.yaw_rad),
                "z": pose.z + distance * math.cos(pose.yaw_rad)}
    DEMO_STATE["delivered_track_ids"].add(track_id)
    DEMO_STATE["deliveries"].append(delivery)
    _demo_event("ball_delivered", preview=preview, holding_after=holding_after,
                completed_before=before.get("completed"), completed_after=after.get("completed"),
                expected_release_position=[delivery["x"], delivery["z"]],
                position_source="successful_release_pose_and_public_release_projection",
                storage_anchor=dict(mission["storage"]),
                exclusion_radius_m=float(wm.assoc_cfg.gate_distance_m),
                delivered_count=len(DEMO_STATE["deliveries"]))
    return True


def _finish_flow(success, stage, reason=None):
    task = (nav_task_state() if NAV_STATE["queries"] < NAVIGATION_QUERY_LIMIT
            else NAV_STATE["cache"].get("task_state", {}))
    _demo_event("flow_end", success=bool(success), stage=stage, reason=reason,
                one_target_released=bool(DEMO_STATE["deliveries"]),
                delivered_count=len(DEMO_STATE["deliveries"]), required_targets=DEMO_REQUIRED_TARGETS,
                navigation_queries=NAV_STATE["queries"], navigation_controls=NAV_STATE["controls"],
                full_targetDelivered=bool(task.get("targetDelivered")), holding=robot.holding())
    print("GY_DONE")


def _demo_fail(stage, reason):
    _demo_event("ball_end", success=False, stage=stage, reason=reason)
    _finish_flow(False, stage, reason)


def run_target_flow():
    for ball_index in range(1, DEMO_REQUIRED_TARGETS + 1):
        _demo_reset_ball(ball_index)
        memory_target = _demo_memory_target()
        DEMO_STATE["target_source"] = "memory" if memory_target is not None else "new_observations"
        _demo_event("ball_start", track_id=memory_target.obj_id if memory_target is not None else None,
                    retained_wm_targets=len(wm.get_scene()),
                    delivered_count=len(DEMO_STATE["deliveries"]),
                    observe_count=STATE["observe_count"], approach_calls=STATE["approach_calls"])
        if memory_target is not None:
            _demo_lock_target(memory_target)
            pose, _ = _vp_remember()
            # CONFIRMED is a WM state, not a replacement for the unchanged
            # three-position, same-track, final-distance confirmation contract.
            target = _try_enter_range_and_confirm(pose, [])
            if target is None and STATE.pop("planning_goal_abandoned", False):
                _demo_event("memory_search_resumed", previous_track_id=memory_target.obj_id,
                            reason="remembered_goal_lost_continue_patrol")
                target = patrol_until_target_seen(
                    max_obs=min(MAX_OBSERVES, STATE["observe_count"] + PATROL_OBSERVE_BUDGET))
        else:
            target = patrol_until_target_seen(
                max_obs=min(MAX_OBSERVES, STATE["observe_count"] + PATROL_OBSERVE_BUDGET))
        if target is None:
            _demo_fail("confirmation", "WorldModel 未通过 observe() 确认目标物")
            return
        _demo_event("ball_confirmed", accepted_hits=len(STATE["accepted_hits"]))
        if not approach_target_with_world_model(target):
            _demo_fail("grab", "按 WorldModel 位置接近并抓取目标物失败")
            return
        DEMO_STATE["collected_track_ids"].add(target.obj_id)
        _demo_event("ball_grabbed", holding=robot.holding())
        # Holding is action evidence that the confirmed object left its old
        # location. Archive that location explicitly, without inventing a miss
        # observation or changing perception fusion/decay thresholds.
        now = float(nav_odometry().get("tick", 0)) * 0.02
        previous_confidence = target.confidence
        removed = wm.mark_removed(target.obj_id, now=now)
        archived = wm.get_object(target.obj_id)
        _demo_event("wm_action_removed", removed=removed, evidence="verified_target_holding",
                    old_position=[target.x, target.z], previous_confidence=previous_confidence,
                    confidence=archived.confidence if archived is not None else None,
                    state=archived.state.value if archived is not None else None)
        DELIVERY_LOG["on"] = True
        _delivery_event("delivery_phase_start", holding=robot.holding())
        if not release_target_at_storage():
            _demo_fail("delivery", "未找到可确认的目标物存放姿态或释放未验证")
            return
        if robot.holding() is not None:
            _demo_fail("delivery", "释放后仍持有目标物")
            return
        _demo_event("ball_end", success=True, stage="delivery", reason=None,
                    delivered_count=len(DEMO_STATE["deliveries"]))
    complete = (len(DEMO_STATE["deliveries"]) == DEMO_REQUIRED_TARGETS
                and bool(nav_task_state().get("targetDelivered")))
    _finish_flow(complete, "delivery", None if complete else "双球送达尚未通过公开任务状态确认")
# END EXACT OPT2 FRAGMENT: opt2_flow_fragment.py

# BEGIN EXACT OPT2 FRAGMENT: opt2_delivery_fragment.py
"""Public-road storage search, embedded after the r2 VP and demo-flow helpers.

Integration: override release_target_at_storage plus _vp_enter/_vp_travel below.
VP travel also learns missing local direction from an actual public road step.
Speed selection preserves SLOW_SPEED for confirmation; delivery and explicitly
marked memory travel use the existing CRUISE_SPEED.
Requires the base program's math/json, nav_*/motion_*, VP_STATE, road graph,
mission.storage and _demo_release_active_target. No observation is requested.
State persists only for one delivery search; NAV, WM, geometry and local road
restrictions are never reset. Release bookkeeping remains in the demo helper.
"""


def _opt2_travel_speed():
    return (CRUISE_SPEED if DELIVERY_LOG.get("on") or globals().get("OPT2_MEMORY_TRAVEL_ACTIVE", False)
            else SLOW_SPEED)


def _opt2_storage_roads(storage):
    edge = edge_by_road.get(storage.get("roadId"))
    if edge is None:
        return set()
    nodes = {edge["fromNodeId"], edge["toNodeId"]}
    return {road_id for road_id, item in edge_by_road.items()
            if item["fromNodeId"] in nodes or item["toNodeId"] in nodes}


def _opt2_storage_distance(storage, road_id, progress):
    """Road distance to the public anchor, only for ordering release samples."""
    anchor = edge_by_road[storage["roadId"]]
    anchor_s = float(storage["progressCm"])
    if road_id == storage["roadId"]:
        return abs(progress - anchor_s)
    edge = edge_by_road[road_id]
    distances = []
    for node, anchor_part in ((anchor["fromNodeId"], anchor_s),
                              (anchor["toNodeId"], float(anchor["lengthCm"]) - anchor_s)):
        if edge["fromNodeId"] == node:
            distances.append(anchor_part + progress)
        if edge["toNodeId"] == node:
            distances.append(anchor_part + float(edge["lengthCm"]) - progress)
    return min(distances) if distances else float("inf")


def _opt2_parking_seen(point, previewed):
    """Do not rescan a sub-grid residual or a junction's second road alias."""
    for previous in previewed:
        if (point.get("roadId") == previous["roadId"]
                and round(abs(float(point["progressCm"]) - previous["progressCm"]), 1) < VIEW_GRID_CM):
            return True
        if ("x" in point and "z" in point
                and round(math.hypot(point["x"] - previous["x"], point["z"] - previous["z"]) * 100.0, 1) < VIEW_GRID_CM):
            return True
    return False


def _opt2_storage_candidates(storage, tried, reported, previewed=None):
    """Public progress grid on storage road; measured points on adjacent roads.

    A progress destination needs no invented world coordinate. The VP controller
    obtains real geometry during travel and replans after each road transition.
    The anchor is a nearest-road projection, never the actual storage centre.
    """
    pose, state = _vp_remember()
    road_id = storage["roadId"]
    edge = edge_by_road[road_id]
    length = float(edge["lengthCm"])
    grid = float(VIEW_GRID_CM)
    progress_values = {float(storage["progressCm"]), 0.0, length}
    progress_values.update(index * grid for index in range(math.floor(length / grid) + 1))
    points = {}
    for progress in progress_values:
        key = "storage:" + road_id + "@" + str(round(progress, 1))
        points[key] = {"key": key, "roadId": road_id, "progressCm": progress,
                       "geometry": "public_storage_road_progress"}
    adjacent = _opt2_storage_roads(storage)
    for point in _vp_points(pose, state).values():
        if point["roadId"] in adjacent:
            point = dict(point)
            point["key"] = "storage:" + point["key"]
            points[point["key"]] = point
    choices = []
    for key, point in points.items():
        reason = ("already_tried" if key in tried else
                  "within_previewed_parking_grid" if _opt2_parking_seen(point, previewed or []) else None)
        plan = None if reason else _vp_path(state, point["roadId"], point["progressCm"])
        if reason is None and plan is None:
            reason = "no_legal_road_path"
        if reason:
            report_key = (key, reason, _vp_block_revision())
            if report_key not in reported:
                reported.add(report_key)
                _delivery_event("delivery_candidate_rejected", key=key, reason=reason)
            continue
        point["plan"] = plan
        point["path_cm"] = plan["cost_cm"]
        point["anchor_path_cm"] = _opt2_storage_distance(storage, point["roadId"], point["progressCm"])
        choices.append(point)
    choices.sort(key=lambda item: (item["anchor_path_cm"], item["path_cm"], item["key"]))
    return choices



def _opt2_explore_storage(storage, explored, reported):
    """Try finite public entry gateways when the anchor's measured route is cut.

    A local clearance boundary is kept. A different public take_exit trajectory
    may land on its other side; only the real returned pose establishes that.
    No unmeasured world coordinate is used to aim or to rank these gateways.
    """
    _, state = _vp_remember()
    if not state.get("onRoad"):
        return False
    adjacent = _opt2_storage_roads(storage)
    node = state.get("nodeId") if state.get("atNode") else None
    exits = []
    for item in state.get("exits", []) if node is not None else []:
        road_id = item.get("roadId")
        edge = edge_by_road.get(road_id)
        key = ("exit", node, state.get("roadId"), road_id)
        if (edge is None or road_id not in adjacent or road_id in blocked_roads or key in explored
                or node not in (edge["fromNodeId"], edge["toNodeId"])
                or (edge["oneWay"] and node != edge["fromNodeId"])):
            continue
        entry = 0.0 if node == edge["fromNodeId"] else float(edge["lengthCm"])
        landing = _road_progress_limit(road_id, entry,
                  entry + (1 if entry == 0 else -1) * min(float(edge["lengthCm"]), VP_EXIT_ENTRY_CM))
        if landing == entry:
            continue
        exits.append((_opt2_storage_distance(storage, road_id, landing), road_id, key))
    for _, road_id, key in sorted(exits):
        explored.add(key)
        explored.add(("gateway_done", node, road_id))
        before_revision = _vp_block_revision()
        moved = _vp_enter(road_id)
        _delivery_event("delivery_gateway_explored", roadId=road_id, nodeId=node,
                        moved=moved, reason="public_node_exit")
        if moved or _vp_block_revision() != before_revision:
            return True
    # Reach an untried storage-adjacent entry through the existing graph planner.
    # A gateway is consumed on its actual public exit attempt, not on a waypoint.
    choices = []
    for road_id in sorted(adjacent):
        edge = edge_by_road[road_id]
        if road_id in blocked_roads:
            continue
        for endpoint, progress in ((edge["fromNodeId"], 0.0),
                                   (edge["toNodeId"], float(edge["lengthCm"]))):
            if (edge["oneWay"] and progress != 0.0) or ("gateway_done", endpoint, road_id) in explored:
                continue
            plan = _vp_path(state, road_id, progress, True)
            if plan is None:
                continue
            operation = ("route", endpoint, road_id, state.get("roadId"),
                         round(float(state.get("roadProgressCm") or 0.0), 1),
                         tuple(plan["route"]), plan["direction"], _vp_block_revision())
            if operation in explored:
                continue
            key = "storage-gateway:" + str(endpoint) + ":" + road_id
            choices.append((plan["cost_cm"] + _opt2_storage_distance(storage, road_id, progress), key,
                            operation, {"key": key, "roadId": road_id, "progressCm": progress, "enter_only": True}))
    for _, key, operation, candidate in sorted(choices):
        explored.add(operation)
        before, before_state = _vp_remember()
        revision = _vp_block_revision()
        result = _vp_travel(candidate)
        after, after_state = _vp_remember()
        moved = math.hypot(after.x - before.x, after.z - before.z) > 0
        _delivery_event("delivery_gateway_travel", key=key, result=result, moved=moved)
        if moved or revision != _vp_block_revision():
            return True
        report_key = (key, "gateway_no_progress")
        if report_key not in reported:
            reported.add(report_key)
            _delivery_event("delivery_candidate_rejected", key=key, reason="gateway_no_progress",
                            roadId=before_state.get("roadId"), actualRoadId=after_state.get("roadId"))
    return False


def _opt2_reach(candidate):
    """Keep one VP travel chain; reject a repeated physical/planning state."""
    visited = set()
    while True:
        _, state = _vp_remember()
        if not state.get("onRoad"):
            _delivery_event("delivery_candidate_unreachable", key=candidate["key"], reason="off_road")
            return False
        plan = _vp_path(state, candidate["roadId"], candidate["progressCm"], candidate.get("enter_only", False))
        if plan is None:
            _delivery_event("delivery_candidate_unreachable", key=candidate["key"], reason="no_legal_road_path")
            return False
        operation = (state.get("roadId"), round(float(state.get("roadProgressCm") or 0.0), 1),
                     plan["direction"], plan.get("entry_node"), tuple(plan["route"]), _vp_block_revision())
        if operation in visited:
            _delivery_event("delivery_candidate_unreachable", key=candidate["key"], reason="repeated_travel_state")
            return False
        visited.add(operation)
        result = _vp_travel(candidate)
        _, after = _vp_remember()
        _delivery_event("delivery_candidate_travel", key=candidate["key"], result=result,
                        plannedRoads=plan["route"], plannedDistanceCm=plan["cost_cm"])
        if not after.get("onRoad"):
            return False
        if result == "arrived":
            return (after.get("roadId") == candidate["roadId"] and
                    round(float(after.get("roadProgressCm") or 0.0) - candidate["progressCm"], 1) == 0)
        if result != "replan":
            return False


def _opt2_preview_candidate(storage, candidate):
    """Finite heading grid; release_preview is the sole storage acceptance test."""
    pose, state = _vp_remember()
    if not state.get("onRoad"):
        return "off_road"
    step = float(OBS_MIN_TURN_DEG)
    base = pose.yaw_rad
    # Prefer facing the measured anchor projection when it is a different point.
    anchor_key = storage["roadId"] + "@" + str(round(float(storage["progressCm"]), 1))
    anchor = _vp_points(pose, state).get(anchor_key)
    if anchor is not None and (anchor["x"] != pose.x or anchor["z"] != pose.z):
        bearing = _wrap_deg(math.degrees(math.atan2(anchor["x"] - pose.x, anchor["z"] - pose.z) - base))
        base += math.radians(round(bearing / step) * step)
    for index in range(math.ceil(360.0 / step)):
        pose, state = _vp_remember()
        if not state.get("onRoad"):
            return "off_road"
        desired = base + math.radians(index * step)
        turn = round(_wrap_deg(math.degrees(desired - pose.yaw_rad)), 1)
        if turn > 0:
            motion_right_angle(turn)
        elif turn < 0:
            motion_left_angle(-turn)
        _vp_remember()
        preview = nav_release_preview()
        _delivery_event("delivery_release_preview", key=candidate["key"], heading_index=index,
                        preview=preview, reason="public_preview_only")
        if preview.get("holding") != "target":
            return "not_holding_target"
        if preview.get("releaseAccepted") and preview.get("wouldCompleteDelivery"):
            return "released" if _demo_release_active_target(preview) else "release_unverified"
    return "preview_grid_exhausted"


def _opt2_leave_release():
    """Move one legal grid step away; at a stopped junction take a legal exit.

    The previous release pose plus the public gripper projection is runtime
    memory. It orders departure directions; it is not a hidden target anchor.
    """
    deliveries = DEMO_STATE.get("deliveries", [])
    if not deliveries:
        return False
    released = deliveries[-1]
    start, state = _vp_remember()
    if not state.get("onRoad"):
        return False
    start_distance = math.hypot(start.x - released["x"], start.z - released["z"])
    road_id = state.get("roadId")
    edge = edge_by_road.get(road_id)
    unit = _vp_canonical_unit(road_id, float(state.get("roadProgressCm") or 0.0))
    choices = []
    if edge is not None and unit is not None:
        progress = float(state["roadProgressCm"])
        for sign in (1, -1):
            if edge["oneWay"] and sign < 0:
                continue
            away = sign * ((start.x - released["x"]) * unit[0] + (start.z - released["z"]) * unit[1])
            end = min(float(edge["lengthCm"]), max(0.0, progress + sign * VIEW_GRID_CM))
            if away < 0 or end == progress or _road_progress_blocked(road_id, progress, end):
                continue
            choices.append((-away, sign, end))
    for _, _sign, end in sorted(choices):
        candidate = {"key": "leave:" + str(road_id) + "@" + str(round(end, 1)),
                     "roadId": road_id, "progressCm": end}
        if _opt2_reach(candidate):
            after, state = _vp_remember()
            if (state.get("onRoad") and math.hypot(after.x - start.x, after.z - start.z) > 0
                    and math.hypot(after.x - released["x"], after.z - released["z"]) > start_distance):
                _delivery_event("delivery_leave_complete", key=candidate["key"], reason="moved_away_on_road")
                return True
    # follow_road/forward may legitimately report zero at a junction; the next
    # action is an explicit take_exit, never another follow at the same node.
    pose, state = _vp_prepare_node()
    exits = []
    for item in state.get("exits", []):
        exit_road = item.get("roadId")
        edge = edge_by_road.get(exit_road)
        if edge is None or exit_road in blocked_roads:
            continue
        node = state.get("nodeId")
        if node not in (edge["fromNodeId"], edge["toNodeId"]):
            continue
        if edge["oneWay"] and node != edge["fromNodeId"]:
            continue
        entry = 0.0 if node == edge["fromNodeId"] else float(edge["lengthCm"])
        if _road_progress_limit(exit_road, entry, float(edge["lengthCm"]) - entry) == entry:
            continue
        yaw = pose.yaw_rad - math.radians(float(item.get("turnDeg") or 0.0))
        away = (pose.x - released["x"]) * math.sin(yaw) + (pose.z - released["z"]) * math.cos(yaw)
        if away >= 0:
            exits.append((-away, exit_road))
    for _, exit_road in sorted(exits):
        if _vp_enter(exit_road):
            after, state = _vp_remember()
            if (state.get("onRoad") and math.hypot(after.x - start.x, after.z - start.z) > 0
                    and math.hypot(after.x - released["x"], after.z - released["z"]) > start_distance):
                _delivery_event("delivery_leave_complete", roadId=exit_road, reason="take_exit_away_on_road")
                return True
        _delivery_event("delivery_leave_candidate_rejected", roadId=exit_road, reason="no_departure_away_from_release")
    _delivery_event("delivery_leave_failed", reason="no_legal_departure_with_progress")
    return False


def release_target_at_storage():
    """One target: reach, sample, verify release, depart; leave WM/NAV intact."""
    storage = mission.get("storage") or {}
    road_id = storage.get("roadId")
    edge = edge_by_road.get(road_id)
    progress = storage.get("progressCm")
    if (edge is None or not isinstance(progress, (int, float)) or not math.isfinite(progress)
            or not 0 <= progress <= float(edge["lengthCm"])):
        _delivery_event("delivery_search_failed", reason="invalid_public_storage_anchor")
        return False
    tried, reported, previewed, explored = set(), set(), [], set()
    previewed_keys = set()
    VP_STATE["travel_attempts"] = set()
    VP_STATE["travel_active"] = None
    while True:
        _, state = _vp_remember()
        if not state.get("onRoad"):
            _delivery_event("delivery_search_failed", reason="off_road")
            return False
        if _vp_path(state, road_id, float(progress)) is None:
            if _opt2_explore_storage(storage, explored, reported):
                tried = set(previewed_keys)
                continue
        candidates = _opt2_storage_candidates(storage, tried, reported, previewed)
        if not candidates:
            if _opt2_explore_storage(storage, explored, reported):
                tried = set(previewed_keys)
                continue
            _delivery_event("delivery_search_failed", reason="finite_storage_grid_exhausted", tried=len(tried))
            return False
        candidate = candidates[0]
        tried.add(candidate["key"])
        _delivery_event("delivery_candidate_selected", key=candidate["key"],
                        anchorPathCm=candidate["anchor_path_cm"], pathCm=candidate["path_cm"])
        if not _opt2_reach(candidate):
            continue
        pose, state = _vp_remember()
        position = {"roadId": state.get("roadId"), "progressCm": float(state.get("roadProgressCm") or 0.0),
                    "x": pose.x, "z": pose.z}
        if _opt2_parking_seen(position, previewed):
            _delivery_event("delivery_candidate_rejected", key=candidate["key"], reason="same_parking_point_already_previewed")
            continue
        previewed.append(position)
        previewed_keys.add(candidate["key"])
        result = _opt2_preview_candidate(storage, candidate)
        if result == "released":
            return _opt2_leave_release()
        _delivery_event("delivery_candidate_rejected", key=candidate["key"], reason=result)
        if result != "preview_grid_exhausted":
            return False


# The public entry body keeps the opt1-r2 geometry/block semantics; travel adds
# a measured-direction bootstrap and respects an already reached public node.


def _opt2_learn_direction(state):
    """Learn canonical sign from an actual ten-centimetre road controller step.

    Both physical headings are finite possibilities. Public follow_road enforces
    oneWay and front clearance, including when canonical sign is still unknown.
    A rejected or zero-distance action never counts as newly measured geometry.
    """
    road_id = state.get("roadId")
    pose, current = _vp_remember()
    if not current.get("onRoad") or current.get("roadId") != road_id:
        return False
    yaw = pose.yaw_rad - math.radians(float(current.get("headingErrorDeg") or 0.0))
    for reverse in (False, True):
        live, before = _vp_remember()
        if not before.get("onRoad") or before.get("roadId") != road_id:
            return False
        desired = yaw + (math.pi if reverse else 0.0)
        align_to_current_road()
        live, aligned = _vp_remember()
        aligned_yaw = live.yaw_rad - math.radians(float(aligned.get("headingErrorDeg") or 0.0))
        if math.cos(aligned_yaw - desired) < 0:
            motion_left_angle(180)
        result = _vp_follow(APPROACH_FOLLOW_STEP_CM, _opt2_travel_speed())
        after, now = _vp_remember()
        moved = math.hypot(after.x - live.x, after.z - live.z) > 0
        if result.get("stoppedBy") == "front_clearance":
            _vp_block_current_direction(before)
        _vp_event("viewpoint_direction_measurement", roadId=road_id, reverse=reverse,
                  distanceCm=result.get("distanceCm"), stoppedBy=result.get("stoppedBy"),
                  actualRoadId=now.get("roadId"), actualProgressCm=now.get("roadProgressCm"), moved=moved)
        if not now.get("onRoad"):
            return False
        if moved:
            return True
        if result.get("stoppedBy") in ("junction", "road_end"):
            return False
    return False


def _vp_enter(road_id):
    before, state = _vp_prepare_node()
    if not state.get("onRoad") or not any(item.get("roadId") == road_id for item in state.get("exits", [])):
        return False
    result = motion_take_exit(road_id, _opt2_travel_speed(), True)
    after, now = _vp_remember()
    moved = math.hypot(after.x - before.x, after.z - before.z)
    edge = edge_by_road.get(road_id)
    if (edge is not None and now.get("roadId") == road_id and now.get("onRoad")
            and state.get("nodeId") in (edge["fromNodeId"], edge["toNodeId"]) and moved > 0):
        # The entry endpoint fixes canonical direction; this is a local tangent, not a road extrapolation.
        sign = 1 if state["nodeId"] == edge["fromNodeId"] else -1
        yaw = after.yaw_rad - math.radians(float(now.get("headingErrorDeg") or 0.0))
        VP_STATE.setdefault("canonical_hints", {})[road_id] = (sign * math.sin(yaw), sign * math.cos(yaw))
    if result.get("stoppedBy") == "front_clearance":
        _vp_block_current_direction(state)
    _vp_event("viewpoint_take_exit", roadId=road_id, distanceCm=result.get("distanceCm"),
              stoppedBy=result.get("stoppedBy"), actualRoadId=now.get("roadId"),
              actualProgressCm=now.get("roadProgressCm"))
    return bool(result.get("accepted") and now.get("onRoad") and moved > 0)


def _vp_travel(candidate):
    if VP_STATE.get("travel_active") != candidate["key"]:
        VP_STATE["travel_attempts"] = set()
        VP_STATE["travel_active"] = candidate["key"]
    pose, state = _vp_remember()
    plan = _vp_path(state, candidate["roadId"], candidate["progressCm"], candidate.get("enter_only", False))
    reason = None
    if plan is not None:
        key = (candidate["key"], state.get("roadId"), round(float(state.get("roadProgressCm") or 0.0), 1),
               plan["direction"], plan.get("entry_node"), tuple(plan["route"]), _vp_block_revision())
        attempted = VP_STATE.setdefault("travel_attempts", set())
        if key in attempted:
            _vp_event("viewpoint_unreachable", key=candidate["key"], reason="repeated_travel_state")
            return _vp_finish_travel("unreachable")
        attempted.add(key)
    if plan is None:
        reason = "no_legal_road_path"
    elif (not plan["direct"] and state.get("atNode") and state.get("nodeId") == plan["entry_node"]
          and any(item.get("roadId") == plan["route"][0] for item in state.get("exits", []))):
        blocked_before = _vp_block_revision()
        if _vp_enter(plan["route"][0]) or _vp_block_revision() != blocked_before:
            return "replan"
        reason = "planned_exit_unavailable_or_blocked"
    elif (_vp_canonical_unit(state.get("roadId"), float(state.get("roadProgressCm") or 0.0)) is None
          and not (plan["direct"] and round(candidate["progressCm"] - float(state["roadProgressCm"]), 1) == 0)):
        if _opt2_learn_direction(state):
            return "replan"
        reason = "canonical_direction_unknown_without_legal_motion"
    elif plan["direct"]:
        delta = candidate["progressCm"] - float(state["roadProgressCm"])
        if round(delta, 1) == 0:
            return _vp_finish_travel("arrived")
        if not _vp_face_progress(plan["direction"], state):
            reason = "canonical_direction_unknown_or_road_changed"
        else:
            result = _vp_follow(abs(delta), _opt2_travel_speed())
            _, now = _vp_remember()
            if result.get("stoppedBy") == "front_clearance" and _vp_block_current_direction(state, plan["direction"]):
                return "replan"
            if now.get("roadId") != candidate["roadId"]:
                if result.get("distanceCm", 0) > 0:
                    return "replan"
                VP_STATE["failed"].add(candidate["key"])
                _vp_event("viewpoint_unreachable", key=candidate["key"], reason="road_changed_without_translation")
                return _vp_finish_travel("unreachable")
            if round(float(now.get("roadProgressCm") or 0.0) - candidate["progressCm"], 1) == 0:
                return _vp_finish_travel("arrived")
            if (result.get("stoppedBy") == "max_distance"
                    and round(float(now.get("roadProgressCm") or 0.0) - float(state["roadProgressCm"]), 1) != 0):
                _vp_event("viewpoint_progress_replan", key=candidate["key"],
                          actualProgressCm=now.get("roadProgressCm"), requestedProgressCm=candidate["progressCm"])
                return "replan"
            reason = "stopped_before_candidate:" + str(result.get("stoppedBy"))
    else:
        if not _vp_face_progress(plan["direction"], state):
            reason = "canonical_direction_unknown_or_road_changed"
        else:
            edge = edge_by_road[state["roadId"]]
            distance = (float(edge["lengthCm"]) - float(state["roadProgressCm"]) if plan["direction"] > 0
                        else float(state["roadProgressCm"]))
            if round(distance, 1) > 0:
                result = _vp_follow(distance, _opt2_travel_speed())
                if result.get("stoppedBy") == "front_clearance" and _vp_block_current_direction(state, plan["direction"]):
                    return "replan"
                if result.get("stoppedBy") not in ("junction", "road_end", "max_distance"):
                    reason = "transition_approach:" + str(result.get("stoppedBy"))
            if reason is None:
                _, now = _vp_prepare_node()
                if now.get("nodeId") != plan["entry_node"]:
                    reason = "different_transition_node"
                else:
                    blocked_before = _vp_block_revision()
                    if _vp_enter(plan["route"][0]) or _vp_block_revision() != blocked_before:
                        return "replan"
                    reason = "planned_exit_unavailable_or_blocked"
    # Missing local evidence is a failed travel attempt, not proof that this
    # destination is unreachable from a later, newly measured entry.
    if reason != "canonical_direction_unknown_without_legal_motion":
        VP_STATE["failed"].add(candidate["key"])
    _vp_event("viewpoint_unreachable", key=candidate["key"], reason=reason)
    return _vp_finish_travel("unreachable")
# END EXACT OPT2 FRAGMENT: opt2_delivery_fragment.py

# BEGIN EXACT OPT2 FRAGMENT: opt2_grasp_fragment.py
"""Bounded in-place recovery AFTER an empty first grab, before the next forward step.

Embedded top-level functions use existing runtime globals/wrappers. No observe,
approach, translation, truth or layout access. The caller keeps its original
first grab, 6cm advance/42cm cap and success metric. See GRASP_DESIGN.md.
"""
import math

# Public interaction defaults in competition-core.js; 8 world units = 1 metre.
OPT2_GRASP_MIN_FORWARD_CM = 4.75
OPT2_GRASP_MAX_FORWARD_CM = 16.875
OPT2_GRASP_MAX_SIDE_CM = 4.75
_OPT2_GRASP_NUMERIC_EPS = 1e-9  # Arithmetic comparison only; no fitted tolerance.


def opt2_grasp_shortest_turn(current_deg, target_deg):
    delta = (target_deg - current_deg + 180.0) % 360.0 - 180.0
    return 180.0 if delta == -180.0 else delta


def opt2_grasp_scan_offsets():
    """Four extra headings; spacing derived solely from the public rectangle."""
    step = 2.0 * math.degrees(math.atan2(OPT2_GRASP_MAX_SIDE_CM,
                                      OPT2_GRASP_MAX_FORWARD_CM))
    return [step, 2.0 * step, -step, -2.0 * step]


def opt2_grasp_components(x_m, z_m, odometry):
    """Return predicted forward/right cm under public left-positive heading."""
    angle = math.radians(float(odometry["headingDeg"]))
    dx = 100.0 * x_m - float(odometry["rightCm"])
    dz = 100.0 * z_m - float(odometry["forwardCm"])
    return (dz * math.cos(angle) - dx * math.sin(angle),
            dx * math.cos(angle) + dz * math.sin(angle))


def opt2_grasp_scan_decision(x_m, z_m, odometry, step_cm, advance_available):
    """Decide from WM geometry only; this is not a bound on true WM error.

    Rotation preserves radius. Outside the public rectangle's corner radius,
    no heading reaches the predicted point. Keep the original forward lattice
    only when its next predicted pose stays ahead of the minimum grasp plane
    and within the lateral window. No remaining step means no scan is skipped.
    """
    forward, side = opt2_grasp_components(x_m, z_m, odometry)
    radius = math.hypot(forward, side)
    corner_radius = math.hypot(OPT2_GRASP_MAX_FORWARD_CM, OPT2_GRASP_MAX_SIDE_CM)
    next_forward = forward - float(step_cm)
    conditions = {"advance_available": bool(advance_available),
                  "outside_predicted_rotation_reach": radius > corner_radius,
                  "next_predicted_forward_at_least_min": next_forward >= OPT2_GRASP_MIN_FORWARD_CM,
                  "predicted_side_within_window": abs(side) <= OPT2_GRASP_MAX_SIDE_CM}
    return {"skip_scan": all(conditions.values()), "conditions": conditions,
            "wm_forward_cm": forward, "wm_right_cm": side, "wm_radius_cm": radius,
            "public_corner_radius_cm": corner_radius, "original_step_cm": float(step_cm),
            "next_predicted_forward_cm": next_forward,
            "public_min_forward_cm": OPT2_GRASP_MIN_FORWARD_CM,
            "public_max_side_cm": OPT2_GRASP_MAX_SIDE_CM,
            "basis": "estimated_WM_geometry_not_true_distance_bound"}


def _opt2_grasp_check(locked_track_id, anchor, odometry, road_state):
    if not road_state.get("onRoad"):
        return "off_road"
    for field in ("rightCm", "forwardCm", "headingDeg"):
        if not isinstance(odometry.get(field), (int, float)) or not math.isfinite(odometry[field]):
            return "odometry_unavailable"
    if (abs(odometry["rightCm"] - anchor["rightCm"]) > _OPT2_GRASP_NUMERIC_EPS
            or abs(odometry["forwardCm"] - anchor["forwardCm"]) > _OPT2_GRASP_NUMERIC_EPS):
        return "unexpected_translation_during_in_place_scan"
    target = _wm_target()
    if (target is None or target.obj_id != locked_track_id
            or STATE.get("confirmation_track_id") != locked_track_id):
        return "confirmed_track_changed"
    if getattr(target.state, "value", target.state) != "confirmed":
        return "target_not_confirmed"
    if not math.isfinite(target.x) or not math.isfinite(target.z):
        return "target_position_unavailable"
    return None


def _opt2_grasp_competitors(locked_track_id, odometry):
    """Block an actual-heading grab if another known ball could be grasped.

This protects against known WM ambiguity. holding() gives only a class: exact
package identity, unseen objects and WM error still require separate driver audit.
"""
    conflicts = []
    for obj in wm.get_scene():
        if (obj.obj_id == locked_track_id or getattr(obj.state, "value", obj.state) == "lost"
                or obj.name not in ("target", "distractor", "目标物", "干扰物")):
            continue
        if not math.isfinite(obj.x) or not math.isfinite(obj.z):
            conflicts.append({"track_id": obj.obj_id, "reason": "other_ball_position_unknown"})
            continue
        forward, side = opt2_grasp_components(obj.x, obj.z, odometry)
        if (OPT2_GRASP_MIN_FORWARD_CM - _OPT2_GRASP_NUMERIC_EPS <= forward
                <= OPT2_GRASP_MAX_FORWARD_CM + _OPT2_GRASP_NUMERIC_EPS
                and abs(side) <= OPT2_GRASP_MAX_SIDE_CM + _OPT2_GRASP_NUMERIC_EPS):
            conflicts.append({"track_id": obj.obj_id, "name": obj.name,
                              "forward_cm": forward, "right_cm": side,
                              "reason": "other_known_ball_in_grab_window"})
    return conflicts


def _opt2_grasp_turn(heading, odometry, road_state, locked_track_id, anchor):
    turn = opt2_grasp_shortest_turn(odometry["headingDeg"], heading)
    if abs(turn) > _OPT2_GRASP_NUMERIC_EPS:
        if turn > 0:
            motion_left_angle(turn)
        else:
            motion_right_angle(-turn)
        odometry, road_state = nav_odometry(), nav_road_state()
    reason = _opt2_grasp_check(locked_track_id, anchor, odometry, road_state)
    error = opt2_grasp_shortest_turn(odometry.get("headingDeg", heading), heading)
    if reason is None and abs(error) > GRAB_AIM_TOL_DEG:
        reason = "turn_did_not_reach_existing_aim_tolerance"
    return odometry, road_state, reason, error


def _opt2_grasp_recover_after_miss(locked_track_id, odometry, road_state, previous_holding,
                                   advance_available=True):
    """Scan only after the caller's original grab returned None.

Return holding, actual extra grab count, latest public snapshots and an explicit
safe_to_advance flag. On capture the caller runs its UNCHANGED success metric;
on restored empty failure it may run its UNCHANGED bounded forward step.
No runtime result asserts a true package ID from the class-only holding API.
"""
    result = {"status": "not_run", "reason": None, "holding": previous_holding,
              "locked_track_id": locked_track_id, "extra_grab_attempts": 0,
              "safe_to_advance": False, "heading_restored": False,
              "observe_calls": 0, "approach_calls": 0,
              "identity_evidence": "confirmed_track_lock_and_holding_class_only",
              "odometry": odometry, "road_state": road_state, "trials": []}
    if previous_holding is not None:
        result["reason"] = "requires_failed_empty_grab"
        return result
    anchor = dict(odometry)
    reason = _opt2_grasp_check(locked_track_id, anchor, odometry, road_state)
    if reason is not None:
        result["reason"] = reason
        return result
    base_heading = float(odometry["headingDeg"])
    target = _wm_target()
    decision = opt2_grasp_scan_decision(target.x, target.z, odometry,
                                        GRAB_STEP_CM, advance_available)
    result["scan_decision"] = decision
    _approach_event("grab_lateral_recovery_decision", track_id=locked_track_id,
                    tick=odometry.get("tick"), **decision)
    if decision["skip_scan"]:
        result.update({"status": "empty_geometry_advance", "safe_to_advance": True,
                       "heading_restored": True})
        return result
    wm_side = decision["wm_right_cm"]
    preferred_sign = -1.0 if wm_side > 0 else 1.0
    offsets = [preferred_sign * angle for angle in opt2_grasp_scan_offsets()]
    _approach_event("grab_lateral_recovery_start", track_id=locked_track_id,
                    tick=odometry.get("tick"), base_heading_deg=base_heading,
                    offsets_deg=offsets, first_grab_holding=previous_holding,
                    public_window_cm=[OPT2_GRASP_MIN_FORWARD_CM,
                                      OPT2_GRASP_MAX_FORWARD_CM, OPT2_GRASP_MAX_SIDE_CM])
    for offset in offsets:
        odometry, road_state, reason, turn_error = _opt2_grasp_turn(
            base_heading + offset, odometry, road_state, locked_track_id, anchor)
        result.update({"odometry": odometry, "road_state": road_state})
        if reason is not None:
            result.update({"status": "failed", "reason": reason})
            _approach_event("grab_lateral_recovery_failed", reason=reason,
                            track_id=locked_track_id, tick=odometry.get("tick"))
            return result
        conflicts = _opt2_grasp_competitors(locked_track_id, odometry)
        trial = {"requested_offset_deg": offset, "actual_offset_deg": opt2_grasp_shortest_turn(
                 base_heading, odometry["headingDeg"]), "turn_error_deg": turn_error,
                 "tick_before_grab": odometry.get("tick"), "competitors": conflicts}
        if conflicts:
            trial["skipped"] = "known_other_ball_may_be_grabbed"
        else:
            motion_grab()
            holding = robot.holding()
            odometry, road_state = nav_odometry(), nav_road_state()
            result["extra_grab_attempts"] += 1
            result.update({"holding": holding, "odometry": odometry, "road_state": road_state})
            trial.update({"holding": holding, "tick_after_grab": odometry.get("tick")})
            reason = _opt2_grasp_check(locked_track_id, anchor, odometry, road_state)
            if reason is not None:
                result.update({"status": "failed", "reason": reason})
            elif holding == "目标物":
                result.update({"status": "holding_target", "reason": None})
            elif holding is not None:
                result.update({"status": "failed", "reason": "holding_wrong_class"})
        result["trials"].append(trial)
        _approach_event("grab_lateral_recovery_step", track_id=locked_track_id,
                        extra_grab_attempt=result["extra_grab_attempts"], onRoad=road_state.get("onRoad"),
                        pose_cm=[odometry.get("rightCm"), odometry.get("forwardCm"), odometry.get("headingDeg")],
                        **trial)
        if result["status"] in ("failed", "holding_target"):
            return result
    odometry, road_state, reason, turn_error = _opt2_grasp_turn(
        base_heading, odometry, road_state, locked_track_id, anchor)
    result.update({"odometry": odometry, "road_state": road_state,
                   "heading_restored": reason is None, "safe_to_advance": reason is None,
                   "status": "empty_restored" if reason is None else "failed", "reason": reason})
    _approach_event("grab_lateral_recovery_end", track_id=locked_track_id,
                    tick=odometry.get("tick"), extra_grab_attempts=result["extra_grab_attempts"],
                    safe_to_advance=result["safe_to_advance"], turn_error_deg=turn_error, reason=reason)
    return result


def _opt2_grasp_success_metric(odometry, road_state, attempts, advanced_cm):
    forward_cm = STATE["forward_after_last_observe_cm"]
    passed = forward_cm >= MEMORY_FORWARD_MIN_CM and bool(road_state.get("onRoad"))
    _approach_event("memory_navigation_metric", passed=bool(passed),
                    last_observe_distance_m=round(STATE["last_observe_distance_m"] or 0.0, 3),
                    last_observe_camera_distance_cm=STATE["last_observe_camera_distance_cm"],
                    forward_after_last_observe_cm=round(forward_cm, 1),
                    required_forward_cm=MEMORY_FORWARD_MIN_CM,
                    approach_calls=STATE["approach_calls"], grab_attempts=attempts,
                    grab_advanced_cm=round(advanced_cm, 1), observe_count=STATE["observe_count"],
                    onRoad=road_state.get("onRoad"), tick=odometry.get("tick"))
    return bool(passed)


def _opt2_grab_loop():
    """Drop-in replacement for the final grab-only loop, after unchanged approach.

No new approach/observe and no target switching. Empty scans restore the original
station heading before the old bounded forward step; a capture immediately exits.
"""
    locked_id = STATE.get("confirmation_track_id")
    odometry, road_state = nav_odometry(), nav_road_state()
    reason = _opt2_grasp_check(locked_id, odometry, odometry, road_state)
    if reason is not None:
        _approach_event("grab_loop_failed", reason=reason, track_id=locked_id)
        return False
    before_holding = robot.holding()
    if before_holding is not None:
        _approach_event("grab_loop_failed", reason="unexpected_preexisting_holding", holding=before_holding)
        return False
    advanced_cm, attempts = 0.0, 0
    station_count = int(GRAB_MAX_ADVANCE_CM // GRAB_STEP_CM) + 1
    for station in range(1, station_count + 1):
        reason = _opt2_grasp_check(locked_id, odometry, odometry, road_state)
        conflicts = _opt2_grasp_competitors(locked_id, odometry)
        if reason is not None or conflicts:
            _approach_event("grab_loop_failed", reason=reason or "known_other_ball_may_be_grabbed",
                            competitors=conflicts, track_id=locked_id)
            return False
        anchor = dict(odometry)
        # The original first action at every station remains an unturned grab.
        motion_grab()
        holding = robot.holding()
        odometry, road_state = nav_odometry(), nav_road_state()
        attempts += 1
        target = _wm_target()
        distance = (math.hypot(target.x - odometry["rightCm"] / 100.0,
                               target.z - odometry["forwardCm"] / 100.0) if target else None)
        _approach_event("grab_step", step=station, grab_attempt=attempts,
                        advanced_cm=round(advanced_cm, 1), holding=holding,
                        tick=odometry.get("tick"), wm_distance_m=distance,
                        onRoad=road_state.get("onRoad"),
                        pose=[odometry["rightCm"] / 100.0, odometry["forwardCm"] / 100.0,
                              odometry["headingDeg"]])
        reason = _opt2_grasp_check(locked_id, anchor, odometry, road_state)
        if reason is not None or holding not in (None, "目标物"):
            _approach_event("grab_loop_failed", reason=reason or "holding_wrong_object", holding=holding)
            return False
        if holding == "目标物":
            return _opt2_grasp_success_metric(odometry, road_state, attempts, advanced_cm)
        recovery = _opt2_grasp_recover_after_miss(locked_id, odometry, road_state, holding,
                                                  station < station_count)
        attempts += recovery["extra_grab_attempts"]
        odometry, road_state = recovery["odometry"], recovery["road_state"]
        if recovery["status"] == "holding_target":
            return _opt2_grasp_success_metric(odometry, road_state, attempts, advanced_cm)
        if not recovery["safe_to_advance"]:
            _approach_event("grab_loop_failed", reason=recovery["reason"] or "lateral_recovery_unsafe",
                            grabs=attempts, advanced_cm=advanced_cm)
            return False
        if station == station_count:
            break
        before_distance = float(odometry.get("distanceCm") or 0.0)
        motion_forward(GRAB_STEP_CM)
        odometry, road_state = nav_odometry(), nav_road_state()
        moved = max(0.0, float(odometry.get("distanceCm") or 0.0) - before_distance)
        advanced_cm += moved
        STATE["forward_after_last_observe_cm"] += moved
        if not road_state.get("onRoad"):
            _approach_event("grab_loop_failed", reason="off_road", step=station,
                            advanced_cm=advanced_cm, lateralOffsetCm=road_state.get("lateralOffsetCm"))
            return False
        if moved < GRAB_STEP_CM * 0.5:
            _approach_event("grab_step_blocked", step=station, movedCm=moved, advanced_cm=advanced_cm)
    _approach_event("grab_loop_failed", reason="max_advance_reached", grabs=attempts,
                    advanced_cm=advanced_cm, max_advance_cm=GRAB_MAX_ADVANCE_CM,
                    approach_calls=STATE["approach_calls"])
    return False
# END EXACT OPT2 FRAGMENT: opt2_grasp_fragment.py

# BEGIN EXACT OPT2 FRAGMENT: opt2_motion_fragment.py
"""Use the existing road-limited cruise speed for memory travel and later patrol.

The confirmation planner and the final fine drive keep their original speed.
No new distance, speed or timing threshold is introduced.
"""

OPT2_MEMORY_TRAVEL_ACTIVE = False


def _opt2_memory_navigation(target):
    global OPT2_MEMORY_TRAVEL_ACTIVE
    previous = OPT2_MEMORY_TRAVEL_ACTIVE
    OPT2_MEMORY_TRAVEL_ACTIVE = True
    try:
        return _approach_graph_navigation(target)
    finally:
        OPT2_MEMORY_TRAVEL_ACTIVE = previous


def _opt2_patrol_follow(distance, original_speed):
    speed = CRUISE_SPEED if DEMO_STATE["ball_index"] > 1 else original_speed
    return _vp_follow(distance, speed)


def _opt2_patrol_enter(road_id):
    global OPT2_MEMORY_TRAVEL_ACTIVE
    previous = OPT2_MEMORY_TRAVEL_ACTIVE
    OPT2_MEMORY_TRAVEL_ACTIVE = DEMO_STATE["ball_index"] > 1
    try:
        return _vp_enter(road_id)
    finally:
        OPT2_MEMORY_TRAVEL_ACTIVE = previous
# END EXACT OPT2 FRAGMENT: opt2_motion_fragment.py

# BEGIN EXACT OPT2 FRAGMENT: opt2_acquisition_fragment.py
"""Expire unsupported planning goals using real new frames and existing WM decay.

An out-of-window or capped red observation is not a missed detection. It remains
planning-only. The WorldModel's fusion, confidence parameters and hit rules are
unchanged; this bridge supplies previously omitted empty-frame updates.
"""


def _opt2_has_red(observations):
    # Explicit iteration remains valid after the platform makes helpers async.
    for item in observations:
        if _is_target(item):
            return True
    return False


def _opt2_clear_lost_selection(track_id):
    STATE["confirmation_track_id"] = None
    STATE["accepted_hits"] = []
    STATE["frame_track_ids"] = {key: value for key, value in STATE["frame_track_ids"].items()
                                if value != track_id}
    STATE["last_observed_world"] = None
    for name in ("explored", "failed", "nudged", "travel_attempts"):
        VP_STATE[name] = set()
    VP_STATE["travel_active"] = None
    DEMO_STATE["selection_snapshot"] = None
    _demo_event("target_search_abandoned", previous_track_id=track_id,
                reason="existing_WM_decay_archived_selected_track",
                wm_history_preserved=True)


def _opt2_update_observations(observations, pose, timestamp, memory_phase=True):
    _update_wm(observations, pose, timestamp, memory_phase=memory_phase)
    # A red reading outside the accepted distance window is still positive
    # visual evidence. Do not turn it into an invented miss by range clipping.
    if not _opt2_has_red(observations):
        before = [{"id": obj.obj_id, "state": obj.state.value,
                   "hit": obj.hit_count, "conf": obj.confidence}
                  for obj in wm.get_scene()]
        if before:
            wm.update([], pose, now=timestamp)
            after = [{"id": obj.obj_id, "state": obj.state.value,
                      "hit": obj.hit_count, "conf": obj.confidence}
                     for obj in (wm.get_object(item["id"]) for item in before)
                     if obj is not None]
            _demo_event("wm_empty_frame_update", before=before, after=after,
                        reason="new_frame_has_no_eligible_red_existing_decay_only")
    selected_id = STATE.get("confirmation_track_id")
    selected = wm.get_object(selected_id) if selected_id is not None else None
    if selected_id is not None and (selected is None or selected.state == ObjectState.LOST):
        _opt2_clear_lost_selection(selected_id)


def _opt2_planning_evidence_expired(goal, observations):
    """Only called after an actual observe, never during geometry-only replans."""
    track_id = goal.get("track_id")
    if track_id is not None:
        target = wm.get_object(track_id)
        expired = target is None or target.state == ObjectState.LOST
        reason = "selected_WM_track_lost"
    else:
        expired = (goal.get("source") == "capped_bearing_only"
                   and not _opt2_has_red(observations))
        reason = "capped_bearing_not_seen_in_new_frame"
    if expired:
        STATE["planning_goal_abandoned"] = True
        _demo_event("range_entry_abandoned", goal_source=goal.get("source"),
                    previous_track_id=track_id, reason=reason)
    return expired


def _opt2_confirmation_should_abort():
    # Another real track can have appeared in the frame that retired the old
    # lock. Let patrol continue with that WM memory, not label it a failed track.
    if STATE.pop("planning_goal_abandoned", False):
        return False
    return _wm_target() is not None
# END EXACT OPT2 FRAGMENT: opt2_acquisition_fragment.py

try:
    run_target_flow()
except MissionFailure as failure:
    _finish_flow(False, "constraint", str(failure))
