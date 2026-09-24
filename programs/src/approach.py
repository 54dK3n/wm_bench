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
