"""Bounded public-sensor viewpoint acquisition for explore(discovery_id).

This controller never promotes an object itself. It asks the unchanged
Perception/WorldModel for actual independent hits after every legal movement.
"""
from __future__ import annotations

import copy
import math

from .navigation import distance, position, wrap, normalize_minimum_translation_cm
from .perception import RANGE_CAL

VERSION = "brain-confirmation-sampling/v7"
MAX_STEPS = 12
MAX_TRAVEL_CM = 120
SAMPLING_LENGTHS_CM = (15.5, 16., 17., 18., 20., 10.)


def _reading(point, xy, heading):
    """Project an observed estimate; never use it as an admission verdict."""
    dx, dz = (point['x']-xy[0])*100, (point['z']-xy[1])*100
    theta = math.radians(heading)
    right = math.cos(theta)*dx + math.sin(theta)*dz
    forward = -math.sin(theta)*dx + math.cos(theta)*dz - RANGE_CAL['L_cm']
    if forward <= 0:
        return None
    beta = math.atan2(right, forward)
    raw = (math.hypot(right, forward)-RANGE_CAL['a_cm'])*math.cos(beta)/RANGE_CAL['k']
    return raw, math.degrees(beta)


def _registered_basic_step_verified(a, b, motion):
    """A complete indexed basic command, including a nonzero legal translation."""
    from .actions import basic_motion_evidence
    from .road_evidence import RoadEvidence
    if (not isinstance(motion, dict) or motion.get('outcome_unknown')
            or motion.get('motion_not_sent') or not motion.get('bridge_request_id')
            or b['observation_index'] != a['observation_index'] + 1
            or motion.get('before_observation') != a['observation_index']
            or motion.get('after_observation') != b['observation_index']
            or not RoadEvidence.sensor_valid(a) or not RoadEvidence.sensor_valid(b)):
        return False
    method, result, params = motion.get('method'), motion.get('actuator_result'), motion.get('params', {})
    if (method not in {'forward', 'backward', 'turn'} or not isinstance(result, dict)
            or not isinstance(params, dict)
            or result.get('completed') is not True or result.get('accepted') is False
            or result.get('error') or result.get('stoppedBy') not in {None, 'completed'}):
        return False
    parameter = params.get('angleDeg' if method == 'turn' else 'distanceCm')
    speed = params.get('speed', 30)
    if (type(parameter) not in (int, float) or not math.isfinite(parameter)
            or set(params) - ({'angleDeg', 'speed'} if method == 'turn' else {'distanceCm', 'speed'})
            or type(speed) not in (int, float) or not math.isfinite(speed) or not 10 <= speed <= 100
            or (not 1 <= abs(parameter) <= 180 if method == 'turn' else not .1 <= parameter <= 500)):
        return False
    before, after = a['odometry'], b['odometry']
    travel = after['distanceCm'] - before['distanceCm']
    elapsed = after['tick'] - before['tick']
    if (any(type(frame['odometry']['tick']) is not int for frame in (a, b))
            or 'elapsedTicks' in result and (type(result['elapsedTicks']) is not int or result['elapsedTicks'] != elapsed)
            or 'tick' in result and (type(result['tick']) is not int or result['tick'] != after['tick'])
            or 'distanceCm' in result and (type(result['distanceCm']) not in (int, float)
                or not math.isfinite(result['distanceCm']) or abs(result['distanceCm'] - travel) > .2)):
        return False
    verified = basic_motion_evidence(method, params, a, b)
    if (not verified['motion_verified'] or verified['holding_changed'] or verified['road_changed']
            or a['holding']['holding'] is not b['holding']['holding']
            or after['tick'] <= before['tick']):
        return False
    if method == 'turn':
        return travel == 0 and position(before) == position(after)
    return (normalize_minimum_translation_cm(travel) >= .1
            and normalize_minimum_translation_cm(verified['measured_cm']) >= .1
            and verified['along_cm'] > 0
            and abs(travel - verified['measured_cm']) <= .2
            and abs(travel - parameter) <= .2)


def _observed_motion_window(actions, first, snapshot, *, allow_localized_stop=False):
    """Read a complete registered window; absent motion is only stationary.

    A navigation cue may retain a strictly localized clearance-stop prefix as
    pose continuity. That prefix does not authorize straight backtracking,
    view restoration, passage clearance, or completion of an exit.
    """
    from .road_evidence import RoadEvidence
    getter = getattr(actions.r.roads, 'observation_records', None)
    last = snapshot.get('observation_index')
    if not callable(getter) or type(first) is not int or type(last) is not int or first > last:
        return None
    window = getter(first, last)
    if not isinstance(window, dict) or window.get('invalid_observation_indices'):
        return None
    frames, motions = window.get('observations', []), window.get('motions', [])
    if [f.get('observation_index') for f in frames] != list(range(first, last + 1)):
        return None
    if (not frames or any(not RoadEvidence.sensor_valid(f) for f in frames)
            or any(frames[-1].get(k) != snapshot.get(k) for k in ('odometry', 'road'))
            or any(frames[-1]['observation'].get(k) != snapshot.get('observation', {}).get(k)
                   for k in ('frameId', 'tick'))):
        return None
    by_pair = {}
    for motion in motions:
        pair = (motion.get('before_observation'), motion.get('after_observation'))
        if pair in by_pair or motion.get('outcome_unknown'):
            return None
        by_pair[pair] = motion
    expected_pairs = {(a['observation_index'], b['observation_index']) for a, b in zip(frames, frames[1:])}
    if set(by_pair) - expected_pairs:
        return None
    for a, b in zip(frames, frames[1:]):
        motion = by_pair.get((a['observation_index'], b['observation_index']))
        travel = b['odometry']['distanceCm'] - a['odometry']['distanceCm']
        minimum_roundoff = (travel < .1 and normalize_minimum_translation_cm(travel) == .1
                            and _registered_basic_step_verified(a, b, motion))
        if (not RoadEvidence.step_valid(a, b, motion) and not minimum_roundoff
                and not (allow_localized_stop
                         and RoadEvidence.clearance_stop_localized(a, b, motion))):
            return None
        if (motion is not None and motion['method'] == 'turn'
                and abs(b['odometry']['distanceCm'] - a['odometry']['distanceCm']) > .2):
            return None  # A stationary heading change cannot account for extra travel.
    return frames, by_pair


def _recorded_translation_support(actions, length, method, snapshot=None):
    """Cover a straight requested path with a continuous actual motion suffix.

    Every segment and intervening observation is checked. Backtracking may
    revisit the same interval, but never increases its covered extent. No
    distance sum, proximity bridge, unseen node crossing or curved shortcut.
    """
    from .actions import road_translation_limit
    getter = getattr(actions.r.roads, 'road_segment_records', None)
    if (not callable(getter) or method not in {'forward', 'backward'}
            or type(length) not in (int, float) or not math.isfinite(length)
            or not .2 <= length <= MAX_TRAVEL_CM):
        return None
    snapshot = actions.s if snapshot is None else snapshot
    odo = snapshot['odometry']
    p = position(odo)
    theta = math.radians(odo['headingDeg'])
    sign = 1 if method == 'forward' else -1
    unit = (-sign * math.sin(theta), sign * math.cos(theta))
    q = (p[0] + length / 100 * unit[0], p[1] + length / 100 * unit[1])
    permitted, clearance = road_translation_limit(snapshot['road'], method, length)
    if permitted + 1e-9 < length:
        return None

    def coordinates(point):
        dx, dz = (point[0] - p[0]) * 100, (point[1] - p[1]) * 100
        return dx * unit[0] + dz * unit[1], dx * unit[1] - dz * unit[0]

    segments = sorted(getter(), key=lambda s: s['after_observation'])
    selected, intervals = [], []
    cursor, end_index = p, snapshot['observation_index']
    for segment in reversed(segments):
        a, b = segment['departure'], segment['arrival']
        start, end = a['position_m'], b['position_m']
        chord = distance(start, end) * 100
        x, lateral_a = coordinates(start)
        y, lateral_b = coordinates(end)
        if (segment['after_observation'] > end_index or distance(end, cursor) > .002
                or (normalize_minimum_translation_cm(chord) < .1
                    if segment['method'] in {'forward', 'backward'} else chord < .2)
                or abs(chord - segment['travelled_cm']) > .2
                or max(abs(lateral_a), abs(lateral_b)) > .2
                or abs(wrap(a['travel_heading_deg'] - b['travel_heading_deg'])) > .2
                or min(abs(wrap(b['travel_heading_deg'] - odo['headingDeg'])),
                       abs(wrap(b['travel_heading_deg'] - odo['headingDeg'] - 180))) > .2):
            return None
        selected.insert(0, segment)
        intervals.append((min(x, y), max(x, y)))
        cursor, end_index = start, segment['before_observation']
        # Union actual collinear intervals, without counting repeated travel.
        covered = 0.
        for left, right in sorted(intervals):
            if left > covered + 1e-7:
                break
            covered = max(covered, right)
        if covered + 1e-7 < length:
            continue
        window = _observed_motion_window(actions, selected[0]['before_observation'], snapshot)
        if window is None:
            return None
        frames, motions = window
        selected_pairs = {(s['before_observation'], s['after_observation']): s for s in selected}
        for pair, motion in motions.items():
            if motion['method'] == 'turn':
                # Turns can bridge registered stationary frames, never a kink
                # within a translated interval; current axis still must agree.
                continue
            saved = selected_pairs.get(pair)
            if saved is None or saved['motion'] != motion:
                return None
        for frame in frames:
            along, across = coordinates(position(frame['odometry']))
            if (abs(across) > .2 or frame['road'].get('atNode')
                    and .2 < along < length - .2):
                return None
        return {'schema': 'brain-recorded-translation-support/v1',
                'method': method, 'requested_cm': length, 'body_heading_deg': odo['headingDeg'],
                'segment_id': selected[0]['segment_id'],
                'segment_ids': [s['segment_id'] for s in selected],
                'continuation_segment_ids': [s['segment_id'] for s in selected[1:]],
                'segments': copy.deepcopy(selected),
                'before_observation': selected[0]['before_observation'],
                'after_observation': selected[0]['after_observation'],
                'last_motion_observation': selected[-1]['after_observation'],
                'current_observation_index': snapshot['observation_index'],
                'observation_refs': [{'observation_index': f['observation_index'],
                    'frame_id': str(f['observation']['frameId']), 'tick': f['observation']['tick']}
                    for f in frames],
                'motion_refs': [{'before_observation': a, 'after_observation': b,
                    'method': motion['method']} for (a, b), motion in sorted(motions.items())],
                'covered_intervals_cm': [list(i) for i in sorted(intervals)],
                'position_m': list(p), 'planned_position_m': list(q),
                'road_clearance': clearance}
    return None


def observed_basic_return_support(actions):
    """One empty-gripper retreat along a complete witnessed straight suffix.

    The returned endpoint was actually observed. Its predicted approach never
    inserts a graph edge; only the dispatched command and fresh result can do
    that. Curved roads, stopped prefixes and gripper transitions are excluded.
    """
    from .road_evidence import RoadEvidence
    snapshot = actions.s
    if (snapshot.get('holding', {}).get('holding') is not False
            or getattr(actions.r, 'held_object_id', None) is not None
            or getattr(actions.r, 'pending_grasp', None) is not None
            or not RoadEvidence.sensor_valid(snapshot) or snapshot['road'].get('atNode') is not False):
        return None
    getter = getattr(actions.r.roads, 'road_segment_records', None)
    if not callable(getter):
        return None
    here, heading = position(snapshot['odometry']), snapshot['odometry']['headingDeg']
    theta = math.radians(heading)
    unit = (math.sin(theta), -math.cos(theta))
    candidates = {}
    for segment in getter():
        if segment.get('method') not in {'forward', 'backward'}:
            continue
        endpoint = tuple(segment['departure']['position_m'])
        dx, dz = (endpoint[0] - here[0]) * 100, (endpoint[1] - here[1]) * 100
        along, across = dx * unit[0] + dz * unit[1], dx * unit[1] - dz * unit[0]
        if .2 <= along <= 20 and abs(across) <= .2:
            candidates[endpoint] = along
    for endpoint, length in sorted(candidates.items(), key=lambda row: -row[1]):
        support = _recorded_translation_support(actions, length, 'backward')
        if (support is None or tuple(support['segments'][0]['departure']['position_m']) != endpoint
                or any(s['method'] not in {'forward', 'backward'} for s in support['segments'])):
            continue
        window = _observed_motion_window(actions, support['before_observation'], snapshot)
        if window is None:
            continue
        frames, motions = window
        if (any(f.get('holding', {}).get('holding') is not False
                or f['road'].get('atNode') is not False for f in frames)
                or any(not _registered_basic_step_verified(a, b, motions[(a['observation_index'], b['observation_index'])])
                       for a, b in zip(frames, frames[1:])
                       if (a['observation_index'], b['observation_index']) in motions)):
            continue
        heading_back = wrap(heading + 180)
        if (actions.r.roads.passage_blocked(snapshot, heading_back) is not None
                or actions.r.roads._blocked_passage_at(endpoint, heading_back, False) is not None):
            continue
        return {'schema': 'brain-recorded-basic-return/v1', 'method': 'backward',
                'params': {'distanceCm': length, 'speed': 30},
                'current_observation': snapshot['observation_index'],
                'current_position_m': list(here), 'body_heading_deg': heading,
                'target_position_m': list(endpoint), 'target_observation': support['before_observation'],
                'holding': False, 'max_travel_cm': length, 'straight_suffix': support,
                'predicted_endpoint_gap_cm': distance(support['planned_position_m'], endpoint) * 100,
                'graph_connection_predicted': False, 'blocked_passages_resolved': False}
    return None


def _reverse_support(actions, length, snapshot=None):
    """Backward-compatible entry point for recorded backward translations."""
    return _recorded_translation_support(actions, length, 'backward', snapshot)


def _constraint_interval_lengths(target, snapshot, remaining, method):
    """Suggest interior lengths where the existing geometric guards can change.

    These are only extra candidates within the existing sampling length range.
    Road and observed reverse-path checks still run in _translation_choices;
    sampling retains its sensor and identity checks. Prediction earns no hit.
    """
    from .actions import road_translation_limit
    low, high = min(SAMPLING_LENGTHS_CM), min(max(SAMPLING_LENGTHS_CM), remaining)
    high, _ = road_translation_limit(snapshot['road'], method, high)
    if high <= low:
        return []
    odo = snapshot['odometry']
    here, theta = position(odo), math.radians(odo['headingDeg'])
    sign = 1 if method == 'forward' else -1
    unit = (-sign * math.sin(theta), sign * math.cos(theta))
    point = target['current_detection']['position_m']
    dx, dz = (point['x'] - here[0]) * 100, (point['z'] - here[1]) * 100
    right = math.cos(theta) * dx + math.sin(theta) * dz
    forward = -math.sin(theta) * dx + math.cos(theta) * dz - RANGE_CAL['L_cm']
    boundaries = {low, high}

    def boundary(length):
        if math.isfinite(length) and low < length < high:
            boundaries.add(length)

    # Translating on the body axis leaves camera-right unchanged. In the
    # admitted positive-range window, raw range increases monotonically with
    # camera-forward. Bisect that projection without changing its calibration.
    for raw in (42., 87.):
        left, right_forward = 0., RANGE_CAL['a_cm'] + RANGE_CAL['k'] * raw
        for _ in range(48):
            middle = (left + right_forward) / 2
            radius = math.hypot(right, middle)
            predicted = (radius - RANGE_CAL['a_cm']) * middle / radius / RANGE_CAL['k']
            if predicted < raw:
                left = middle
            else:
                right_forward = middle
        boundary(sign * (forward - (left + right_forward) / 2))
    boundary(sign * (forward - abs(right) / math.tan(math.radians(33))))
    boundary(16.)  # The existing far-cue probe bound changes here.
    radius = (target['confirmation']['min_hit_pose_gap_m'] + .002) * 100
    for pose in target['confirmation']['accepted_hit_poses']:
        vx, vz = (here[0] - pose['x_m']) * 100, (here[1] - pose['z_m']) * 100
        along = vx * unit[0] + vz * unit[1]
        discriminant = along * along - (vx * vx + vz * vz - radius * radius)
        if discriminant >= 0:
            offset = math.sqrt(discriminant)
            boundary(-along - offset)
            boundary(-along + offset)
    ordered = sorted(boundaries)
    return [((a + b) / 2, (a, b)) for a, b in zip(ordered, ordered[1:]) if b - a > 1e-7]


def _translation_choices(actions, target, snapshot, remaining, rejections, *, short_probe=False,
                         constraint_intervals=False):
    """Evaluate only bounded translations; hypothetical poses never earn hits."""
    from .actions import road_translation_limit
    road,odo=snapshot['road'],snapshot['odometry']
    det=target['current_detection']
    poses=target['confirmation']['accepted_hit_poses']
    gap=target['confirmation']['min_hit_pose_gap_m']
    here=position(odo);heading=odo['headingDeg']
    def reject(reason):
        rejections[reason]=rejections.get(reason,0)+1

    choices=[]
    for method in (('forward',) if short_probe else ('forward','backward')):
        intervals = dict(_constraint_interval_lengths(target, snapshot, remaining, method)) if constraint_intervals else {}
        lengths = intervals if constraint_intervals else ((4.,) if short_probe else SAMPLING_LENGTHS_CM)
        for length in lengths:
            if length>remaining:
                reject('remaining_action_travel_budget');continue
            sign=1 if method=='forward' else -1
            theta=math.radians(heading)
            end=(here[0]-sign*length/100*math.sin(theta),here[1]+sign*length/100*math.cos(theta))
            predicted=_reading(det['position_m'],end,heading)
            if predicted is None or abs(predicted[1])>33:
                reject('target_would_leave_view');continue
            clipped=det['raw_distance_cm']==100
            # A clipped estimate is only a lower-bound search cue. Take a
            # bounded forward probe; it does not count as a confirmation hit.
            approaching_far=(det['raw_distance_cm']>=90 and method=='forward'
                             and predicted[0]>42 and length<=16)
            if not (42<=predicted[0]<=87 or approaching_far):
                reject('target_would_leave_confirmation_window');continue
            independent=all(distance(end,(p['x_m'],p['z_m']))>=gap+.002 for p in poses)
            if not independent and not approaching_far and not short_probe:
                reject('insufficient_separation_from_accepted_hit_poses');continue
            support=None
            if method=='backward':
                support=_reverse_support(actions,length,snapshot)
                if support is None:
                    reject('reverse_path_not_continuously_observed');continue
            permitted,clearance=road_translation_limit(road,method,length)
            if permitted+1e-9<length:
                reject('insufficient_local_road_clearance');continue
            # Road following handles curvature away from junctions. At an
            # observed node use the uniquely sensed exit direction and a
            # bounded basic step, avoiding take_exit's unbounded endpoint.
            motor=method
            if (method=='forward' and not road.get('atNode')
                    and abs(road['headingErrorDeg'])<1):motor='follow_road'
            if method=='forward' and road.get('atNode'):
                aligned=[e for e in road.get('exits',[]) if abs(e['angleDeg'])<1]
                if len(aligned)!=1:
                    reject('aligned_exit_not_unique');continue
            choices.append((not independent,approaching_far,method=='backward',length,
                {'method':motor,'params':{'distanceCm':length,'speed':30 if motor!='follow_road' else 50},
                 'planned_position_m':list(end),'predicted_raw_distance_cm':predicted[0],
                 'predicted_raw_bearing_deg':predicted[1],'range_is_lower_bound':clipped,
                 'independent_pose_predicted':independent,'road_clearance':clearance,
                 **({'short_sampling_probe':True,'confirmation_hit_expected':False} if short_probe else {}),
                 'reverse_path_support':support,
                 **({'distance_constraint_interval_cm':list(intervals[length])} if constraint_intervals else {}),
                 'basis':'public_target_estimate_local_road_and_accepted_hit_poses'}))
    if not choices and not short_probe and not constraint_intervals:
        return _translation_choices(actions, target, snapshot, remaining, rejections,
                                    constraint_intervals=True)
    return choices


def _plan(actions, target, remaining, rejections, failed_viewpoints=(), comparison_out=None,
          *, allow_short_probe=True):
    """Compare present translations with observed turns plus a next viewpoint.

    A turn is useful only if its camera projection preserves the range and
    bearing margins and a subsequent independent translation is feasible.
    That next translation is advisory: fresh sensors must replan after turning.
    """
    current_rejections={}
    direct=_translation_choices(actions,target,actions.s,remaining,current_rejections)
    comparison={'schema':'brain-viewpoint-comparison/v1',
                'current_translation_count':len(direct),
                'current_rejections':current_rejections,'turns':[]}
    choices=[((0,*score[:4]),score[-1]) for score in direct]
    road,odo=actions.s['road'],actions.s['odometry']
    if road.get('atNode'):
        angles=[e.get('angleDeg') for e in road.get('exits',[])]
        angles=[a for a in angles if type(a) in (int,float) and math.isfinite(a) and abs(a)<=35]
    else:
        angles=[road.get('headingErrorDeg')]
    angles=sorted({a for a in angles if type(a) in (int,float)
                   and math.isfinite(a) and 1<=abs(a)<=180},key=lambda a:(abs(a),a))[:6]
    det=target['current_detection']
    for angle in angles:
        row={'angle_deg':angle,'rejections':{}}
        comparison['turns'].append(row)
        projected=copy.deepcopy(actions.s)
        projected['odometry']['headingDeg']=wrap(odo['headingDeg']+angle)
        reading=_reading(det['position_m'],position(odo),projected['odometry']['headingDeg'])
        if reading is not None:
            row.update(predicted_raw_distance_cm=reading[0],predicted_raw_bearing_deg=reading[1])
        if reading is None or abs(reading[1])>33:
            row['rejections']['turn_target_would_leave_view']=1
            continue
        far_probe=det['raw_distance_cm']>=90 and reading[0]>=42
        if not (42<=reading[0]<=87 or far_probe):
            row['rejections']['turn_target_would_leave_confirmation_window']=1
            continue
        error=road.get('headingErrorDeg')
        if type(error) in (int,float) and math.isfinite(error):
            projected['road']['headingErrorDeg']=wrap(error-angle)
        projected['road']['exits']=[{**e,'angleDeg':wrap(e['angleDeg']-angle)}
                                   for e in road.get('exits',[])
                                   if type(e.get('angleDeg')) in (int,float) and math.isfinite(e['angleDeg'])]
        successors=_translation_choices(actions,target,projected,remaining,row['rejections'])
        row['next_translation_count']=len(successors)
        row['reverse_path_preserved']=any(c[-1]['reverse_path_support'] for c in successors)
        if not successors:
            row['rejections']['turn_has_no_safe_next_viewpoint']=1
            continue
        next_choice=min(successors,key=lambda c:c[:4])
        plan={'method':'turn','params':{'angleDeg':angle,'speed':50},
              'predicted_raw_distance_cm':reading[0],'predicted_raw_bearing_deg':reading[1],
              'next_independent_viewpoint':next_choice[-1],
              'next_viewpoint_requires_fresh_observation':True,
              'basis':'observed_road_turn_preserving_raw_window_with_next_viewpoint'}
        choices.append(((1,*next_choice[:4],abs(angle)),plan))
    for reasons in [current_rejections]+[t['rejections'] for t in comparison['turns']]:
        for reason,count in reasons.items():rejections[reason]=rejections.get(reason,0)+count
    usable=[]
    for score,plan in choices:
        repeated=any(distance(position(odo),f['position_m'])<=.002
                     and abs(wrap(odo['headingDeg']-f['heading_deg']))<=.2
                     and plan['method']==f['method']
                     and all(abs(plan['params'][k]-f['params'][k])<=.2
                             for k in ('angleDeg', 'distanceCm') if k in plan['params'])
                     for f in failed_viewpoints)
        if repeated:
            rejections['same_action_viewpoint_already_lost']=rejections.get('same_action_viewpoint_already_lost',0)+1
        else:usable.append((score,plan))
    # A junction's side clearance can rule out every independent-sized step
    # while still permitting a small forward sensor probe. Use the unchanged
    # road bound and reobserve after each probe; a short move never earns a hit
    # or claims that the next independent pose is reachable. This fallback is
    # only for an unconfirmed target and a real local-clearance rejection.
    obj=target.get('associated_object') or {}
    if (not usable and allow_short_probe and road.get('atNode') is True
            and current_rejections.get('insufficient_local_road_clearance',0)>0
            and obj.get('state')=='TENTATIVE' and obj.get('ever_confirmed') is False
            and not target.get('identity_resolution_required')
            and actions.s.get('holding',{}).get('holding') is False):
        probes=_translation_choices(actions,target,actions.s,remaining,rejections,short_probe=True)
        for score in probes:
            plan=score[-1]
            if not any(distance(position(odo),f['position_m'])<=.002
                       and abs(wrap(odo['headingDeg']-f['heading_deg']))<=.2
                       and f['method']==plan['method'] and f['params']==plan['params']
                       for f in failed_viewpoints):
                usable.append(((2,*score[:4]),plan))
        comparison['short_probe_count']=len(probes)
    if comparison_out is not None:comparison_out.update(copy.deepcopy(comparison))
    if not usable:return None
    chosen=min(usable,key=lambda c:c[0])[1]
    chosen['viewpoint_comparison']=comparison
    return chosen


def _restore_plan(actions, before, target, entry, remaining):
    """One action-local return to a witnessed view, never an unseen search."""
    from .actions import road_translation_limit
    after=actions.s
    det=target.get('current_detection')
    if (not det or not 40<=det['raw_distance_cm']<90 or abs(det['raw_bearing_deg'])>35
            or str(det.get('frame_id'))!=str(before.get('observation',{}).get('frameId'))
            or not before['road'].get('onRoad') or not after['road'].get('onRoad')):
        return None,'previous_unique_admitted_view_unavailable'
    observed=_observed_motion_window(actions,before['observation_index'],after)
    if observed is None:return None,'restore_previous_motion_not_verified'
    _,motions=observed
    motion=motions.get((before['observation_index'],after['observation_index']))
    if (len(motions)!=1 or motion is None or motion['method']!=entry['method']
            or motion.get('params')!=entry.get('params')
            or entry.get('before_observation')!=before['observation_index']
            or entry.get('after_observation')!=after['observation_index']):
        return None,'restore_previous_motion_reference_mismatch'
    p,q=position(before['odometry']),position(after['odometry'])
    old_heading=before['odometry']['headingDeg']
    heading=after['odometry']['headingDeg']
    predicted=_reading(det['position_m'],p,old_heading)
    if predicted is None or not 40<=predicted[0]<90 or abs(predicted[1])>35:
        return None,'previous_view_no_longer_in_original_window'
    plan={'phase':'restore_previous_view',
          'restore_source_observation':before['observation_index'],
          'planned_position_m':list(p),'planned_heading_deg':old_heading,
          'predicted_raw_distance_cm':predicted[0],'predicted_raw_bearing_deg':predicted[1],
          'basis':'same_action_last_unique_view_and_recorded_motion'}
    if entry['method']=='turn':
        if distance(p,q)>.002:return None,'turn_changed_position'
        angle=wrap(old_heading-heading)
        if abs(angle)<1:return None,'restore_turn_below_legal_minimum'
        plan.update(method='turn',params={'angleDeg':angle,'speed':50})
    elif entry['method'] in {'forward','follow_road','backward'}:
        length=distance(p,q)*100
        if length<.2 or length>remaining:return None,'restore_outside_remaining_travel_budget'
        inverse='forward' if entry['method']=='backward' else 'backward'
        permitted,clearance=road_translation_limit(after['road'],inverse,length)
        if permitted+1e-9<length:return None,'restore_local_road_clearance_insufficient'
        support=_recorded_translation_support(actions,length,inverse)
        if support is None:return None,'reverse_path_not_continuously_observed'
        if (distance(support['planned_position_m'],p)>.002
                or abs(wrap(heading-old_heading))>.2):
            return None,'reverse_would_not_restore_observed_view'
        last=support['segments'][-1]
        if (last['method']!=entry['method'] or last['before_observation']!=before['observation_index']
                or last['after_observation']!=after['observation_index']
                or entry.get('before_observation')!=before['observation_index']
                or entry.get('after_observation')!=after['observation_index']):
            return None,'restore_previous_motion_reference_mismatch'
        plan.update(method=inverse,params={'distanceCm':length,'speed':30},
                    reverse_path_support=support,road_clearance=clearance)
    else:
        return None,'no_proven_inverse_motion_for_previous_step'
    return plan,None


def sample_discovery(actions, discovery_id):
    from .actions import ObservedMotionFailure
    r=actions.r
    trace={'schema':VERSION,'discovery_id':discovery_id,'initial_object_id':None,
           'confirmed_object_id':None,'initial_hit_count':0,'final_hit_count':0,
           'independent_hits_added':0,'max_steps':MAX_STEPS,'max_travel_cm':MAX_TRAVEL_CM,
           'travelled_cm':0.,'steps':[]}
    first=r.perception.discovery_target(discovery_id)
    identity_obligation=None
    if first and first.get('identity_resolution_required'):
        oid=(first.get('associated_object') or {}).get('id')
        identity_obligation={'grasp_identity':r.perception.grasp_identity_context(oid)}
        trace['identity_resolution_required']=True
        trace['initial_identity_relations']=copy.deepcopy(identity_obligation['grasp_identity'])
    locked=None
    failed_viewpoints=[]
    start_odometer=actions.s['odometry']['distanceCm']
    initial_holding=actions.s['holding']['holding']

    def finish(success,reason,target=None):
        obj=(target or {}).get('associated_object') or {}
        trace.update(reason=reason,final_hit_count=obj.get('hit_count',0),
            independent_hits_added=max(0,obj.get('hit_count',0)-trace['initial_hit_count']),
            travelled_cm=actions.s['odometry']['distanceCm']-start_odometer)
        return actions.result(success,reason,confirmation_sampling=copy.deepcopy(trace))

    def perform(plan,target):
        before=copy.deepcopy(actions.s)
        entry={**plan,'before_observation':before['observation_index'],
               'before_detection':copy.deepcopy((target or {}).get('current_detection')),
               'accepted_hit_poses_before':copy.deepcopy((target or {}).get('confirmation',{}).get('accepted_hit_poses',[]))}
        trace['steps'].append(entry)
        try:
            if (plan['method']=='backward' and plan.get('phase')!='restore_previous_view'
                    and plan.get('reverse_path_support') is not None):
                result=actions.move(plan['method'],plan['params'],sampling_reverse_prefix=True)
            else:
                result=actions.move(plan['method'],plan['params'])
        except ObservedMotionFailure as error:
            entry['motion_failure']=error.evidence
            return before,entry,r.perception.discovery_target(discovery_id),'confirmation_'+error.reason
        except Exception as error:
            # Primitive recovery only observes; preserve the original failure
            # and every restore command, never resend an uncertain command.
            trace['reason']='confirmation_motion_outcome_unknown'
            trace['travelled_cm']=actions.s['odometry']['distanceCm']-start_odometer
            evidence=copy.deepcopy(getattr(error,'action_evidence',{}))
            evidence['confirmation_sampling']=copy.deepcopy(trace)
            error.action_evidence=evidence
            raise
        after=actions.s
        fresh=r.perception.discovery_target(discovery_id)
        entry.update(after_observation=after['observation_index'],actuator_result=copy.deepcopy(result),
                     actual_position_m=list(position(after['odometry'])),
                     measured_displacement_cm=distance(position(before['odometry']),position(after['odometry']))*100,
                     after_sampling_reason=(fresh or {}).get('reason'),
                     after_detection=copy.deepcopy((fresh or {}).get('current_detection')))
        if fresh:entry['accepted_hit_poses_after']=copy.deepcopy(fresh['confirmation']['accepted_hit_poses'])
        failure=None
        if after['odometry']['distanceCm']-start_odometer>MAX_TRAVEL_CM+1e-9:
            failure='confirmation_actual_travel_budget_exceeded'
        elif not after['road'].get('onRoad') or result.get('stoppedBy') in {
                'collision','front_clearance','off_road','wrong_way'}:
            failure='confirmation_motion_blocked'
        elif after['holding']['holding']!=initial_holding:
            failure='confirmation_holding_changed'
        elif plan['method']!='turn' and entry['measured_displacement_cm']<.2:
            failure='confirmation_no_observed_translation'
        return before,entry,fresh,failure

    if first is None:return finish(False,'confirmation_discovery_not_available')
    r.active_discovery_id=first['hypothesis_id']
    obj=first['associated_object'] or {}
    locked=obj.get('id')
    trace.update(initial_object_id=locked,initial_hit_count=obj.get('hit_count',0),
                 source_discovery_id=first['source_discovery_id'])
    for step in range(MAX_STEPS+1):
        target=r.perception.discovery_target(discovery_id)
        if target is None:return finish(False,'confirmation_discovery_not_available')
        travelled=actions.s['odometry']['distanceCm']-start_odometer
        if travelled>MAX_TRAVEL_CM+1e-9:
            return finish(False,'confirmation_actual_travel_budget_exceeded',target)
        obj=target['associated_object'] or {}
        if locked is not None and obj.get('id')!=locked:
            return finish(False,'confirmation_identity_changed',target)
        if locked is None and obj.get('id') is not None:locked=obj['id']
        cue=target.get('navigation_sampling_cue')
        if cue is not None:
            window=_observed_motion_window(actions,cue['source_observation'],actions.s,
                                           allow_localized_stop=True)
            if window is None:
                return finish(False,'confirmation_navigation_cue_motion_window_unverified',target)
        if target['reason']=='target_confirmed' and obj.get('state')=='CONFIRMED':
            if not target.get('current_confirmation_corroborated'):
                return finish(False,'confirmation_current_evidence_not_corroborated',target)
            if identity_obligation is not None:
                from .navigation_progress import grasp_identity_change
                fresh_identity={'grasp_identity':r.perception.grasp_identity_context(obj['id']),
                    'grasp_identity_authorized':r.perception.check_grasp_identity(obj['id'],actions.s)['authorized'],
                    'relevant_object_states':[(o['id'],o.get('state')) for o in r.perception.objects()]}
                resolved=grasp_identity_change(identity_obligation,fresh_identity)
                if not resolved:
                    return finish(False,'confirmation_identity_resolution_not_verified',target)
                trace['identity_resolution_reason']=resolved
            trace['confirmed_object_id']=obj['id']
            trace['confirmation_evidence']=copy.deepcopy(target['current_confirmation_evidence'])
            return finish(True,'discovery_confirmed_from_independent_views',target)
        if not target['sampling_allowed']:
            return finish(False,'confirmation_'+target['reason'],target)
        if not actions.s['road'].get('onRoad'):
            return finish(False,'confirmation_not_on_observed_road',target)
        if actions.s['holding']['holding']!=initial_holding:
            return finish(False,'confirmation_holding_changed',target)
        if len(trace['steps'])>=MAX_STEPS or travelled>=MAX_TRAVEL_CM:
            return finish(False,'confirmation_sampling_budget_exhausted',target)
        rejections={}
        comparison={}
        plan=_plan(actions,target,MAX_TRAVEL_CM-travelled,rejections,failed_viewpoints,comparison,
                   allow_short_probe=sum(bool(s.get('short_sampling_probe')) for s in trace['steps'])<3)
        trace['last_viewpoint_comparison']=comparison
        if plan is None:
            trace['viewpoint_rejections']=rejections
            trace['viewpoint_constraints']=sorted(rejections)[:6]
            return finish(False,'confirmation_no_safe_independent_viewpoint',target)
        before,entry,fresh,failure=perform(plan,target)
        if failure:return finish(False,failure,fresh)
        if locked is not None and fresh is not None and (fresh.get('associated_object') or {}).get('id')!=locked:
            return finish(False,'confirmation_identity_changed',fresh)
        current=(fresh or {}).get('current_detection')
        prior=target['current_detection']
        lost_window=bool(current and 40<=prior['raw_distance_cm']<90
                         and (not 40<=current['raw_distance_cm']<90 or abs(current['raw_bearing_deg'])>35))
        lost_view=bool(not current and ((fresh or {}).get('reason') in {'needs_fresh_observation','target_confirmed'}
                                      or (fresh or {}).get('identity_resolution_required')))
        if lost_view or lost_window:
            reason='confirmation_range_window_lost' if lost_window else 'confirmation_needs_fresh_observation'
            if 'recovery_attempt' in trace:return finish(False,reason,fresh)
            attempt={'trigger_observation':actions.s['observation_index'],
                     'source_observation':before['observation_index'],
                     'trigger_reason':reason,'success':False}
            trace['recovery_attempt']=attempt
            if len(trace['steps'])>=MAX_STEPS:
                attempt['reason']='restore_step_budget_exhausted'
                return finish(False,reason,fresh)
            restore,unavailable=_restore_plan(actions,before,target,entry,
                MAX_TRAVEL_CM-(actions.s['odometry']['distanceCm']-start_odometer))
            if restore is None:
                attempt['reason']=unavailable
                return finish(False,reason,fresh)
            failed_viewpoints.append({'position_m':list(position(before['odometry'])),
                'heading_deg':before['odometry']['headingDeg'],'method':plan['method'],
                'params':copy.deepcopy(plan['params'])})
            _,restored_entry,restored,failure=perform(restore,fresh)
            attempt['restored_observation']=actions.s['observation_index']
            restored_obj=(restored or {}).get('associated_object') or {}
            restored_detection=(restored or {}).get('current_detection') or {}
            position_restored=(distance(position(actions.s['odometry']),position(before['odometry']))<=.002
                and abs(wrap(actions.s['odometry']['headingDeg']-before['odometry']['headingDeg']))<=.2)
            supported=bool(restored and restored.get('current_detection')
                and (restored.get('sampling_allowed') or restored.get('current_confirmation_corroborated'))
                and 40<=restored_detection.get('raw_distance_cm',0)<90
                and abs(restored_detection.get('raw_bearing_deg',180))<=35
                and position_restored and (locked is None or restored_obj.get('id')==locked))
            attempt['observed_pose_restored']=position_restored
            attempt.update(success=not failure and supported,
                reason=failure or ('previous_unique_view_restored' if supported else 'previous_view_not_reacquired'))
            if failure:return finish(False,failure,restored)
            if not supported:return finish(False,'confirmation_previous_view_not_reacquired',restored)
    return finish(False,'confirmation_sampling_budget_exhausted')


def corroborate_final(actions, outcome):
    """The execute() post-observation must still support the claimed identity."""
    proof=outcome.get('evidence',{}).get('confirmation_sampling')
    if not outcome.get('success') or not proof:return outcome
    target=actions.r.perception.discovery_target(proof['discovery_id'])
    obj=(target or {}).get('associated_object') or {}
    if (not target or target['reason']!='target_confirmed'
            or not target.get('current_confirmation_corroborated')
            or obj.get('id')!=proof['confirmed_object_id'] or obj.get('state')!='CONFIRMED'):
        proof['reason']='confirmation_post_action_evidence_not_corroborated'
        return actions.result(False,proof['reason'],confirmation_sampling=proof)
    proof['final_confirmation_observation']=actions.s['observation_index']
    proof['final_confirmation_evidence']=copy.deepcopy(target['current_confirmation_evidence'])
    return outcome
