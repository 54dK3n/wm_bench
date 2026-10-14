"""Current public navigation cue is not historical identity corroboration.

PUBLIC_WINDOW is copied unchanged from run-20261011T083140Z observations
393..396. Rebuilding this selected window from empty memory is a component
counterfactual, not a competition. Synthetic feedback/negative cases below
are labelled separately and never written back to the source logs.
"""
import copy
import json
from types import SimpleNamespace

import pytest

from test_brain_confirmation_sampling import SensorBridge
from test_brain_perception import CAMERA
from autonomous_brain import run
from autonomous_brain.actions import Actions
from autonomous_brain.confirmation_sampling import _plan, sample_discovery
from autonomous_brain.navigation import RoadMemory
from autonomous_brain.perception import Perception
from autonomous_brain.task import parse_task


def public_runtime(*, change=None, motion_change=None, boundary=None):
    rows = copy.deepcopy(PUBLIC_WINDOW)
    motion = copy.deepcopy(PUBLIC_MOTION)
    if change:
        change(rows)
    if motion_change:
        motion = motion_change(motion)
    r = run.Runtime.__new__(run.Runtime)
    r.config = {'task': '把两个红球送到绿色存放区'}
    r.task_spec = parse_task(r.config['task'])
    r.round = 73
    r.recent = []
    r.held_object_id = r.pending_grasp = None
    r.perception, r.roads = Perception(CAMERA), RoadMemory()
    r.trace, r.motions = [], []
    r.observation_log = SimpleNamespace(write=lambda row: r.trace.append(copy.deepcopy(row)))
    r.motion_log = SimpleNamespace(write=lambda row: r.motions.append(copy.deepcopy(row)))
    for row in rows:
        i = row['observation_index']
        if boundary and i == 396:
            r.perception.note_manipulation_boundary(boundary, boundary.get('after_observation'))
        evidence = r.perception.update(row['observation'], row['odometry'],
            simulation_time_s=row['simulation_seconds'], round_index=row['round'], observation_index=i)
        r.snapshot = {**row, 'perception': evidence, 'objects': r.perception.objects(),
                      'discovery_evidence': r.perception.discovery_evidence()}
        r.observation_count = i
        r.roads.update(row['odometry'], row['road'], observation_index=i)
        r.roads.observe_traversal(r.snapshot, motion if i == 396 else None)
        r.perception.note_sampling_context(r.snapshot)
    # Any command after this original window receives synthetic empty pixels.
    # They test feedback handling, not the unseen real view at a new heading.
    r.bridge = SensorBridge(mode='occluded')
    odo = r.snapshot['odometry']
    r.bridge.x, r.bridge.z = odo['rightCm'], odo['forwardCm']
    r.bridge.heading, r.bridge.travel = odo['headingDeg'], odo['distanceCm']
    r.bridge.tick, r.bridge.frame = odo['tick'], 396
    r.bridge.seconds = r.snapshot['simulation_seconds']
    r.actions = Actions(r)
    return r


def source_id(r):
    return r.perception.discovery_evidence()['records'][0]['id']


def target(r):
    return r.perception.discovery_target(source_id(r))


def test_original_public_window_opens_only_navigation_and_retains_m5_conflict():
    r = public_runtime()
    before_objects = copy.deepcopy(r.perception.objects())
    before_ledger = r.perception.discovery_evidence()
    t = target(r)
    assert t['sampling_allowed'] and t['reason'] == 'current_navigation_cue'
    assert t['associated_object']['state'] == 'TENTATIVE'
    assert t['associated_object']['hit_count'] == 2
    assert t['associated_object']['position_evidence']['pixel_consistency'] == 'incompatible_original_pixels'
    assert t['current_confirmation_corroborated'] is False
    assert t['current_confirmation_evidence']['source_pixels_supported'] is False
    assert t['navigation_sampling_cue']['source_observation'] == 393
    assert t['navigation_sampling_cue']['current_observation'] == 396
    assert t['navigation_sampling_cue']['identity_authorized'] is False
    assert not r.perception.check_grasp_identity(t['associated_object']['id'], r.snapshot)['authorized']
    plan = _plan(r.actions, t, 120, {})
    assert plan['method'] == 'turn' and plan['params']['angleDeg'] == 10.5
    assert plan['next_independent_viewpoint']['method'] == 'follow_road'
    assert plan['next_independent_viewpoint']['params']['distanceCm'] == 15.5
    assert plan['next_viewpoint_requires_fresh_observation'] is True
    summary = r.perception.discovery_summary()['executable_candidates'][0]
    assert summary['navigation_sampling_cue']['identity_authorized'] is False
    assert summary['reason'] == 'current_navigation_cue' and summary['hit_count'] == 2
    assert r.perception.objects() == before_objects
    assert r.perception.discovery_evidence() == before_ledger
    assert not before_ledger['resolutions']


def test_actual_sampler_turns_then_rechecks_synthetic_missing_pixels_without_forward():
    r = public_runtime()
    result = sample_discovery(r.actions, source_id(r))
    assert r.bridge.calls[0] == ('turn', {'angleDeg': 10.5, 'speed': 50})
    assert all(method == 'turn' for method, _ in r.bridge.calls)
    assert not result['success']
    assert result['evidence']['confirmation_sampling']['confirmed_object_id'] is None
    assert len(r.perception.objects()[0]['hit_poses']) == 2
    assert not r.perception.discovery_evidence()['resolutions']


def test_synthetic_supported_turn_is_reobserved_before_new_translation_and_hit():
    r = public_runtime()
    point = target(r)['current_detection']['position_m']
    r.bridge.target = point['x'] * 100, point['z'] * 100
    r.bridge.mode = None
    render = r.bridge.pixels
    def supported_pixels():
        pixels = render()
        for d in pixels:
            d['pixelQuality'] = {'schema': 'red-component-quality/v1', 'frameId': r.bridge.frame,
                'componentPixels': 100, 'redSectorPixels': 100, 'status': 'supported',
                'reason': 'red_sector_majority'}
        return pixels
    r.bridge.pixels = supported_pixels
    result = sample_discovery(r.actions, source_id(r))
    assert [m for m, _ in r.bridge.calls] == ['turn', 'follow_road']
    steps = result['evidence']['confirmation_sampling']['steps']
    assert steps[0]['after_observation'] == steps[1]['before_observation'] == 397
    assert len(steps[0]['accepted_hit_poses_before']) == len(steps[0]['accepted_hit_poses_after']) == 2
    assert len(steps[1]['accepted_hit_poses_after']) == 3
    assert steps[0]['after_detection']['fed_to_world_model'] is True
    assert steps[0]['after_sampling_reason'] == 'current_navigation_cue'
    assert result['success'] is False
    assert result['reason'] == 'confirmation_current_evidence_not_corroborated'
    assert result['evidence']['confirmation_sampling']['confirmed_object_id'] is None
    assert target(r)['current_confirmation_evidence']['source_pixels_supported'] is False


@pytest.mark.parametrize('case', ['same_frame_peer', 'unknown_quality', 'cropped', 'legacy', 'different_track'])
def test_synthetic_invalid_or_competing_current_evidence_does_not_open_cue(case):
    def change(rows):
        items = rows[-1]['observation']['detections']
        d = next(d for d in items if d['category'] == 'red-ball')
        if case == 'same_frame_peer':
            items.append(copy.deepcopy(d))
        elif case == 'unknown_quality':
            d['pixelQuality'].update(status='unknown', reason='red_sector_not_majority', redSectorPixels=0)
        elif case == 'cropped':
            d['bbox']['x'] = 0
            d['pixelQuality'].update(status='unknown', reason='source_bbox_touches_boundary')
        elif case == 'legacy':
            d.pop('pixelQuality')
        elif case == 'different_track':
            # A new box far outside the original unchanged association gate.
            d['bbox']['x'] = 550
    r = public_runtime(change=change)
    t = target(r)
    assert not t['sampling_allowed']
    assert 'navigation_sampling_cue' not in t
    assert not t['current_confirmation_corroborated']
    assert not r.perception.discovery_evidence()['resolutions']


@pytest.mark.parametrize('known', [False, True])
def test_public_window_with_synthetic_manipulation_boundary_rejects_cue(known):
    boundary = {'method': 'grab', 'before_observation': 395, 'outcome_unknown': not known}
    if known:
        boundary['after_observation'] = 396
    r = public_runtime(boundary=boundary)
    t = target(r)
    assert not t['sampling_allowed']
    assert t['reason'] == 'manipulation_boundary_unresolved'
    assert 'navigation_sampling_cue' not in t


@pytest.mark.parametrize('case', ['unknown', 'missing', 'missing_stationary_tick'])
def test_navigation_cue_never_crosses_unknown_or_missing_public_motion(case):
    def motion_change(m):
        if case == 'unknown':
            return {**m, 'outcome_unknown': True}
        return None
    def change(rows):
        if case == 'missing_stationary_tick':
            # Same pose is insufficient when a receipt is missing across time.
            prior = rows[-2]['odometry']
            rows[-1]['odometry'].update({k: prior[k] for k in
                ('forwardCm', 'rightCm', 'headingDeg', 'distanceCm')})
    r = public_runtime(change=change, motion_change=motion_change)
    assert target(r).get('navigation_sampling_cue')
    result = sample_discovery(r.actions, source_id(r))
    assert not result['success']
    assert result['reason'] == 'confirmation_navigation_cue_motion_window_unverified'
    assert r.bridge.calls == []

PUBLIC_SOURCE_SHA256 = '02b1c4f6aa90a6c6fc2f54120e2c00296b518c9b23a805a14a5d791446c85857'
PUBLIC_WINDOW = json.loads(r'''[
  {
    "observation_index": 393,
    "round": 72,
    "simulation_seconds": 298.06,
    "odometry": {
      "forwardCm": 217.5,
      "rightCm": 60.1,
      "headingDeg": 100,
      "distanceCm": 2155.2,
      "tick": 14903
    },
    "road": {
      "onRoad": true,
      "lateralOffsetCm": 0,
      "headingErrorDeg": 4.9,
      "leftClearanceCm": 9.2,
      "rightClearanceCm": 9.2,
      "frontClearanceCm": 340.9,
      "atJunction": false,
      "atNode": true,
      "exits": [
        {
          "angleDeg": 0
        }
      ],
      "tick": 14903
    },
    "holding": {
      "holding": false
    },
    "observation": {
      "frameId": 393,
      "tick": 14903,
      "width": 640,
      "height": 480,
      "detections": [
        {
          "category": "red-ball",
          "confidence": 0.9125,
          "bbox": {
            "x": 106,
            "y": 190,
            "w": 32,
            "h": 20
          },
          "source": "virtual-cv",
          "pixelQuality": {
            "schema": "red-component-quality/v1",
            "frameId": 393,
            "componentPixels": 140,
            "redSectorPixels": 134,
            "status": "supported",
            "reason": "red_sector_majority"
          }
        },
        {
          "category": "blue-ball",
          "confidence": 0.8393333333333333,
          "bbox": {
            "x": 282,
            "y": 150,
            "w": 20,
            "h": 42
          },
          "source": "virtual-cv"
        },
        {
          "category": "obstacle",
          "confidence": 0.78,
          "bbox": {
            "x": 611,
            "y": 224,
            "w": 29,
            "h": 50
          },
          "source": "virtual-cv"
        },
        {
          "category": "obstacle",
          "confidence": 0.8300000000000001,
          "bbox": {
            "x": 345,
            "y": 186,
            "w": 35,
            "h": 20
          },
          "source": "virtual-cv"
        }
      ]
    }
  },
  {
    "observation_index": 394,
    "round": 72,
    "simulation_seconds": 298.06,
    "odometry": {
      "forwardCm": 217.5,
      "rightCm": 60.1,
      "headingDeg": 100,
      "distanceCm": 2155.2,
      "tick": 14903
    },
    "road": {
      "onRoad": true,
      "lateralOffsetCm": 0,
      "headingErrorDeg": 4.9,
      "leftClearanceCm": 9.2,
      "rightClearanceCm": 9.2,
      "frontClearanceCm": 340.9,
      "atJunction": false,
      "atNode": true,
      "exits": [
        {
          "angleDeg": 0
        }
      ],
      "tick": 14903
    },
    "holding": {
      "holding": false
    },
    "observation": {
      "frameId": 394,
      "tick": 14903,
      "width": 640,
      "height": 480,
      "detections": [
        {
          "category": "red-ball",
          "confidence": 0.9125,
          "bbox": {
            "x": 106,
            "y": 190,
            "w": 32,
            "h": 20
          },
          "source": "virtual-cv",
          "pixelQuality": {
            "schema": "red-component-quality/v1",
            "frameId": 394,
            "componentPixels": 140,
            "redSectorPixels": 134,
            "status": "supported",
            "reason": "red_sector_majority"
          }
        },
        {
          "category": "blue-ball",
          "confidence": 0.8393333333333333,
          "bbox": {
            "x": 282,
            "y": 150,
            "w": 20,
            "h": 42
          },
          "source": "virtual-cv"
        },
        {
          "category": "obstacle",
          "confidence": 0.78,
          "bbox": {
            "x": 611,
            "y": 224,
            "w": 29,
            "h": 50
          },
          "source": "virtual-cv"
        },
        {
          "category": "obstacle",
          "confidence": 0.8300000000000001,
          "bbox": {
            "x": 345,
            "y": 186,
            "w": 35,
            "h": 20
          },
          "source": "virtual-cv"
        }
      ]
    }
  },
  {
    "observation_index": 395,
    "round": 73,
    "simulation_seconds": 298.06,
    "odometry": {
      "forwardCm": 217.5,
      "rightCm": 60.1,
      "headingDeg": 100,
      "distanceCm": 2155.2,
      "tick": 14903
    },
    "road": {
      "onRoad": true,
      "lateralOffsetCm": 0,
      "headingErrorDeg": 4.9,
      "leftClearanceCm": 9.2,
      "rightClearanceCm": 9.2,
      "frontClearanceCm": 340.9,
      "atJunction": false,
      "atNode": true,
      "exits": [
        {
          "angleDeg": 0
        }
      ],
      "tick": 14903
    },
    "holding": {
      "holding": false
    },
    "observation": {
      "frameId": 395,
      "tick": 14903,
      "width": 640,
      "height": 480,
      "detections": [
        {
          "category": "red-ball",
          "confidence": 0.9125,
          "bbox": {
            "x": 106,
            "y": 190,
            "w": 32,
            "h": 20
          },
          "source": "virtual-cv",
          "pixelQuality": {
            "schema": "red-component-quality/v1",
            "frameId": 395,
            "componentPixels": 140,
            "redSectorPixels": 134,
            "status": "supported",
            "reason": "red_sector_majority"
          }
        },
        {
          "category": "blue-ball",
          "confidence": 0.8393333333333333,
          "bbox": {
            "x": 282,
            "y": 150,
            "w": 20,
            "h": 42
          },
          "source": "virtual-cv"
        },
        {
          "category": "obstacle",
          "confidence": 0.78,
          "bbox": {
            "x": 611,
            "y": 224,
            "w": 29,
            "h": 50
          },
          "source": "virtual-cv"
        },
        {
          "category": "obstacle",
          "confidence": 0.8300000000000001,
          "bbox": {
            "x": 345,
            "y": 186,
            "w": 35,
            "h": 20
          },
          "source": "virtual-cv"
        }
      ]
    }
  },
  {
    "observation_index": 396,
    "round": 73,
    "simulation_seconds": 299.72,
    "odometry": {
      "forwardCm": 214.8,
      "rightCm": 44.8,
      "headingDeg": 100,
      "distanceCm": 2170.7,
      "tick": 14986
    },
    "road": {
      "onRoad": true,
      "lateralOffsetCm": 2.3,
      "headingErrorDeg": 10.5,
      "leftClearanceCm": 11.5,
      "rightClearanceCm": 6.9,
      "frontClearanceCm": 325.4,
      "atJunction": false,
      "atNode": false,
      "exits": [],
      "tick": 14986
    },
    "holding": {
      "holding": false
    },
    "observation": {
      "frameId": 396,
      "tick": 14986,
      "width": 640,
      "height": 480,
      "detections": [
        {
          "category": "red-ball",
          "confidence": 0.921,
          "bbox": {
            "x": 68,
            "y": 192,
            "w": 40,
            "h": 22
          },
          "source": "virtual-cv",
          "pixelQuality": {
            "schema": "red-component-quality/v1",
            "frameId": 396,
            "componentPixels": 201,
            "redSectorPixels": 194,
            "status": "supported",
            "reason": "red_sector_majority"
          }
        },
        {
          "category": "obstacle",
          "confidence": 0.8266666666666667,
          "bbox": {
            "x": 416,
            "y": 200,
            "w": 26,
            "h": 20
          },
          "source": "virtual-cv"
        }
      ]
    }
  }
]''')
PUBLIC_MOTION = json.loads(r'''{
  "round": 73,
  "method": "forward",
  "params": {
    "distanceCm": 15.5,
    "speed": 30
  },
  "before_observation": 395,
  "bridge_request_id": "brain-001832",
  "actuator_result": {
    "completed": true
  },
  "motion_verification": {
    "method": "forward",
    "before_observation": 395,
    "after_observation": 396,
    "before_on_road": true,
    "after_on_road": true,
    "before_holding": false,
    "after_holding": false,
    "before_frame_id": 395,
    "after_frame_id": 396,
    "frame_fresh": true,
    "measured_cm": 15.536408851468861,
    "heading_change_deg": 0,
    "requested_cm": 15.5,
    "along_cm": 15.536408700787497,
    "across_cm": -0.002163814828916255,
    "applicable": true,
    "motion_verified": true,
    "reasons": [],
    "holding_changed": false,
    "road_changed": false
  },
  "after_observation": 396
}''')

