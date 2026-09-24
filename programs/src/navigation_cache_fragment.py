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
