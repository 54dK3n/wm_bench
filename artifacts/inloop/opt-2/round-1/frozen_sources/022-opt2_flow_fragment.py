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
