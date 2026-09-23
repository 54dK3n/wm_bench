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


def road_blocked(road_id, reason="front_clearance"):
    """构造带 road_id 的 RuntimeError，避免 Pyodide 下自定义异常构造异常。"""
    error = RuntimeError(f"{reason}:{road_id}")
    error.road_id = road_id
    error.reason = reason
    return error

CRUISE_SPEED = 100  # 由道路控制逐 tick 自动钳制到当前道路/限速区的安全上限。
SLOW_SPEED = 30
NODE_NUDGE_CM = 2

mission = robot.mission()
graph = robot.map_graph()
mission_objects = [item for item in mission.get("objects", []) if isinstance(item, dict)]
target_anchors = [item for item in mission_objects if item.get("role") == "target"]
distractor_anchors = [item for item in mission_objects if item.get("role") == "distractor"]
obstacle_anchors = [item for item in mission_objects if item.get("role") == "obstacle"]
if not target_anchors or not distractor_anchors or not obstacle_anchors:
    raise RuntimeError("本程序需要普通单局的任务道路锚点；私有五局不会提供它们")

edge_by_road = {edge["roadId"]: edge for edge in graph["edges"]}
adj = {node["nodeId"]: [] for node in graph["nodes"]}
for edge in graph["edges"]:
    adj[edge["fromNodeId"]].append((edge["toNodeId"], edge["roadId"], edge["lengthCm"]))
    if not edge["oneWay"]:
        adj[edge["toNodeId"]].append((edge["fromNodeId"], edge["roadId"], edge["lengthCm"]))

# 避开障碍物所在道路。是否绕行、选哪条替代路，仍由 Dijkstra 自己决定。
blocked_roads = {item["roadId"] for item in obstacle_anchors}
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
                print("GY_STAGE front_exhausted", state.get("roadId"))
                raise road_blocked(state.get("roadId"), "front_clearance_retry_exhausted")
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
            blocked_roads.add(road_id)
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
            blocked_roads.add(road_id)
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
            blocked_roads.add(road_id)
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


start_node = robot.road_state()["nodeId"]
ranked_targets = []
for index, anchor in enumerate(target_anchors):
    ranked_targets.append((anchor_path_cm(anchor, start_node), index))
ranked_targets.sort(key=lambda item: (item[0], item[1]))
if not ranked_targets or ranked_targets[0][0] == float("inf"):
    raise RuntimeError("没有可达的目标物道路锚点")
first_target = "target#{}".format(ranked_targets[0][1])
print("GY " + json.dumps({"first_target": first_target}, ensure_ascii=False))

# 2. 交付所有 target；每次投放都重新用 release_preview 闭环确认。
remaining_targets = list(ranked_targets)
while remaining_targets and not robot.task_state()["targetDelivered"]:
    progressed = False
    for item in list(remaining_targets):
        print("GY_STAGE target_try", item[1])
        anchor = target_anchors[item[1]]
        try:
            print("GY_STAGE target_scan_start")
            try:
                scan_and_grab("target", anchor)
            except Exception:
                print("GY_TRACEBACK_TARGET_START")
                print(traceback.format_exc())
                print("GY_TRACEBACK_TARGET_END")
                raise
            print("GY_STAGE target_scan_done")
            print("GY_STAGE target_release_start")
            release_target_at_storage()
            print("GY_STAGE target_release_done")
            remaining_targets.remove(item)
            progressed = True
            break
        except RuntimeError:
            if robot.holding() == "目标物":
                try:
                    release_target_at_storage()
                    remaining_targets.remove(item)
                    progressed = True
                    break
                except RuntimeError:
                    pass
            remaining_targets.remove(item)
            continue
    if not progressed:
        break

# 3. 清理所有 distractor。
print("GY_STAGE distractor_loop_start")
for distractor_anchor in distractor_anchors:
    if robot.task_state()["distractorCleared"]:
        break
    try:
        print("GY_STAGE distractor_scan_start")
        scan_and_grab("distractor", distractor_anchor)
        print("GY_STAGE distractor_scan_done")
        print("GY_STAGE distractor_clear_start")
        clear_distractor(distractor_anchor)
        print("GY_STAGE distractor_clear_done")
    except RuntimeError:
        if robot.holding() == "混淆物":
            try:
                clear_distractor(distractor_anchor)
                break
            except RuntimeError:
                pass

# 4. 只前往任务引擎尚未确认的下一个途径点。
checkpoints_by_id = {checkpoint["id"]: checkpoint for checkpoint in mission["checkpoints"]}
while True:
    next_checkpoint = robot.task_state()["nextCheckpointId"]
    print("GY_STAGE checkpoint_next", next_checkpoint)
    if next_checkpoint is None:
        break
    if next_checkpoint not in checkpoints_by_id:
        raise RuntimeError("服务端返回了未知途径点：" + next_checkpoint)
    print("GY_STAGE checkpoint_start", next_checkpoint)
    pass_checkpoint(checkpoints_by_id[next_checkpoint])
    print("GY_STAGE checkpoint_done", next_checkpoint)

# 5. 回到服务端冻结的停车锚点，并用真实任务状态确认完成。
go_to_anchor(mission["return"])
state = robot.task_state()
if not state["completed"] or state["completed"] != state["total"]:
    raise RuntimeError("返航后任务尚未完成：" + str(state))
print("任务完成：", state)
print("导航里程（cm）：", robot.odometry()["distanceCm"])
print("GY_DONE")
