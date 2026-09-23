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
