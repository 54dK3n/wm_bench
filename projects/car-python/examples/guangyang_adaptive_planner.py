# 广阳岛全图自适应感知与规划示例
#
# 仅使用公开 robot API：map_graph / road_state / follow_road / take_exit /
# observe / approach / grab / release / holding / odometry，以及基础转向、前后移动。
# 搜索候选完全来自 map_graph()，不保存任何目标物、混淆物或障碍物的
# 私有位置/候选道路。下方少量固定道路只描述公开任务语义，绑定公开地图
# Guangyang Island 2026.08-source-png-3d.3：存放点、四个检查点、停车区、
# 公开安全清理直路和公开慢速区。

# 车辆最高速度为 31.25 cm/s；40% 即 12.5 cm/s，
# 对公开最低常规道路限速 13.75 cm/s 保留余量。
# parking 与 east-outer 的公开慢速区域另降到30%。
CRUISE_SPEED = 40
PRECISE_SPEED = 30
JUNCTION_NUDGE_CM = 2
SCAN_STEP_CM = 150
TRANSIT_STEP_CM = 500
RADAR_LIMIT_CM = 260
# 七向15°扫描在最坏公开拓扑上会逼近/超过1000次导航查询，故采用
# -40°..+40°的五向20°扫描；每段只读净空，不生成摄像头帧。
# 按公开 roads/bounds、5.5cm 车体半径和 150cm 采样复核，world-bounds 仅在
# southwest-spur产生2次、southeast-spur产生1次误门控，最多额外9帧；
# 公开默认布局保守总视觉预算36帧，低于实测约64帧/20MiB容量。
RADAR_ANGLES = (-40, -20, 0, 20, 40)

STORAGE_ROAD = "nw-bag"
CLEANUP_ROAD = "west-middle"
PARKING_ROAD = "parking-connector"
SLOW_ROADS = {PARKING_ROAD, "east-outer-south"}
CHECKPOINT_ROADS = ("central-north", "bailu-south", "oil-west-arc", "camp-connector")

graph = robot.map_graph()
edges = graph["edges"]

edge_by_road = {}
adj = {}
for node_record in graph["nodes"]:
    adj[node_record["nodeId"]] = []
for edge_record in edges:
    road_id = edge_record["roadId"]
    edge_by_road[road_id] = edge_record
    adj[edge_record["fromNodeId"]].append(
        (edge_record["toNodeId"], road_id, edge_record["lengthCm"])
    )
    if not edge_record["oneWay"]:
        adj[edge_record["toNodeId"]].append(
            (edge_record["fromNodeId"], road_id, edge_record["lengthCm"])
        )

required_public_roads = {STORAGE_ROAD, CLEANUP_ROAD, PARKING_ROAD}
required_public_roads.update(CHECKPOINT_ROADS)
if not required_public_roads.issubset(set(edge_by_road)):
    raise RuntimeError("本示例需要公开广阳岛 2026.08 路网")

hard_blocked = set()
soft_blocked = set()
cleared_roads = set()
uncertain_roads = set()
known_road = {}
nav = {"node": None, "road": None}


def speed_for_road(road_id):
    # east-outer-south 穿过公开 10 cm/s 慢速区，parking 本身限速约 9.375 cm/s。
    if road_id in SLOW_ROADS:
        return PRECISE_SPEED
    return CRUISE_SPEED


def other_end(road_id, node_id):
    edge = edge_by_road[road_id]
    if edge["fromNodeId"] == node_id:
        return edge["toNodeId"]
    return edge["fromNodeId"]


def junction_end(road_id):
    edge = edge_by_road[road_id]
    left = edge["fromNodeId"]
    right = edge["toNodeId"]
    if len(adj[left]) >= len(adj[right]):
        return left
    return right


def forbidden_roads(extra_forbidden=None):
    result = set(hard_blocked)
    result.update(soft_blocked)
    if extra_forbidden is not None:
        result.add(extra_forbidden)
    return result


def shortest_route(start, goal, extra_forbidden=None):
    """按 map_graph.lengthCm 计算 Dijkstra 路线，返回(道路列表, 厘米)。"""
    forbidden = forbidden_roads(extra_forbidden)
    distances = {start: 0}
    previous_node = {}
    previous_road = {}
    visited = set()

    while True:
        current = None
        current_distance = None
        for node_id, distance in distances.items():
            if node_id in visited:
                continue
            if current is None or distance < current_distance:
                current = node_id
                current_distance = distance
        if current is None or current == goal:
            break
        visited.add(current)

        for next_node, road_id, length_cm in adj[current]:
            if road_id in forbidden:
                continue
            candidate = current_distance + length_cm
            if next_node not in distances or candidate < distances[next_node]:
                distances[next_node] = candidate
                previous_node[next_node] = current
                previous_road[next_node] = road_id

    if goal not in distances:
        return None

    roads = []
    node_id = goal
    while node_id != start:
        roads.append(previous_road[node_id])
        node_id = previous_node[node_id]
    roads.reverse()
    return roads, distances[goal]


def candidate_entries(edge):
    if edge["oneWay"]:
        return [edge["fromNodeId"]]
    return [edge["fromNodeId"], edge["toNodeId"]]


def plan_candidate(role, searched):
    """选择到入口加完整扫描代价最小的下一条未搜索道路。"""
    preferred = known_road.get(role)
    candidates = []
    if preferred is not None:
        candidates.append(preferred)
    candidates.extend(edge["roadId"] for edge in edges if edge["roadId"] != preferred)

    best = None
    for road_id in candidates:
        if road_id in searched or road_id in hard_blocked:
            continue
        if role == "distractor" and road_id in cleared_roads:
            continue
        edge = edge_by_road[road_id]
        for endpoint in candidate_entries(edge):
            route = shortest_route(nav["node"], endpoint, road_id)
            if route is None:
                continue
            path, path_cm = route
            # 每条候选路最终都必须完整扫描，因此比较“抵达入口”的
            # Dijkstra 加权距离；死胡同另计一次不可避免的返程代价。
            score = path_cm
            destination = other_end(road_id, endpoint)
            if len(adj[destination]) == 1:
                score += edge["lengthCm"]
            preferred_rank = 0 if road_id == preferred else 1
            choice = (preferred_rank, score, road_id, endpoint, path)
            if best is None or choice < best:
                best = choice
    if best is None:
        return None
    return {"roadId": best[2], "endpoint": best[3]}


def visible_task_objects():
    # 每张图同时分类；只保留近距离、稳定的三类任务物体。
    found = []
    for item in robot.observe(None, 0.6):
        category = item.get("category")
        distance = item.get("distanceCm")
        if (
            category in ("target", "distractor", "obstacle")
            and item.get("stable")
            and distance is not None
            and distance <= 260
        ):
            found.append(item)
    return found


def clearance_radar():
    """五向读取前方净空，恢复道路航向后返回260cm内的最近命中。"""
    hits = []
    robot.right_angle(40)
    for index, angle in enumerate(RADAR_ANGLES):
        state = robot.road_state()
        clearance = state.get("frontClearanceCm")
        if clearance is not None and clearance <= RADAR_LIMIT_CM:
            hits.append((clearance, angle))
        if index + 1 < len(RADAR_ANGLES):
            robot.left_angle(20)
    robot.right_angle(40)
    if not hits:
        return None
    hits.sort()
    return {"clearanceCm": hits[0][0], "angle": hits[0][1]}


def mark_scan_angle(item, angle):
    if item is not None:
        item["_scanAngle"] = angle
    return item


def restore_scan_heading(item):
    if item is None:
        return
    angle = item.get("_scanAngle", 0)
    if angle > 0:
        robot.right_angle(angle)
    elif angle < 0:
        robot.left_angle(-angle)
    item["_scanAngle"] = 0


def scan_front_object(wanted=None, first_view=None):
    """正前、左45、右45三视角按每类每视角最高置信度投票。"""
    views = []
    initial = first_view if first_view is not None else visible_task_objects()
    for item in initial:
        views.append((item, 0))

    robot.left_angle(45)
    for item in visible_task_objects():
        views.append((item, 45))
    robot.right_angle(90)
    for item in visible_task_objects():
        views.append((item, -45))

    if not views:
        robot.left_angle(45)
        return None

    by_category = {"target": [], "distractor": [], "obstacle": []}
    per_view_score = {"target": {}, "distractor": {}, "obstacle": {}}
    for item, angle in views:
        category = item["category"]
        by_category[category].append((item, angle))
        old = per_view_score[category].get(angle, 0)
        per_view_score[category][angle] = max(old, item.get("confidence", 0))

    scores = {}
    for category in by_category:
        scores[category] = sum(per_view_score[category].values())

    object_category = "target"
    if scores["distractor"] > scores["target"]:
        object_category = "distractor"
    object_score = scores[object_category]
    # 黄黑障碍与包裹分数接近时保守封路，不尝试穿越。
    if by_category["obstacle"] and scores["obstacle"] >= object_score - 0.10:
        winning_category = "obstacle"
    elif object_score > 0:
        winning_category = object_category
    else:
        winning_category = "obstacle"

    choices = by_category[winning_category]
    if not choices:
        robot.left_angle(45)
        return None
    choices.sort(key=lambda pair: pair[0]["distanceCm"])
    selected, selected_angle = choices[0]

    # 扫描结束时车头在道路方向右侧45°；恢复到选中物体对应的视角。
    if selected_angle == 0:
        robot.left_angle(45)
    elif selected_angle == 45:
        robot.left_angle(90)
    return mark_scan_angle(selected, selected_angle)


def scan_storage_zone():
    zones = robot.observe("存放点", 0.45)
    if zones:
        return mark_scan_angle(zones[0], 0)
    robot.left_angle(45)
    zones = robot.observe("存放点", 0.45)
    if zones:
        return mark_scan_angle(zones[0], 45)
    robot.right_angle(90)
    zones = robot.observe("存放点", 0.45)
    if zones:
        return mark_scan_angle(zones[0], -45)
    robot.left_angle(45)
    return None


def align_storage_zone(zone):
    scan_angle = zone.get("_scanAngle", 0)
    for _ in range(12):
        direction = zone.get("direction")
        if direction == "左":
            robot.left_angle(5)
            scan_angle += 5
        elif direction == "右":
            robot.right_angle(5)
            scan_angle -= 5
        else:
            zone["_scanAngle"] = scan_angle
            return zone
        zones = robot.observe("存放点", 0.45)
        if not zones:
            return None
        zone = zones[0]
    zone["_scanAngle"] = scan_angle
    return zone


def settle_junction(expected_node):
    state = robot.road_state()
    if state["atJunction"] and state["junctionId"] == expected_node:
        return True
    # follow_road 偶尔停在 junctionRadius 浮点边界外；只做一次10%低速、
    # 0.08秒（约2cm）前探，然后必须重新读取 road_state，不能盲目循环。
    if not state["onRoad"]:
        return False
    robot.forward(JUNCTION_NUDGE_CM)
    state = robot.road_state()
    return state["atJunction"] and state["junctionId"] == expected_node


def enter_road_from_node(road_id):
    """同时支持普通路口和度为1的叶端进入道路。"""
    state = robot.road_state()
    if state["atJunction"]:
        result = robot.take_exit(road_id)
        return result["accepted"] and result["stoppedBy"] == "entered_road"

    node_id = nav["node"]
    if node_id is None or len(adj[node_id]) != 1 or adj[node_id][0][1] != road_id:
        return False
    robot.left_angle(180)
    result = robot.follow_road(10, speed_for_road(road_id))
    return result["accepted"] and result["stoppedBy"] in ("max_distance", "road_end")


def return_to_node(origin_node):
    state = robot.road_state()
    if state["atJunction"] and state["junctionId"] == origin_node:
        nav["node"] = origin_node
        nav["road"] = state["roadId"]
        return True

    robot.left_angle(180)
    for _ in range(12):
        road_id = state["roadId"] if state.get("roadId") else nav["road"]
        result = robot.follow_road(TRANSIT_STEP_CM, speed_for_road(road_id))
        reason = result["stoppedBy"]
        if reason == "junction":
            if not settle_junction(origin_node):
                return False
            nav["node"] = origin_node
            nav["road"] = result["roadId"]
            return True
        if reason == "road_end":
            if len(adj[origin_node]) == 1 and adj[origin_node][0][1] == result["roadId"]:
                nav["node"] = origin_node
                nav["road"] = result["roadId"]
                return True
            return False
        if reason != "max_distance":
            return False
        state = robot.road_state()
    return False


def process_task_object(item, wanted, road_id, origin_node):
    category = item["category"]
    if category == "obstacle":
        restore_scan_heading(item)
        hard_blocked.add(road_id)
        known_road["obstacle"] = road_id
        print("识别障碍物，封闭道路：", road_id)
        if not return_to_node(origin_node):
            return "failed"
        return "blocked"

    known_road[category] = road_id
    if category != wanted:
        restore_scan_heading(item)
        soft_blocked.add(road_id)
        print("发现稍后处理的", item["categoryLabel"], "道路：", road_id)
        if not return_to_node(origin_node):
            return "failed"
        return "blocked"

    label = "目标物" if category == "target" else "混淆物"
    robot.grab()
    if robot.holding() != label:
        robot.approach(label, 80, 40)
        robot.grab()
    if robot.holding() != label:
        restore_scan_heading(item)
        return_to_node(origin_node)
        return "failed"

    restore_scan_heading(item)
    soft_blocked.discard(road_id)
    print("已抓取", label, "道路：", road_id)
    if not return_to_node(origin_node):
        return "failed"
    return "found"


def cross_road(road_id, destination_node, wanted=None, scan_during_travel=False):
    """返回 arrived / searched / found / blocked / failed。"""
    origin_node = nav["node"]
    if not enter_road_from_node(road_id):
        return "failed"
    nav["road"] = road_id

    # 搜索道路每段先做五向净空扫描；只有局部碰撞体进入260cm时才启用视觉。
    for _ in range(30):
        if scan_during_travel:
            radar_hit = clearance_radar()
            if radar_hit is not None:
                uncertain_roads.add(road_id)
                item = scan_front_object(wanted)
                if item is not None:
                    return process_task_object(item, wanted, road_id, origin_node)

        step_cm = SCAN_STEP_CM if scan_during_travel else TRANSIT_STEP_CM
        result = robot.follow_road(step_cm, speed_for_road(road_id))
        reason = result["stoppedBy"]

        if reason == "junction":
            if not settle_junction(destination_node):
                return "failed"
            nav["node"] = destination_node
            return "arrived"
        if reason == "road_end":
            if scan_during_travel:
                if not return_to_node(origin_node):
                    return "failed"
                return "searched"
            nav["node"] = destination_node
            return "arrived"
        if reason == "max_distance":
            continue
        if reason != "front_clearance":
            return "failed"

        item = scan_front_object(wanted)
        if wanted is not None and (item is None or item["category"] != wanted):
            # 极近物体可能被相机裁切；先回正并沿已走安全路段后退约75cm。
            restore_scan_heading(item)
            robot.backward(75)
            retry_item = scan_front_object(wanted)
            if retry_item is not None:
                item = retry_item
        if item is None:
            hard_blocked.add(road_id)
            if not return_to_node(origin_node):
                return "failed"
            return "blocked"
        return process_task_object(item, wanted, road_id, origin_node)
    return "failed"


def navigate_to_node(goal_node, wanted=None, extra_forbidden=None):
    for _ in range(30):
        if nav["node"] == goal_node:
            return "arrived"
        route = shortest_route(nav["node"], goal_node, extra_forbidden)
        if route is None:
            return "failed"
        path, _distance_cm = route
        replanning = False
        for road_id in path:
            destination = other_end(road_id, nav["node"])
            outcome = cross_road(road_id, destination, wanted, False)
            if outcome == "found":
                return "found"
            if outcome == "failed":
                return "failed"
            if outcome == "blocked":
                replanning = True
                break
            if outcome != "arrived":
                return "failed"
        if not replanning and nav["node"] == goal_node:
            return "arrived"
    return "failed"


def search_for(role):
    searched = set()
    while len(searched) < len(edges):
        plan = plan_candidate(role, searched)
        if plan is None:
            return False
        road_id = plan["roadId"]
        endpoint = plan["endpoint"]
        soft_blocked.discard(road_id)

        outcome = navigate_to_node(endpoint, role, road_id)
        if outcome == "found":
            return True
        if outcome != "arrived":
            return False

        destination = other_end(road_id, nav["node"])
        outcome = cross_road(road_id, destination, role, True)
        if outcome == "found":
            return True
        if outcome == "failed":
            return False

        searched.add(road_id)
        if outcome in ("arrived", "searched") and road_id not in uncertain_roads:
            cleared_roads.add(road_id)
    return False


def deliver_target():
    junction_node = junction_end(STORAGE_ROAD)
    if navigate_to_node(junction_node, None, STORAGE_ROAD) != "arrived":
        return False
    if not enter_road_from_node(STORAGE_ROAD):
        return False
    nav["road"] = STORAGE_ROAD

    at_storage_end = False
    for _ in range(4):
        result = robot.follow_road(TRANSIT_STEP_CM, speed_for_road(STORAGE_ROAD))
        if result["stoppedBy"] == "road_end":
            at_storage_end = True
            break
        if result["stoppedBy"] != "max_distance":
            return False
    if not at_storage_end:
        return False

    robot.left_angle(180)
    zone = scan_storage_zone()
    if zone is None:
        return False
    zone = align_storage_zone(zone)
    if zone is None:
        return False

    # 公开几何验收：后退约 7.5cm 后，13.75cm 的夹爪投影落点位于
    # 半径 11.875cm 的存放区内。
    robot.backward(7.5)
    robot.release()
    if robot.holding() is not None:
        return False
    restore_scan_heading(zone)

    for _ in range(4):
        result = robot.follow_road(TRANSIT_STEP_CM, speed_for_road(STORAGE_ROAD))
        if result["stoppedBy"] == "junction":
            if not settle_junction(junction_node):
                return False
            nav["node"] = junction_node
            nav["road"] = STORAGE_ROAD
            return True
        if result["stoppedBy"] != "max_distance":
            return False
    return False


def remove_distractor():
    # west-middle 是公开地图上的长直叶路；从其路口深入180cm后横向投放，
    # 可避开其他道路端部覆盖区，同时让车体始终保留在本路内。
    junction_node = junction_end(CLEANUP_ROAD)
    if navigate_to_node(junction_node, None, CLEANUP_ROAD) != "arrived":
        return False
    if not enter_road_from_node(CLEANUP_ROAD):
        return False
    nav["road"] = CLEANUP_ROAD

    result = robot.follow_road(180, speed_for_road(CLEANUP_ROAD))
    if result["stoppedBy"] != "max_distance":
        return False
    state = robot.road_state()
    if not state["onRoad"] or state["roadId"] != CLEANUP_ROAD:
        return False

    left = state["leftClearanceCm"]
    right = state["rightClearanceCm"]
    if left >= right:
        side = "left"
        travel_cm = max(20, left - 2)
        robot.left_angle(90)
    else:
        side = "right"
        travel_cm = max(20, right - 2)
        robot.right_angle(90)

    robot.forward(travel_cm)
    robot.release()
    released = robot.holding() is None
    robot.backward(travel_cm)
    if side == "left":
        robot.right_angle(90)
    else:
        robot.left_angle(90)
    if not released:
        return False
    return return_to_node(junction_node)


def best_endpoint_for_road(road_id):
    edge = edge_by_road[road_id]
    best = None
    for endpoint in candidate_entries(edge):
        route = shortest_route(nav["node"], endpoint, road_id)
        if route is None:
            continue
        _path, distance_cm = route
        choice = (distance_cm, endpoint)
        if best is None or choice < best:
            best = choice
    if best is None:
        return None
    return best[1]


def traverse_checkpoint_road(road_id):
    endpoint = best_endpoint_for_road(road_id)
    if endpoint is None:
        return False
    if navigate_to_node(endpoint, None, road_id) != "arrived":
        return False
    destination = other_end(road_id, nav["node"])
    return cross_road(road_id, destination, None, False) == "arrived"


# 1. 从停车区叶端驶入路网。
initial = robot.follow_road(TRANSIT_STEP_CM, speed_for_road(PARKING_ROAD))
if initial["stoppedBy"] != "junction":
    raise RuntimeError("无法从停车区进入道路网络")
state = robot.road_state()
if not state["atJunction"]:
    robot.forward(JUNCTION_NUDGE_CM)
    state = robot.road_state()
if not state["atJunction"]:
    raise RuntimeError("停车区入口拓扑状态无效")
nav["node"] = state["junctionId"]
nav["road"] = state["roadId"]

# 2. 从 map_graph 全部道路中自适应寻找目标物并入库存放点。
if not search_for("target"):
    raise RuntimeError("全图搜索后仍未找到目标物")
if not deliver_target():
    raise RuntimeError("目标物未能安全送入存放点")

# 3. 已完整确认无物体的道路直接跳过，搜索并清理混淆物。
if not search_for("distractor"):
    raise RuntimeError("全图搜索后仍未找到混淆物")
if not remove_distractor():
    raise RuntimeError("混淆物道路外移除失败")

# 4. 按公开任务顺序巡检四个检查点。
if not traverse_checkpoint_road(CHECKPOINT_ROADS[0]):
    raise RuntimeError("检查点1路线失败")

bailu_node = edge_by_road[CHECKPOINT_ROADS[1]]["fromNodeId"]
if navigate_to_node(bailu_node) != "arrived":
    raise RuntimeError("检查点2路线失败")

if not traverse_checkpoint_road(CHECKPOINT_ROADS[2]):
    raise RuntimeError("检查点3路线失败")

camp_node = edge_by_road[CHECKPOINT_ROADS[3]]["fromNodeId"]
if navigate_to_node(camp_node) != "arrived":
    raise RuntimeError("检查点4路线失败")

# 5. 返回公开停车区叶端。
parking_junction = junction_end(PARKING_ROAD)
if navigate_to_node(parking_junction, None, PARKING_ROAD) != "arrived":
    raise RuntimeError("无法返回停车区入口")
parking_end = other_end(PARKING_ROAD, parking_junction)
if cross_road(PARKING_ROAD, parking_end, None, False) != "arrived":
    raise RuntimeError("无法驶入停车终点")

print("广阳岛全图自适应规划完成")
print("已确认空道路数：", len(cleared_roads))
print("累计里程：", robot.odometry()["distanceCm"], "cm")
