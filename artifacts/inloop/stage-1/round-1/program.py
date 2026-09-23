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

PROGRAM_VERSION = "wm-stage1-r1-20260923"
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
WM_KIT_COMMIT = "ad237a143f0d35e100a28c15567d4b75bd56cccf"

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
        odo = robot.odometry() or {}
        pose = [round(float(odo.get("rightCm", 0.0)) / 100.0, 3),
                round(float(odo.get("forwardCm", 0.0)) / 100.0, 3),
                round(float(odo.get("headingDeg", 0.0)), 1)]
    except Exception:
        pose = None
    try:
        rs = robot.road_state() or {}
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
    result = robot.follow_road(max_cm, speed, True)
    _delivery_event("delivery_follow_road", stage=stage, roadId=road_id, requestCm=max_cm,
                    distanceCm=result.get("distanceCm"), stoppedBy=result.get("stoppedBy"),
                    accepted=result.get("accepted"))
    return result


def _dl_take_exit(stage, road_id, speed):
    result = robot.take_exit(road_id, speed, True)
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
target_anchors = [item for item in mission_objects if item.get("role") == "target"]
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
            _delivery_event("delivery_node_nudge", nudgeCm=NODE_NUDGE_CM, atNode=state.get("atNode"), nodeId=state.get("nodeId"))
            if state["atNode"]:
                return state
    raise RuntimeError("无法从道路状态确认图节点")


def enter_road(road_id):
    state = node_state()
    legal = {item["roadId"] for item in state["exits"]}
    if road_id not in legal:
        raise RuntimeError("规划道路不在当前合法出口中：" + road_id)
    result = _dl_take_exit("enter_road", road_id, CRUISE_SPEED)
    if not result["accepted"]:
        raise RuntimeError("进入道路失败：" + result["stoppedBy"])
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
        result = _dl_follow("anchor_progress", road_id, max(10, min(500, remaining)), speed_for(road_id))
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



def leave_released_package():
    """投放后先沿当前道路离开包裹，再把控制权交回拓扑规划。

    已投放包裹仍有真实碰撞体；front_clearance 表明它正挡住车头时，
    不能把它误判为未知障碍而硬闯。这里仅反向面对同一条道路，使用
    follow_road 到最近拓扑节点，不使用世界坐标或预写行驶距离。
    """
    state = robot.road_state()
    if state["frontClearanceCm"] is not None:
        robot.left_angle(180)
    result = _dl_follow("leave_released_package", state["roadId"], 500, speed_for(state["roadId"]))
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
        moved = _dl_follow("release_sample", None, distance_cm, CRUISE_SPEED)
        robot.left_angle(180)
        if moved["accepted"]:
            # 摄像头只作为可解释的现场确认，不用它的成败代替确定性投放预览。
            if _observe_motion()[0]:
                counted_observe("存放点", 0.45)
            else:
                _delivery_event("delivery_observe_not_needed", reason="no_new_observation_motion")
            preview = robot.release_preview()
            if preview["holding"] == "target" and preview["releaseAccepted"] and preview["wouldCompleteDelivery"]:
                robot.release()
                leave_released_package()
                return True
        # 回到任务道路锚点后再尝试下一个局部投放位置。
        robot.left_angle(180)
        _dl_follow("release_return", None, max(10, moved["distanceCm"]), CRUISE_SPEED)
        robot.left_angle(180)
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


class MissionFailure(Exception):
    """明确记录的任务约束失败；不用于捕获编程异常。"""


def _observe_motion(odo=None):
    odo = odo if odo is not None else robot.odometry()
    last = STATE.get("last_observe_pose")
    current = [float(odo.get("rightCm", 0.0)), float(odo.get("forwardCm", 0.0)),
               float(odo.get("headingDeg", 0.0))]
    if last is None:
        return True, current, None, None
    moved = math.hypot(current[0] - last[0], current[1] - last[1])
    turned = abs(_wrap_deg(current[2] - last[2]))
    return moved >= OBS_MIN_TRANSLATION_CM or turned >= OBS_MIN_TURN_DEG, current, moved, turned


def counted_observe(category=None, confidence=0.6, targets_only=False):
    if STATE["observe_count"] >= MAX_OBSERVES:
        print("GY " + json.dumps({
            "event": "observe_budget_exhausted",
            "observe_count": STATE["observe_count"],
            "max_observes": MAX_OBSERVES,
        }, ensure_ascii=False))
        raise MissionFailure("observe_budget_exhausted")
    odo = robot.odometry() or {}
    ready, observed_pose, moved, turned = _observe_motion(odo)
    if not ready:
        print("GY " + json.dumps({"event": "observe_motion_violation", "tick": odo.get("tick"),
                                  "translationCm": moved, "turnDeg": turned, "odo": observed_pose,
                                  "requiredTranslationCm": OBS_MIN_TRANSLATION_CM,
                                  "requiredTurnDeg": OBS_MIN_TURN_DEG}, ensure_ascii=False))
        raise MissionFailure("observe_motion_violation")
    # 单次公开视觉查询取全部类别、全部置信度；日志之后才按调用目的筛选。
    result = robot.observe(None, 0.0)
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
    result = [item for item in (result or []) if float(item.get("confidence") or 0.0) >= confidence]
    if category is not None:
        requested = str(category).strip().lower().replace("_", "-")
        requested = {"目标物": "target", "红球": "target", "混淆物": "distractor", "干扰物": "distractor",
                     "障碍物": "obstacle", "障碍": "obstacle", "存放点": "storage-zone", "存放区": "storage-zone",
                     "清理点": "cleanup-zone", "清理区": "cleanup-zone"}.get(requested, requested)
        result = [item for item in result if str(item.get("category") or "").lower() == requested]
    if targets_only:
        return [item for item in (result or []) if _is_target(item)]
    return result

def _wrap_deg(value):
    return (value + 180.0) % 360.0 - 180.0


def _pose_log(pose):
    """日志位姿 [x_m, z_m, headingDeg]。headingDeg 与 robot.odometry()["headingDeg"] 同号（左转为正），
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
        print("GY " + json.dumps({"event": "wm_associations", "tick": robot.odometry().get("tick"),
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
    state = robot.road_state()
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
    pose = odometry_to_pose(robot.odometry())
    start_bearing = _wm_bearing_deg(pose)
    turns = []
    ok = False
    for _ in range(max_turns):
        target = _wm_target()
        if target is None:
            break
        pose = odometry_to_pose(robot.odometry())
        bearing = _wm_bearing_deg(pose)
        if bearing is None:
            break
        if abs(bearing) <= tol_deg:
            ok = True
            break
        turn = min(abs(bearing), 40.0)
        if bearing > 0:
            robot.right_angle(turn)
            turns.append(round(-turn, 1))
        else:
            robot.left_angle(turn)
            turns.append(round(turn, 1))
    pose = odometry_to_pose(robot.odometry())
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

VP_STATE = {"roads": {}, "intervals": {}, "explored": set(), "failed": set(), "nudged": set()}


def _vp_event(event, **fields):
    print("GY " + json.dumps(dict(event=event, **fields), ensure_ascii=False))


def _vp_remember():
    odo = robot.odometry() or {}
    pose = odometry_to_pose(odo)
    state = robot.road_state() or {}
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
        return None
    a, b = min(pairs, key=lambda pair: abs(progress - (pair[0]["s"] + pair[1]["s"]) / 2))
    dx, dz = b["x"] - a["x"], b["z"] - a["z"]
    length = math.hypot(dx, dz)
    return (dx / length, dz / length) if length else None


def _vp_path(state, road_id, progress):
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
        a, b = ((current["fromNodeId"], current["toNodeId"]) if direction > 0
                else (current["toNodeId"], current["fromNodeId"]))
        if (a, b, road_id) not in blocked_directions:
            plans.append({"cost_cm": abs(progress - start_s), "direct": True,
                          "direction": direction, "route": []})
    starts = [(current["toNodeId"], float(current["lengthCm"]) - start_s, 1)]
    if not current["oneWay"]:
        starts.append((current["fromNodeId"], start_s, -1))
    ends = [(target["fromNodeId"], progress)]
    if not target["oneWay"]:
        ends.append((target["toNodeId"], float(target["lengthCm"]) - progress))
    for node, initial_cm, direction in starts:
        from_node = current["fromNodeId"] if direction > 0 else current["toNodeId"]
        if (from_node, node, current["roadId"]) in blocked_directions:
            continue
        for end_node, final_cm in ends:
            destination_node = target["toNodeId"] if end_node == target["fromNodeId"] else target["fromNodeId"]
            if (end_node, destination_node, road_id) in blocked_directions:
                continue
            route = dijkstra(node, end_node)
            if route is not None:
                plans.append({"cost_cm": initial_cm + route[1] + final_cm, "direct": False,
                              "direction": direction, "entry_node": node,
                              "route": list(route[0]) + [road_id]})
    return min(plans, key=lambda plan: plan["cost_cm"]) if plans else None


def _vp_candidates(goal, final_sample, tried):
    pose, state = _vp_remember()
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
        before = robot.odometry() or {}
        if remaining < APPROACH_FOLLOW_STEP_CM:
            # The public drive API permits small final grid corrections; follow_road does not.
            state = robot.road_state() or {}
            if not state.get("onRoad"):
                return {"accepted": False, "distanceCm": total, "stoppedBy": "off_road"}
            align_to_current_road()
            robot.forward(round(remaining, 1))
            after = robot.odometry() or {}
            moved = max(0.0, float(after.get("distanceCm") or 0.0) - float(before.get("distanceCm") or 0.0))
            _, state = _vp_remember()
            result = {"accepted": bool(state.get("onRoad")), "distanceCm": moved,
                      "stoppedBy": "max_distance" if state.get("onRoad") else "off_road"}
        else:
            requested = min(remaining, float(APPROACH_FOLLOW_STEP_CM))
            result = robot.follow_road(requested, speed, True)
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
        robot.left_angle(180)
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
            robot.forward(NODE_NUDGE_CM)
            pose, state = _vp_remember()
            _vp_event("viewpoint_node_nudge", distanceCm=NODE_NUDGE_CM,
                      atNode=state.get("atNode"), nodeId=state.get("nodeId"))
    return pose, state


def _vp_enter(road_id):
    before, state = _vp_prepare_node()
    if not state.get("onRoad") or not any(item.get("roadId") == road_id for item in state.get("exits", [])):
        return False
    result = robot.take_exit(road_id, SLOW_SPEED, True)
    after, now = _vp_remember()
    moved = math.hypot(after.x - before.x, after.z - before.z)
    _vp_event("viewpoint_take_exit", roadId=road_id, distanceCm=result.get("distanceCm"),
              stoppedBy=result.get("stoppedBy"), actualRoadId=now.get("roadId"),
              actualProgressCm=now.get("roadProgressCm"))
    return bool(result.get("accepted") and now.get("onRoad") and moved > 0)


def _vp_travel(candidate):
    pose, state = _vp_remember()
    plan = _vp_path(state, candidate["roadId"], candidate["progressCm"])
    reason = None
    if plan is None:
        reason = "no_legal_road_path"
    elif plan["direct"]:
        delta = candidate["progressCm"] - float(state["roadProgressCm"])
        if round(delta, 1) == 0:
            return "arrived"
        if not _vp_face_progress(plan["direction"], state):
            reason = "canonical_direction_unknown_or_road_changed"
        else:
            result = _vp_follow(abs(delta), SLOW_SPEED)
            _, now = _vp_remember()
            if now.get("roadId") != candidate["roadId"]:
                if result.get("distanceCm", 0) > 0:
                    return "replan"
                VP_STATE["failed"].add(candidate["key"])
                _vp_event("viewpoint_unreachable", key=candidate["key"], reason="road_changed_without_translation")
                return "unreachable"
            if round(float(now.get("roadProgressCm") or 0.0) - candidate["progressCm"], 1) == 0:
                return "arrived"
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
                if result.get("stoppedBy") not in ("junction", "road_end", "max_distance"):
                    reason = "transition_approach:" + str(result.get("stoppedBy"))
            if reason is None:
                _, now = _vp_prepare_node()
                if now.get("nodeId") != plan["entry_node"]:
                    reason = "different_transition_node"
                elif _vp_enter(plan["route"][0]):
                    return "replan"
                else:
                    reason = "planned_exit_unavailable_or_blocked"
    VP_STATE["failed"].add(candidate["key"])
    _vp_event("viewpoint_unreachable", key=candidate["key"], reason=reason)
    return "unreachable"


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
            destination = edge["toNodeId"] if state.get("nodeId") == edge["fromNodeId"] else edge["fromNodeId"]
            if (state.get("nodeId"), destination, exit_road) in blocked_directions:
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
            from_node, to_node = ((edge["fromNodeId"], edge["toNodeId"]) if positive
                                  else (edge["toNodeId"], edge["fromNodeId"]))
            if (from_node, to_node, road_id) in blocked_directions or (edge["oneWay"] and not positive):
                continue
        elif any(item[2] == road_id for item in blocked_directions):
            # Do not guess canonical orientation when a directional restriction exists.
            continue
        VP_STATE["explored"].add(key)
        live_pose, live_state = _vp_remember()
        if live_state.get("roadId") != road_id:
            return False
        live_yaw = live_pose.yaw_rad - math.radians(float(live_state.get("headingErrorDeg") or 0.0))
        align_to_current_road()
        if math.cos(live_yaw - planned_yaw) < 0:
            robot.left_angle(180)
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
        det = calibrated_detection(item, pose, float(robot.odometry().get("tick", 0)) * 0.02)
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
            robot.right_angle(abs(bearing))
        else:
            robot.left_angle(abs(bearing))
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
    timestamp = float(robot.odometry().get("tick", 0)) * 0.02
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
            timestamp = float(robot.odometry().get("tick", 0)) * 0.02
            _update_wm(observations, pose, timestamp, memory_phase=True)
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
            timestamp = float(robot.odometry().get("tick", 0)) * 0.02
            _update_wm(observations, pose, timestamp, memory_phase=True)
            target = _try_enter_range_and_confirm(pose, observations)
            if target is not None:
                return target
            if _wm_target() is not None:
                return _confirm_fail("confirmation_aborted", reason="target_seen_but_confirmation_failed")
        _, state = _vp_remember()
        exits = [item for item in state.get("exits", []) if item.get("roadId")]
        choices = [item for item in exits if item["roadId"] not in visited] or exits
        if not choices:
            align_to_current_road()
            robot.left_angle(180)
            _vp_follow(150, 30)
            _vp_prepare_node()
            continue
        chosen = choices[0]
        if not _vp_enter(chosen["roadId"]):
            return _confirm_fail("patrol_failed", reason="exit_unavailable", roadId=chosen["roadId"])
        visited.add(chosen["roadId"])
        for _ in range(2):
            result = _vp_follow(150, 30)
            if STATE["observe_count"] >= max_obs:
                return None
            pose, state = _vp_remember()
            if not state.get("onRoad"):
                raise MissionFailure("patrol_off_road")
            if _observe_motion()[0]:
                observations = counted_observe(None, 0.4, targets_only=True)
                timestamp = float(robot.odometry().get("tick", 0)) * 0.02
                _update_wm(observations, pose, timestamp, memory_phase=True)
                target = _try_enter_range_and_confirm(pose, observations)
                if target is not None:
                    return target
                if _wm_target() is not None:
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
    state = robot.road_state()
    if not state.get("onRoad"):
        _approach_event("approach_on_road_violation", stage=stage,
                        roadId=state.get("roadId"), onRoad=False,
                        lateralOffsetCm=state.get("lateralOffsetCm"))
        return None
    return state


def _turn_toward_bearing(bearing):
    if bearing > 8.0:
        robot.right_angle(min(abs(bearing), 30.0))
    elif bearing < -8.0:
        robot.left_angle(min(abs(bearing), 30.0))




def _approach_memory_move(step_cm):
    """小步 follow_road；0cm 由调用方按路口处理。"""
    state = _approach_on_road("before_memory_follow")
    if state is None:
        return None
    pose = odometry_to_pose(robot.odometry())
    target = _wm_target()
    if target is None or target.state == ObjectState.LOST:
        _approach_event("approach_failed", reason="target_lost_before_memory_follow")
        return None
    bearing = _wm_bearing_deg(pose)
    if bearing is None:
        return None
    if abs(bearing) > 90.0:
        robot.left_angle(180.0)
        state = _approach_on_road("after_memory_turn_around")
        if state is None:
            return None
    result = robot.follow_road(float(step_cm), SLOW_SPEED, True)
    state = _approach_on_road("after_memory_follow")
    if state is None:
        return None
    moved_cm = float(result.get("distanceCm") or 0.0)
    STATE["forward_after_last_observe_cm"] += moved_cm
    stopped = str(result.get("stoppedBy") or "")
    blocked = stopped in ("front_clearance", "collision", "safety_limit")
    if blocked:
        pose = odometry_to_pose(robot.odometry())
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


def _approach_graph_exit_fallback(state):
    """road_state.exits 为空时，用公开 graph 找通往任一 target 锚点的下一段路。"""
    road_id = state.get("roadId")
    edge = edge_by_road.get(road_id) if road_id else None
    if edge is None:
        return None, []
    node_id = state.get("nodeId")
    if not node_id:
        progress = state.get("roadProgressCm")
        if progress is not None:
            try:
                node_id = (edge["toNodeId"] if float(progress) >= float(edge["lengthCm"]) / 2.0
                           else edge["fromNodeId"])
            except (TypeError, ValueError):
                node_id = edge["toNodeId"]
        else:
            node_id = edge["toNodeId"]
    goal_nodes = []
    for anchor in target_anchors:
        anchor_edge = edge_by_road.get(anchor.get("roadId"))
        if anchor_edge is not None:
            goal_nodes.extend(endpoints(anchor_edge))
    candidates = []
    for next_node, candidate_road, _length_cm in adj.get(node_id, []):
        if candidate_road == road_id:
            continue
        best_remaining = None
        for goal_node in goal_nodes:
            route_info = dijkstra(next_node, goal_node, {road_id})
            if route_info is not None and (best_remaining is None or route_info[1] < best_remaining):
                best_remaining = route_info[1]
        if best_remaining is not None:
            candidates.append({
                "roadId": candidate_road,
                "nextNodeId": next_node,
                "remainingToTargetAnchorCm": round(best_remaining, 1),
            })
    candidates.sort(key=lambda item: item["remainingToTargetAnchorCm"])
    return node_id, candidates


def _approach_choose_exit(state, target_bearing_deg):
    """按 WorldModel 目标方位选择最接近的出口。"""
    road_id = state.get("roadId")
    exits = [dict(item) for item in state.get("exits", []) if item.get("roadId")]
    if not exits:
        fallback_node, fallback_candidates = _approach_graph_exit_fallback(state)
        if fallback_candidates:
            chosen_fallback = fallback_candidates[0]
            print("GY " + json.dumps({
                "event": "approach_junction_decision",
                "roadId": road_id,
                "nodeId": fallback_node,
                "targetBearingDeg": round(target_bearing_deg, 1),
                "exits": [{"roadId": item["roadId"],
                           "direction": "graph_fallback",
                           "turnDeg": None,
                           "remainingToTargetAnchorCm": item["remainingToTargetAnchorCm"]}
                          for item in fallback_candidates],
                "chosenRoadId": chosen_fallback["roadId"],
                "chosenDirection": "graph_fallback",
                "chosenTurnDeg": None,
                "reason": "road_state_exits_empty_use_graph_shortest_to_target_anchor",
            }, ensure_ascii=False))
            return {"roadId": chosen_fallback["roadId"],
                    "direction": "graph_fallback",
                    "turnDeg": None}, 0.0
        print("GY " + json.dumps({
            "event": "approach_junction_decision",
            "roadId": road_id,
            "nodeId": fallback_node,
            "targetBearingDeg": round(target_bearing_deg, 1),
            "exits": [],
            "chosenRoadId": None,
            "reason": "no_exits_and_no_graph_fallback",
        }, ensure_ascii=False))
        return None, 180.0
    desired_turn_deg = _wrap_deg(-float(target_bearing_deg))
    scored = []
    for exit_item in exits:
        turn_deg = float(exit_item.get("turnDeg") or 0.0)
        error = abs(_wrap_deg(turn_deg - desired_turn_deg))
        scored.append((error, exit_item, turn_deg))
    scored.sort(key=lambda item: item[0])
    error, chosen, chosen_turn = scored[0]
    reason = ("all_exits_turn_away" if error > 90.0
              else "minimum_turn_error_to_target_bearing")
    print("GY " + json.dumps({
        "event": "approach_junction_decision",
        "roadId": road_id,
        "targetBearingDeg": round(target_bearing_deg, 1),
        "desiredExitTurnDeg": round(desired_turn_deg, 1),
        "exits": [
            {"roadId": item.get("roadId"), "direction": item.get("direction"),
             "turnDeg": item.get("turnDeg")}
            for item in exits
        ],
        "chosenRoadId": chosen.get("roadId"),
        "chosenDirection": chosen.get("direction"),
        "chosenTurnDeg": chosen_turn,
        "chosenTurnErrorDeg": round(error, 1),
        "reason": reason,
    }, ensure_ascii=False))
    return chosen, error


def approach_target_with_world_model(target):
    """确认后沿道路小步接近；路口用 take_exit，禁止直线追目标离路。"""
    state = _approach_on_road("start")
    if state is None:
        return False
    pose = odometry_to_pose(robot.odometry())
    target = _wm_target() or target
    if target is None or target.state == ObjectState.LOST:
        _approach_event("approach_failed", reason="target_lost_at_start")
        return False
    distance_m = math.hypot(target.x - pose.x, target.z - pose.z)
    best_distance_m = distance_m
    previous_distance_m = distance_m
    increasing_steps = 0
    stop_reason = "max_memory_steps"

    for _ in range(APPROACH_MAX_MEMORY_STEPS):
        if distance_m <= APPROACH_FINE_DISTANCE_M:
            stop_reason = "fine_phase"
            break
        step_cm = APPROACH_FOLLOW_STEP_CM
        move = _approach_memory_move(step_cm)
        if move is None:
            return False
        moved_cm = move["moved_cm"]
        state = move["state"]
        pose = odometry_to_pose(robot.odometry())
        target = _wm_target() or target
        if target is None or target.state == ObjectState.LOST:
            _approach_event("approach_failed", reason="target_lost_after_memory_follow")
            return False
        distance_m = math.hypot(target.x - pose.x, target.z - pose.z)
        target_bearing = _wm_bearing_deg(pose) or 0.0
        print("GY " + json.dumps({
            "event": "approach_step",
            "wm_distance_m": round(distance_m, 3),
            "wm_bearing_deg": round(target_bearing, 1),
            "step_requestCm": step_cm,
            "follow_distanceCm": round(moved_cm, 1),
            "stoppedBy": move["result"].get("stoppedBy"),
            "pose": _pose_log(pose),
            "onRoad": state.get("onRoad"),
            "frontClearanceCm": state.get("frontClearanceCm"),
            "roadId": state.get("roadId"),
            "atNode": state.get("atNode"),
            "atJunction": state.get("atJunction"),
            "nodeId": state.get("nodeId"),
            "roadProgressCm": state.get("roadProgressCm"),
            "roadIds": state.get("roadIds"),
            "last_observe_distance_m": round(STATE["last_observe_distance_m"] or 0.0, 3),
            "last_observe_camera_distance_cm": STATE["last_observe_camera_distance_cm"],
            "forward_after_last_observe_cm": round(STATE["forward_after_last_observe_cm"], 1),
        }, ensure_ascii=False))

        if move.get("blocked"):
            best_distance_m = min(best_distance_m, distance_m)
            stop_reason = "blocked_near_target"
            break
        if distance_m <= APPROACH_FINE_DISTANCE_M:
            best_distance_m = distance_m
            stop_reason = "fine_phase"
            break

        if moved_cm < 5.0 and moved_cm < step_cm - 0.5:
            front = state.get("frontClearanceCm")
            if front is not None and front <= APPROACH_JUNCTION_FRONT_MIN_CM:
                _approach_event("approach_min_distance_failed",
                                reason="front_clearance_at_endpoint",
                                min_wm_distance_m=round(min(best_distance_m, distance_m), 3),
                                current_wm_distance_m=round(distance_m, 3),
                                roadId=state.get("roadId"),
                                frontClearanceCm=front,
                                required_m=APPROACH_DISTANCE_M,
                                onRoad=state.get("onRoad"))
                return False
            # 平台在部分路口边界会先返回 0cm，atNode=false 且 exits=[]；
            # 旧规划器用一个 2cm 探步进入节点范围。这里只用于让 take_exit 可用。
            _approach_event("approach_endpoint_nudge",
                            roadId=state.get("roadId"),
                            roadProgressCm=state.get("roadProgressCm"),
                            atNode=state.get("atNode"),
                            atJunction=state.get("atJunction"),
                            nudgeCm=APPROACH_NODE_NUDGE_CM)
            odo_before = float((robot.odometry() or {}).get("distanceCm") or 0.0)
            robot.forward(APPROACH_NODE_NUDGE_CM)
            odo_after = float((robot.odometry() or {}).get("distanceCm") or 0.0)
            nudged_cm = odo_after - odo_before if odo_after >= odo_before else APPROACH_NODE_NUDGE_CM
            STATE["forward_after_last_observe_cm"] += nudged_cm
            state = _approach_on_road("after_endpoint_nudge")
            if state is None:
                return False
            _approach_event("approach_endpoint_nudge_result", odometry_deltaCm=round(nudged_cm, 1),
                            atNode=state.get("atNode"), atJunction=state.get("atJunction"),
                            nodeId=state.get("nodeId"), exits=len(state.get("exits") or []))
            pose = odometry_to_pose(robot.odometry())
            target_bearing = _wm_bearing_deg(pose) or 0.0
            chosen, turn_error = _approach_choose_exit(state, target_bearing)
            if chosen is None or turn_error > 90.0:
                _approach_event("approach_min_distance_failed",
                                reason=("no_exit" if chosen is None else "all_exits_turn_away"),
                                min_wm_distance_m=round(min(best_distance_m, distance_m), 3),
                                current_wm_distance_m=round(distance_m, 3),
                                roadId=state.get("roadId"),
                                chosenExitTurnErrorDeg=round(turn_error, 1),
                                required_m=APPROACH_DISTANCE_M,
                                onRoad=state.get("onRoad"))
                return False
            try:
                exit_result = robot.take_exit(chosen["roadId"], SLOW_SPEED, True)
            except Exception as error:
                _approach_event("approach_failed", reason="take_exit_exception",
                                error=str(error), roadId=chosen.get("roadId"))
                return False
            if not exit_result.get("accepted", True):
                _approach_event("approach_failed", reason="take_exit_rejected",
                                roadId=chosen.get("roadId"),
                                stoppedBy=exit_result.get("stoppedBy"))
                return False
            state = _approach_on_road("after_take_exit")
            if state is None:
                return False
            exit_cm = float(exit_result.get("distanceCm") or 0.0)
            STATE["forward_after_last_observe_cm"] += exit_cm
            pose = odometry_to_pose(robot.odometry())
            target = _wm_target() or target
            if target is None or target.state == ObjectState.LOST:
                _approach_event("approach_failed", reason="target_lost_after_take_exit")
                return False
            distance_m = math.hypot(target.x - pose.x, target.z - pose.z)
            _approach_event("approach_exit_move", roadId=state.get("roadId"),
                            exit_distanceCm=round(exit_cm, 1), stoppedBy=exit_result.get("stoppedBy"),
                            wm_distance_m=round(distance_m, 3),
                            wm_bearing_deg=round(_wm_bearing_deg(pose) or 0.0, 1),
                            pose=_pose_log(pose),
                            forward_after_last_observe_cm=round(STATE["forward_after_last_observe_cm"], 1))
            best_distance_m = min(best_distance_m, distance_m)
            previous_distance_m = distance_m
            increasing_steps = 0
            continue

        if distance_m < best_distance_m:
            best_distance_m = distance_m
        if distance_m > previous_distance_m + APPROACH_IMPROVE_M:
            increasing_steps += 1
        else:
            increasing_steps = 0
        previous_distance_m = distance_m
        if increasing_steps >= 2:
            stop_reason = "passed_nearest_point"
            break

    pose = odometry_to_pose(robot.odometry())
    target = _wm_target() or target
    if target is None or target.state == ObjectState.LOST:
        _approach_event("approach_failed", reason="target_lost_after_memory_nav")
        return False
    distance_m = math.hypot(target.x - pose.x, target.z - pose.z)
    state = _approach_on_road("after_memory_nav")
    if state is None:
        return False
    print("GY " + json.dumps({
        "event": "approach_memory_stop",
        "reason": stop_reason,
        "wm_distance_m": round(distance_m, 3),
        "min_wm_distance_m": round(min(best_distance_m, distance_m), 3),
        "wm_bearing_deg": round(_wm_bearing_deg(pose) or 0.0, 1),
        "pose": _pose_log(pose),
        "roadId": state.get("roadId"),
        "onRoad": state.get("onRoad"),
        "frontClearanceCm": state.get("frontClearanceCm"),
        "forward_after_last_observe_cm": round(STATE["forward_after_last_observe_cm"], 1),
        "last_observe_distance_m": round(STATE["last_observe_distance_m"] or 0.0, 3),
    }, ensure_ascii=False))

    if distance_m > APPROACH_FINE_DISTANCE_M:
        _approach_event("approach_min_distance_failed",
                        reason="memory_nav_stopped_above_threshold",
                        min_wm_distance_m=round(best_distance_m, 3),
                        current_wm_distance_m=round(distance_m, 3),
                        roadId=state.get("roadId"),
                        required_m=APPROACH_FINE_DISTANCE_M,
                        onRoad=state.get("onRoad"))
        return False

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
    pose = odometry_to_pose(robot.odometry())
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
    state = robot.road_state()
    for _ in range(APPROACH_FINE_MAX_STEPS):
        if abs(distance_m - GRAB_STANDOFF_M) <= 0.005:
            fine_reason = "at_grab_standoff"
            break
        bearing = _wm_bearing_deg(pose) or 0.0
        if abs(bearing) > APPROACH_FINE_REAIM_DEG:
            _turn_toward_bearing(bearing)
        odo_before = float((robot.odometry() or {}).get("distanceCm") or 0.0)
        step_cm = min(APPROACH_FINE_STEP_CM, abs(distance_m - GRAB_STANDOFF_M) * 100.0)
        if step_cm < 0.5:
            fine_reason = "at_grab_standoff"
            break
        backing = distance_m < GRAB_STANDOFF_M
        if backing:
            robot.backward(round(step_cm, 1))
        else:
            robot.forward(round(step_cm, 1))
        odo_after = float((robot.odometry() or {}).get("distanceCm") or 0.0)
        moved = odo_after - odo_before if odo_after >= odo_before else 0.0
        STATE["forward_after_last_observe_cm"] += -moved if backing else moved
        state = robot.road_state()
        pose = odometry_to_pose(robot.odometry())
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
        pose = odometry_to_pose(robot.odometry())
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
        approach_ok = bool(robot.approach("目标物", 85, 1))
    except Exception as error:
        _approach_event("approach_failed", reason="approach_exception", error=str(error))
        return False
    if _approach_on_road("after_approach") is None:
        return False
    pose = odometry_to_pose(robot.odometry())
    _approach_event("approach_result", approach_call=STATE["approach_calls"], reached=approach_ok,
                    wm_distance_m=round(_wm_distance_m(pose) or 0.0, 3),
                    wm_bearing_deg=round(_wm_bearing_deg(pose) or 0.0, 1),
                    pose=_pose_log(pose))

    # v27 抓取闭环：grab → holding()，未抓到则直行 GRAB_STEP_CM，累计前进 <= GRAB_MAX_ADVANCE_CM。
    # 窗口前向 4.75–16.9cm（深 12cm），6cm 步长保证至少两次落在窗口内；每步检查 onRoad；不 observe。
    advanced_cm = 0.0
    max_grabs = int(GRAB_MAX_ADVANCE_CM // GRAB_STEP_CM) + 1
    for grab_no in range(1, max_grabs + 1):
        robot.grab()
        holding = robot.holding()
        odo = robot.odometry() or {}
        pose = odometry_to_pose(odo)
        state = robot.road_state()
        wm_d = _wm_distance_m(pose)
        _approach_event("grab_step", step=grab_no, advanced_cm=round(advanced_cm, 1), holding=holding,
                        tick=odo.get("tick"), wm_distance_m=round(wm_d, 3) if wm_d is not None else None,
                        onRoad=state.get("onRoad"), pose=_pose_log(pose))
        if holding == "目标物":
            forward_cm = STATE["forward_after_last_observe_cm"]
            metric_passed = forward_cm >= MEMORY_FORWARD_MIN_CM
            print("GY " + json.dumps({
                "event": "memory_navigation_metric",
                "passed": bool(metric_passed),
                "last_observe_distance_m": round(STATE["last_observe_distance_m"] or 0.0, 3),
                "last_observe_camera_distance_cm": STATE["last_observe_camera_distance_cm"],
                "forward_after_last_observe_cm": round(forward_cm, 1),
                "required_forward_cm": MEMORY_FORWARD_MIN_CM,
                "approach_calls": STATE["approach_calls"],
                "grab_attempts": grab_no,
                "grab_advanced_cm": round(advanced_cm, 1),
                "observe_count": STATE["observe_count"],
                "onRoad": state.get("onRoad"),
            }, ensure_ascii=False))
            return bool(metric_passed)
        if holding is not None:
            _approach_event("grab_loop_failed", reason="holding_wrong_object", holding=holding, step=grab_no)
            return False
        if grab_no == max_grabs:
            break
        odo_before = float(odo.get("distanceCm") or 0.0)
        robot.forward(GRAB_STEP_CM)
        odo_after = float((robot.odometry() or {}).get("distanceCm") or 0.0)
        moved = odo_after - odo_before if odo_after >= odo_before else 0.0
        advanced_cm += moved
        STATE["forward_after_last_observe_cm"] += moved
        state = robot.road_state()
        if not state.get("onRoad"):
            _approach_event("grab_loop_failed", reason="off_road", step=grab_no, advanced_cm=round(advanced_cm, 1),
                            lateralOffsetCm=state.get("lateralOffsetCm"))
            return False
        if moved < GRAB_STEP_CM * 0.5:
            _approach_event("grab_step_blocked", step=grab_no, movedCm=round(moved, 1), advanced_cm=round(advanced_cm, 1))
    _approach_event("grab_loop_failed", reason="max_advance_reached", grabs=max_grabs,
                    advanced_cm=round(advanced_cm, 1), max_advance_cm=GRAB_MAX_ADVANCE_CM,
                    approach_calls=STATE["approach_calls"])
    return False


def _finish_flow(success, stage, reason=None):
    state = robot.task_state()
    print("GY " + json.dumps({
        "event": "flow_end", "success": bool(success), "stage": stage, "reason": reason,
        "one_target_released": bool(success),
        "full_targetDelivered": bool(state.get("targetDelivered")), "holding": robot.holding(),
    }, ensure_ascii=False))
    print("GY_DONE")


def run_target_flow():
    # 可预期的任务失败用结构化结果结束；意外异常仍由平台记录 program_error。
    target = patrol_until_target_seen(max_obs=PATROL_OBSERVE_BUDGET)
    if target is None:
        _finish_flow(False, "confirmation", "WorldModel 未通过 observe() 确认目标物")
        return
    if not approach_target_with_world_model(target):
        _finish_flow(False, "grab", "按 WorldModel 位置接近并抓取目标物失败")
        return
    DELIVERY_LOG["on"] = True
    _delivery_event("delivery_phase_start", holding=robot.holding())
    if not release_target_at_storage():
        _finish_flow(False, "delivery", "未找到可确认的目标物存放姿态")
        return
    released_ok = robot.holding() is None
    _finish_flow(released_ok, "delivery", None if released_ok else "释放后仍持有目标物")


try:
    run_target_flow()
except MissionFailure as failure:
    _finish_flow(False, "constraint", str(failure))
