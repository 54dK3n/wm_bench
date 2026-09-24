"""Use the existing road-limited cruise speed for memory travel and later patrol.

The confirmation planner and the final fine drive keep their original speed.
No new distance, speed or timing threshold is introduced.
"""

# The platform nests the whole source inside __student_main__. Mutate this
# shared enclosing dictionary; a global declaration would bypass that scope.
OPT2_MOTION_STATE = {"memory_travel_active": False}


def _opt2_memory_navigation(target):
    previous = OPT2_MOTION_STATE["memory_travel_active"]
    OPT2_MOTION_STATE["memory_travel_active"] = True
    try:
        return _approach_graph_navigation(target)
    finally:
        OPT2_MOTION_STATE["memory_travel_active"] = previous


def _opt2_patrol_follow(distance, original_speed):
    speed = CRUISE_SPEED if DEMO_STATE["ball_index"] > 1 else original_speed
    return _vp_follow(distance, speed)


def _opt2_patrol_enter(road_id):
    previous = OPT2_MOTION_STATE["memory_travel_active"]
    OPT2_MOTION_STATE["memory_travel_active"] = DEMO_STATE["ball_index"] > 1
    try:
        return _vp_enter(road_id)
    finally:
        OPT2_MOTION_STATE["memory_travel_active"] = previous
