# 测距标定采集程序（不是任务程序，不抓球、不送货）。
#
# 只用公开接口：mission / map_graph / road_state / odometry / follow_road /
# take_exit / left_angle / right_angle / observe。依次驶向每个红球（目标物）和
# 蓝球（混淆物）的道路锚点（道路两端各来一次）；进入最后约 190cm 路程后改为 10cm 小步循路，
# observe 前静置 0.12s。每个站点：
#   1) 沿路朝向 observe 一次；
#   2) 若看到 36~100cm 的红/蓝球，原地转向做方位扫描（0 / ±16 / ±30 度，按站点交替符号），
#      每个朝向 observe 一次，然后按里程计航向转回原朝向。
# 每次 observe 打印一行 calib_obs：tick（observe 前后）、里程计位姿、所有红/蓝球读数
# （distanceCm / bearingDeg / category）。真值由 driver 按 tick 从 record.samples 取。
# 评分不作数。视觉证据账本保持开启（关闭后页面在 ~30 次 observe 后冻结），observe 总数限 85。

import json

PROGRAM_VERSION = "calib-range-v6-20260923"
print("GY " + json.dumps({"event": "program_version", "version": PROGRAM_VERSION}, ensure_ascii=False))

CRUISE_SPEED = 100
SLOW_SPEED = 30
NODE_NUDGE_CM = 2
STEP_CM = 10
STEP_MODE_REMAINING_CM = 190
STATION_LIMIT = 14
SWEEP_MIN_CM = 36
SWEEP_MAX_CM = 97
ANCHOR_STOP_CM = 14  # 在锚点道路上距锚点进度 <= 14cm 即停（不看读数：地图纹理会产生近距伪蓝球）
SETTLE_S = 0.12  # observe 前静置，保证 samples 中相邻 tick 的位姿与相机帧一致
BALL_CATEGORIES = ("target", "distractor")
OBSERVE_BUDGET = 85  # 视觉证据账本 20MiB ≈ 92 帧；留余量
TICK_BUDGET = 14000  # 280 s 仿真时间后停止采集（时限 600 s）

mission = robot.mission()
graph = robot.map_graph()
mission_objects = [item for item in mission.get("objects", []) if isinstance(item, dict)]
ball_anchors = [item for item in mission_objects if item.get("role") in BALL_CATEGORIES]
obstacle_anchors = [item for item in mission_objects if item.get("role") == "obstacle"]

edge_by_road = {edge["roadId"]: edge for edge in graph["edges"]}
adj = {node["nodeId"]: [] for node in graph["nodes"]}
for edge in graph["edges"]:
    adj[edge["fromNodeId"]].append((edge["toNodeId"], edge["roadId"], edge["lengthCm"]))
    if not edge["oneWay"]:
        adj[edge["toNodeId"]].append((edge["fromNodeId"], edge["roadId"], edge["lengthCm"]))
blocked_roads = {item["roadId"] for item in obstacle_anchors}
# 球本身也停在路上：整边行驶被 front_clearance 挡停的道路记入此集合，之后规划绕开
dynamic_blocked = set()
obstacle_progress_by_road = {}
for item in obstacle_anchors:
    obstacle_progress_by_road.setdefault(item["roadId"], []).append(float(item.get("progressCm", 0.0)))

COUNTER = {"observe": 0, "station": 0}


def emit(event, **fields):
    payload = {"event": event}
    payload.update(fields)
    print("GY " + json.dumps(payload, ensure_ascii=False))


def calib_observe(tag, anchor_index):
    if COUNTER["observe"] >= OBSERVE_BUDGET:
        raise RuntimeError("observe budget reached")
    robot.wait(SETTLE_S)
    before = robot.odometry()
    observations = robot.observe(None, 0.3)
    after = robot.odometry()
    COUNTER["observe"] += 1
    dets = []
    for item in observations or []:
        category = str(item.get("category") or "").strip().lower()
        if category not in BALL_CATEGORIES:
            continue
        dets.append({"category": category, "distanceCm": item.get("distanceCm"),
                     "bearingDeg": item.get("bearingDeg"), "confidence": item.get("confidence")})
    emit("calib_obs", n=COUNTER["observe"], station=COUNTER["station"], anchor=anchor_index, tag=tag,
         tick=before.get("tick"), tickAfter=after.get("tick"),
         odo=[before.get("rightCm"), before.get("forwardCm"), before.get("headingDeg")],
         odoAfter=[after.get("rightCm"), after.get("forwardCm"), after.get("headingDeg")],
         dets=dets)
    return dets


def turn_right(deg):
    if deg > 0.5:
        robot.right_angle(deg)
    elif deg < -0.5:
        robot.left_angle(-deg)


def restore_heading(heading_deg):
    # 平台 headingDeg 左转为正：当前比目标大 → 需要右转。
    delta = ((float(robot.odometry()["headingDeg"]) - heading_deg) + 180.0) % 360.0 - 180.0
    turn_right(delta)


def station(anchor_index, role):
    """一个站点：基准观测 + 方位扫描；返回该类别最近读数（无则 None）。"""
    COUNTER["station"] += 1
    base_heading = float(robot.odometry()["headingDeg"])
    dets = calib_observe("base", anchor_index)
    in_range = [d for d in dets if d["distanceCm"] is not None and SWEEP_MIN_CM <= d["distanceCm"] <= SWEEP_MAX_CM]
    own = [d for d in dets if d["category"] == role and d["distanceCm"] is not None]
    nearest_own = min((d["distanceCm"] for d in own), default=None)
    if in_range:
        focus = min(in_range, key=lambda d: (d["category"] != role, d["distanceCm"]))
        sign = 1.0 if COUNTER["station"] % 2 == 0 else -1.0
        bearing = float(focus["bearingDeg"] or 0.0)
        for wanted in (0.0, 16.0 * sign, 30.0 * sign):
            if abs(bearing - wanted) < 5.0:
                continue
            turn_right(bearing - wanted)
            sweep = calib_observe("sweep_%+d" % int(wanted), anchor_index)
            match = [d for d in sweep if d["category"] == focus["category"] and d["bearingDeg"] is not None]
            if not match:
                break
            bearing = float(min(match, key=lambda d: abs(float(d["distanceCm"] or 999) - focus["distanceCm"]))["bearingDeg"])
        restore_heading(base_heading)
    return nearest_own


# ---- 道路图导航（与任务程序同口径，去掉送货日志） ----

def dijkstra(start_node, goal_node, extra_blocked=None):
    forbidden = set(blocked_roads) | dynamic_blocked
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
    state = robot.road_state()
    if not state["onRoad"]:
        return
    error = state["headingErrorDeg"]
    if error > 1:
        robot.left_angle(error)
    elif error < -1:
        robot.right_angle(-error)


def node_state():
    for attempt in range(6):
        state = robot.road_state()
        if state["atNode"]:
            return state
        align_to_current_road()
        result = robot.follow_road(500, CRUISE_SPEED, True)
        emit("calib_nav", stage="node_state", attempt=attempt, roadId=state.get("roadId"), stoppedBy=result.get("stoppedBy"))
        if result["stoppedBy"] == "front_clearance":
            robot.left_angle(180)
            continue
        state = robot.road_state()
        if state["atNode"]:
            return state
        if result["stoppedBy"] in ("junction", "road_end"):
            robot.forward(NODE_NUDGE_CM)
    raise RuntimeError("无法从道路状态确认图节点")


def endpoint_choice(anchor, start_node, exclude=()):
    road_id = anchor["roadId"]
    edge = edge_by_road[road_id]
    progress = float(anchor.get("progressCm", 0.0))
    ends = [edge["fromNodeId"]] if edge["oneWay"] else [edge["fromNodeId"], edge["toNodeId"]]
    best = None
    for endpoint in ends:
        if endpoint in exclude:
            continue
        crosses = any((endpoint == edge["fromNodeId"] and p < progress) or (endpoint == edge["toNodeId"] and p > progress)
                      for p in obstacle_progress_by_road.get(road_id, []))
        if crosses:
            continue
        route = dijkstra(start_node, endpoint, {road_id})
        if route is None:
            continue
        partial = progress if endpoint == edge["fromNodeId"] else float(edge["lengthCm"]) - progress
        candidate = (route[1] + partial, endpoint, partial)
        if best is None or candidate < best:
            best = candidate
    return best


def step_along(road_id):
    """在当前道路上前进一小步；到节点返回 'node'，被挡返回 'blocked'。"""
    align_to_current_road()
    result = robot.follow_road(STEP_CM, SLOW_SPEED, True)
    stopped = result.get("stoppedBy")
    if stopped == "front_clearance":
        return "blocked"
    if stopped in ("junction", "road_end"):
        state = robot.road_state()
        if not state["atNode"]:
            robot.forward(NODE_NUDGE_CM)
        return "node"
    if stopped != "max_distance":
        return "blocked"
    return "moved"


def visit_anchor(anchor_index, anchor, exclude=()):
    role = anchor["role"]
    road_id = anchor["roadId"]
    start = node_state()
    choice = endpoint_choice(anchor, start["nodeId"], exclude)
    if choice is None:
        emit("calib_anchor_skipped", anchor=anchor_index, reason="no_route", exclude=list(exclude))
        return None
    _, endpoint, _ = choice
    emit("calib_anchor_start", anchor=anchor_index, role=role, roadId=road_id, endpoint=endpoint,
         remainingCm=round(choice[0], 1))
    stations = 0
    # 1) 整边行驶，直到剩余路程进入步进范围
    for _ in range(40):
        state = node_state()
        node = state["nodeId"]
        if node == endpoint:
            break
        plan = dijkstra(node, endpoint, {road_id})
        if plan is None or not plan[0]:
            break
        if plan[1] + choice[2] <= STEP_MODE_REMAINING_CM:
            break
        entered = robot.take_exit(plan[0][0], CRUISE_SPEED, True)
        if not entered.get("accepted"):
            emit("calib_anchor_skipped", anchor=anchor_index, reason="take_exit_rejected")
            return endpoint
        crossed = robot.follow_road(500, CRUISE_SPEED, True)
        emit("calib_nav", stage="cross", roadId=plan[0][0], stoppedBy=crossed.get("stoppedBy"))
        if crossed.get("stoppedBy") == "front_clearance":
            dynamic_blocked.add(plan[0][0])
            robot.left_angle(180)
    # 2) 步进 + 站点
    for _ in range(30):
        if stations >= STATION_LIMIT:
            break
        station(anchor_index, role)
        stations += 1
        state = robot.road_state()
        progress = state.get("roadProgressCm")
        if state.get("roadId") == road_id and progress is not None \
                and abs(float(progress) - float(anchor.get("progressCm", 0.0))) <= ANCHOR_STOP_CM:
            break
        if state["atNode"]:
            node = state["nodeId"]
            if node == endpoint:
                next_road = road_id
            else:
                plan = dijkstra(node, endpoint, {road_id})
                if plan is None or not plan[0]:
                    break
                next_road = plan[0][0]
            legal = {item["roadId"] for item in state.get("exits", [])}
            if next_road not in legal:
                emit("calib_anchor_stop", anchor=anchor_index, reason="exit_not_legal", roadId=next_road)
                break
            entered = robot.take_exit(next_road, SLOW_SPEED, True)
            if not entered.get("accepted"):
                break
            continue
        outcome = step_along(state["roadId"])
        if outcome == "blocked":
            station(anchor_index, role)
            break
    emit("calib_anchor_done", anchor=anchor_index, stations=stations, observes=COUNTER["observe"])
    # 掉头离开球，避免下一段 node_state 顶到它
    robot.left_angle(180)
    return endpoint


def anchor_order():
    remaining = list(range(len(ball_anchors)))
    order = []
    current = node_state()["nodeId"]
    while remaining:
        best = None
        for index in remaining:
            choice = endpoint_choice(ball_anchors[index], current)
            cost = choice[0] if choice else float("inf")
            if best is None or cost < best[0]:
                best = (cost, index, choice)
        order.append(best[1])
        remaining.remove(best[1])
        if best[2] is not None:
            current = best[2][1]
    return order


emit("calib_plan", anchors=[{"role": a["role"], "roadId": a["roadId"], "progressCm": a.get("progressCm")}
                            for a in ball_anchors])
for index in anchor_order():
    used = []
    for _pass in range(2):
        if int(robot.odometry().get("tick") or 0) > TICK_BUDGET or COUNTER["observe"] >= OBSERVE_BUDGET:
            break
        try:
            endpoint = visit_anchor(index, ball_anchors[index], tuple(used))
        except Exception as error:
            emit("calib_anchor_error", anchor=index, error=str(error)[:200])
            try:
                robot.left_angle(180)
            except Exception:
                pass
            break
        if endpoint is None:
            break
        used.append(endpoint)
emit("calib_end", observes=COUNTER["observe"], stations=COUNTER["station"])
print("GY_DONE")
