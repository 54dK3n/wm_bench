"""Bounded public-sensor viewpoint acquisition for explore(discovery_id).

This controller never promotes an object itself. It asks the unchanged
Perception/WorldModel for actual independent hits after every legal movement.
"""
from __future__ import annotations

import copy
import math

from .navigation import distance, position, wrap
from .perception import RANGE_CAL

VERSION = "brain-confirmation-sampling/v1"
MAX_STEPS = 12
MAX_TRAVEL_CM = 120


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


def _reverse_support(actions, length):
    """Only a collinear part of a recorded, accepted road motion may be backed.

    No inferred link between nearby roads, no blind rear clearance assumption,
    no straight reverse of a curve. Fresh local side clearance is checked too.
    """
    getter = getattr(actions.r.roads, 'road_segment_records', None)
    if getter is None:
        return None
    p = position(actions.s['odometry'])
    theta = math.radians(actions.s['odometry']['headingDeg'])
    q = (p[0]+length/100*math.sin(theta),p[1]-length/100*math.cos(theta))
    segments=getter()
    for index in range(len(segments)-1,-1,-1):
        segment=segments[index]
        a,b = segment['departure'],segment['arrival']
        start,end = a['position_m'],b['position_m']
        chord = distance(start,end)*100
        if (chord < .2 or abs(chord-segment['travelled_cm']) > .2
                or abs(wrap(a['travel_heading_deg']-b['travel_heading_deg'])) > .2
                or abs(wrap(b['travel_heading_deg']-actions.s['odometry']['headingDeg'])) > .2):
            continue
        def on_segment(point):
            vx,vz=end[0]-start[0],end[1]-start[1]
            along=((point[0]-start[0])*vx+(point[1]-start[1])*vz)/(chord/100)**2
            projected=(start[0]+along*vx,start[1]+along*vz)
            return 0<=along<=1 and distance(point,projected)<=.002

        # Explicit perpendicular error, not ellipse excess: a long segment
        # must not authorize a parallel neighbouring lane. Require actual
        # continuous recorded motion from its arrival to the present pose.
        cursor=end
        continuous=True
        for later in segments[index+1:]:
            departure=later['departure']['position_m'];arrival=later['arrival']['position_m']
            if (distance(cursor,departure)>.002 or not on_segment(departure)
                    or not on_segment(arrival)
                    or abs(distance(departure,arrival)*100-later['travelled_cm'])>.2):
                continuous=False
                break
            cursor=arrival
        if continuous and distance(cursor,p)<=.002 and all(on_segment(x) for x in (p,q)):
            if b['at_node'] and distance(p,end)*100>.2:
                continue
            return {'segment_id':segment['segment_id'],
                    'continuation_segment_ids':[s['segment_id'] for s in segments[index+1:]],
                    'before_observation':segment['before_observation'],
                    'after_observation':segment['after_observation'],
                    'position_m':list(p),'planned_position_m':list(q)}
    return None


def _plan(actions, target, remaining, rejections):
    from .actions import road_translation_limit
    road,odo=actions.s['road'],actions.s['odometry']
    det=target['current_detection']
    poses=target['confirmation']['accepted_hit_poses']
    gap=target['confirmation']['min_hit_pose_gap_m']
    here=position(odo);heading=odo['headingDeg']
    if road.get('atNode'):
        turns=[e['angleDeg'] for e in road.get('exits',[]) if abs(e['angleDeg'])<=35]
    else:
        turns=[road.get('headingErrorDeg')]
    turns=[a for a in turns if type(a) in (int,float) and math.isfinite(a)
           and abs(det['raw_bearing_deg']+a)<=33]
    def reject(reason):
        rejections[reason]=rejections.get(reason,0)+1

    if turns:
        angle=min(turns,key=abs)
        if abs(angle)>=1:
            return {'method':'turn','params':{'angleDeg':angle,'speed':50},
                    'basis':'fresh_observed_road_direction_preserving_target_view'}
    choices=[]
    for method in ('forward','backward'):
        for length in (15.5,16.,17.,18.,20.,10.):
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
            if not independent and not approaching_far:
                reject('insufficient_separation_from_accepted_hit_poses');continue
            support=None
            if method=='backward':
                support=_reverse_support(actions,length)
                if support is None:
                    reject('reverse_path_not_continuously_observed');continue
            elif not turns:
                reject('no_observed_road_direction_preserves_target_view');continue
            permitted,clearance=road_translation_limit(road,method,length)
            if permitted+1e-9<length:
                reject('insufficient_local_road_clearance');continue
            # Road following handles curvature away from junctions. At an
            # observed node use the uniquely sensed exit direction and a
            # bounded basic step, avoiding take_exit's unbounded endpoint.
            motor=method
            if method=='forward' and not road.get('atNode'):motor='follow_road'
            if method=='forward' and road.get('atNode'):
                aligned=[e for e in road.get('exits',[]) if abs(e['angleDeg'])<1]
                if len(aligned)!=1:
                    reject('aligned_exit_not_unique');continue
            choices.append((not independent,approaching_far,method=='backward',length,
                {'method':motor,'params':{'distanceCm':length,'speed':30 if motor!='follow_road' else 50},
                 'planned_position_m':list(end),'predicted_raw_distance_cm':predicted[0],
                 'predicted_raw_bearing_deg':predicted[1],'range_is_lower_bound':clipped,
                 'independent_pose_predicted':independent,'road_clearance':clearance,
                 'reverse_path_support':support,
                 'basis':'public_target_estimate_local_road_and_accepted_hit_poses'}))
    return min(choices,key=lambda c:c[:4])[-1] if choices else None


def sample_discovery(actions, discovery_id):
    from .actions import ObservedMotionFailure
    r=actions.r
    trace={'schema':VERSION,'discovery_id':discovery_id,'initial_object_id':None,
           'confirmed_object_id':None,'initial_hit_count':0,'final_hit_count':0,
           'independent_hits_added':0,'max_steps':MAX_STEPS,'max_travel_cm':MAX_TRAVEL_CM,
           'travelled_cm':0.,'steps':[]}
    first=r.perception.discovery_target(discovery_id)
    locked=None
    start_odometer=actions.s['odometry']['distanceCm']
    initial_holding=actions.s['holding']['holding']

    def finish(success,reason,target=None):
        obj=(target or {}).get('associated_object') or {}
        trace.update(reason=reason,final_hit_count=obj.get('hit_count',0),
            independent_hits_added=max(0,obj.get('hit_count',0)-trace['initial_hit_count']),
            travelled_cm=actions.s['odometry']['distanceCm']-start_odometer)
        return actions.result(success,reason,confirmation_sampling=copy.deepcopy(trace))

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
        if target['reason']=='target_confirmed' and obj.get('state')=='CONFIRMED':
            if not target.get('current_confirmation_corroborated'):
                return finish(False,'confirmation_current_evidence_not_corroborated',target)
            trace['confirmed_object_id']=obj['id']
            trace['confirmation_evidence']=copy.deepcopy(target['current_confirmation_evidence'])
            return finish(True,'discovery_confirmed_from_independent_views',target)
        if not target['sampling_allowed']:
            return finish(False,'confirmation_'+target['reason'],target)
        if not actions.s['road'].get('onRoad'):
            return finish(False,'confirmation_not_on_observed_road',target)
        if actions.s['holding']['holding']!=initial_holding:
            return finish(False,'confirmation_holding_changed',target)
        if step>=MAX_STEPS or travelled>=MAX_TRAVEL_CM:
            return finish(False,'confirmation_sampling_budget_exhausted',target)
        rejections={}
        plan=_plan(actions,target,MAX_TRAVEL_CM-travelled,rejections)
        if plan is None:
            trace['viewpoint_rejections']=rejections
            trace['viewpoint_constraints']=sorted(rejections)[:6]
            return finish(False,'confirmation_no_safe_independent_viewpoint',target)
        before=copy.deepcopy(actions.s)
        entry={**plan,'before_observation':before['observation_index'],
               'before_detection':copy.deepcopy(target['current_detection']),
               'accepted_hit_poses_before':copy.deepcopy(target['confirmation']['accepted_hit_poses'])}
        trace['steps'].append(entry)
        try:result=actions.move(plan['method'],plan['params'])
        except ObservedMotionFailure as error:
            entry['motion_failure']=error.evidence
            return finish(False,'confirmation_'+error.reason,r.perception.discovery_target(discovery_id))
        except Exception as error:
            # The primitive already performed its read-only recovery. Preserve
            # sampling intent alongside that evidence and never resend it.
            trace['reason']='confirmation_motion_outcome_unknown'
            trace['travelled_cm']=actions.s['odometry']['distanceCm']-start_odometer
            evidence=copy.deepcopy(getattr(error,'action_evidence',{}))
            evidence['confirmation_sampling']=copy.deepcopy(trace)
            error.action_evidence=evidence
            raise
        after=actions.s
        entry.update(after_observation=after['observation_index'],actuator_result=copy.deepcopy(result),
                     actual_position_m=list(position(after['odometry'])),
                     measured_displacement_cm=distance(position(before['odometry']),position(after['odometry']))*100)
        if not after['road'].get('onRoad') or result.get('stoppedBy') in {
                'collision','front_clearance','off_road','wrong_way'}:
            return finish(False,'confirmation_motion_blocked',target)
        if after['holding']['holding']!=initial_holding:
            return finish(False,'confirmation_holding_changed',target)
        if plan['method']!='turn' and entry['measured_displacement_cm']<.2:
            return finish(False,'confirmation_no_observed_translation',target)
        fresh=r.perception.discovery_target(discovery_id)
        entry['after_sampling_reason']=(fresh or {}).get('reason')
        entry['after_detection']=copy.deepcopy((fresh or {}).get('current_detection'))
        if fresh and fresh['current_detection']:
            current=fresh['current_detection'];prior=target['current_detection']
            entry['accepted_hit_poses_after']=copy.deepcopy(fresh['confirmation']['accepted_hit_poses'])
            if (40<=prior['raw_distance_cm']<90 and not 40<=current['raw_distance_cm']<90):
                return finish(False,'confirmation_range_window_lost',fresh)
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
