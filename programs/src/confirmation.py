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
