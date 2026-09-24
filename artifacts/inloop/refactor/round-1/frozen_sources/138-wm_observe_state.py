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



def _observe_motion(odo=None):
    odo = odo if odo is not None else nav_odometry()
    last = STATE.get("last_observe_pose")
    current = [float(odo.get("rightCm", 0.0)), float(odo.get("forwardCm", 0.0)),
               float(odo.get("headingDeg", 0.0))]
    if last is None:
        return True, current, None, None
    moved = math.hypot(current[0] - last[0], current[1] - last[1])
    turned = abs(_wrap_deg(current[2] - last[2]))
    return moved >= OBS_MIN_TRANSLATION_CM or turned >= OBS_MIN_TURN_DEG, current, moved, turned
