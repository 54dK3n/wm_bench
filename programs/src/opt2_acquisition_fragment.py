"""Expire unsupported planning goals using real new frames and existing WM decay.

An out-of-window or capped red observation is not a missed detection. It remains
planning-only. The WorldModel's fusion, confidence parameters and hit rules are
unchanged; this bridge supplies previously omitted empty-frame updates.
"""


def _opt2_has_red(observations):
    # Explicit iteration remains valid after the platform makes helpers async.
    for item in observations:
        if _is_target(item):
            return True
    return False


def _opt2_clear_lost_selection(track_id):
    STATE["confirmation_track_id"] = None
    STATE["accepted_hits"] = []
    STATE["frame_track_ids"] = {key: value for key, value in STATE["frame_track_ids"].items()
                                if value != track_id}
    STATE["last_observed_world"] = None
    for name in ("explored", "failed", "nudged", "travel_attempts"):
        VP_STATE[name] = set()
    VP_STATE["travel_active"] = None
    DEMO_STATE["selection_snapshot"] = None
    _demo_event("target_search_abandoned", previous_track_id=track_id,
                reason="existing_WM_decay_archived_selected_track",
                wm_history_preserved=True)


def _opt2_update_observations(observations, pose, timestamp, memory_phase=True):
    _update_wm(observations, pose, timestamp, memory_phase=memory_phase)
    # A red reading outside the accepted distance window is still positive
    # visual evidence. Do not turn it into an invented miss by range clipping.
    if not _opt2_has_red(observations):
        before = [{"id": obj.obj_id, "state": obj.state.value,
                   "hit": obj.hit_count, "conf": obj.confidence}
                  for obj in wm.get_scene()]
        if before:
            wm.update([], pose, now=timestamp)
            after = [{"id": obj.obj_id, "state": obj.state.value,
                      "hit": obj.hit_count, "conf": obj.confidence}
                     for obj in (wm.get_object(item["id"]) for item in before)
                     if obj is not None]
            _demo_event("wm_empty_frame_update", before=before, after=after,
                        reason="new_frame_has_no_eligible_red_existing_decay_only")
    selected_id = STATE.get("confirmation_track_id")
    selected = wm.get_object(selected_id) if selected_id is not None else None
    if selected_id is not None and (selected is None or selected.state == ObjectState.LOST):
        _opt2_clear_lost_selection(selected_id)


def _opt2_planning_evidence_expired(goal, observations):
    """Only called after an actual observe, never during geometry-only replans."""
    track_id = goal.get("track_id")
    if track_id is not None:
        target = wm.get_object(track_id)
        expired = target is None or target.state == ObjectState.LOST
        reason = "selected_WM_track_lost"
    else:
        expired = (goal.get("source") == "capped_bearing_only"
                   and not _opt2_has_red(observations))
        reason = "capped_bearing_not_seen_in_new_frame"
    if expired:
        STATE["planning_goal_abandoned"] = True
        _demo_event("range_entry_abandoned", goal_source=goal.get("source"),
                    previous_track_id=track_id, reason=reason)
    return expired


def _opt2_confirmation_should_abort():
    # Another real track can have appeared in the frame that retired the old
    # lock. Let patrol continue with that WM memory, not label it a failed track.
    if STATE.pop("planning_goal_abandoned", False):
        return False
    return _wm_target() is not None
