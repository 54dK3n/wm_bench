"""Standalone synthetic tests; run with python3 -B test_candidate.py -v."""
import copy
import json
import math
import unittest
from pathlib import Path

import candidate_navigation as nav


BASE_FIELDS = tuple(nav._base.RoadMemory().__dict__)


def legacy(memory):
    return copy.deepcopy({k: getattr(memory, k) for k in BASE_FIELDS})


def observe(memory, i, x, z, travelled, exits, *, heading=0, on_road=True, sensor=True):
    row = {"observation_index": i,
           "odometry": {"rightCm": x, "forwardCm": z, "headingDeg": heading,
                        "distanceCm": travelled, "tick": i},
           "road": {"onRoad": on_road, "atNode": bool(exits), "atJunction": len(exits) > 1,
                    "exits": [{"angleDeg": h - heading} for h in exits], "headingErrorDeg": 0,
                    "frontClearanceCm": 100, "leftClearanceCm": 10, "rightClearanceCm": 10, "tick": i}}
    if sensor:
        row["observation"] = {"frameId": i, "tick": i}
    memory.update(row["odometry"], row["road"], observation_index=i)
    return row


def motion(a, b, angle=0, **result):
    return {"method": "take_exit", "params": {"angleDeg": angle},
            "before_observation": a["observation_index"], "after_observation": b["observation_index"],
            "actuator_result": {"accepted": True, "stoppedBy": "entered_road", **result}}


def select(memory, row, angle=0):
    memory.chosen(row["odometry"], angle, observation_index=row["observation_index"])


def single_trip(*, start_exits=(0,), end_exits=(180, 90), travelled=100, end_z=100,
                sensor=True, result=None):
    memory = nav.RoadMemory()
    a = observe(memory, 1, 0, 0, 0, start_exits, sensor=sensor)
    select(memory, a)
    b = observe(memory, 2, 0, end_z, travelled, end_exits, sensor=sensor)
    m = motion(a, b, **(result or {}))
    return memory, a, b, m


def query(memory, row, **kwargs):
    return memory.frontier_hints(row["odometry"], row["road"], observation_index=row["observation_index"], **kwargs)


class CandidateTests(unittest.TestCase):
    def test_legacy_v4_state_unchanged_on_all_fixed_run18_observations(self):
        data = json.loads(Path(__file__).with_name("public-inputs.json").read_text())
        baseline, candidate = nav._base.RoadMemory(), nav.RoadMemory()
        by_before = {m["before_observation"]: m for m in data["run18"]["motions"]}
        for row in data["run18"]["road_observations_through_851"]:
            baseline.update(row["odometry"], row["road"])
            candidate.update(row["odometry"], row["road"], row["observation_index"])
            if row["observation_index"] in by_before:
                angle = by_before[row["observation_index"]]["params"]["angleDeg"]
                baseline.chosen(row["odometry"], angle)
                candidate.chosen(row["odometry"], angle, observation_index=row["observation_index"])
            self.assertEqual(baseline.__dict__, legacy(candidate))
        self.assertEqual(candidate.traversal_records(), [], "legacy completion alone never records a trip")

    def test_completed_trip_uses_odometer_not_chord_and_is_directed(self):
        memory, a, b, m = single_trip(travelled=140)
        before = legacy(memory)
        result = memory.record_completed_traversal([a, b], [m])
        self.assertTrue(result["recorded"])
        self.assertEqual(result["trip"]["travelled_cm"], 140)
        self.assertEqual(result["trip"]["departure_heading_deg"], 0)
        self.assertEqual(len(memory.traversal_records()), 1)
        self.assertEqual(legacy(memory), before)
        self.assertFalse(memory.record_completed_traversal([a, b], [m])["recorded"])

    def test_unrecorded_reverse_has_no_path(self):
        memory, a, b, m = single_trip(start_exits=(0, 90), end_exits=(180,))
        self.assertTrue(memory.record_completed_traversal([a, b], [m])["recorded"])
        self.assertEqual(query(memory, b), [])
        self.assertEqual(memory.unexplored(), 1)

    def test_current_fresh_unexplored_has_priority_over_recorded_routes(self):
        memory, a, b, m = single_trip(start_exits=(0, 90))
        memory.record_completed_traversal([a, b], [m])
        current = observe(memory, 3, 0, 0, 200, (0, 90))
        hints = query(memory, current)
        self.assertEqual(len(hints), 1)
        self.assertEqual(hints[0]["kind"], "current_fresh_unexplored")
        self.assertEqual(hints[0]["next_exit_angle_deg"], 90)
        self.assertEqual(hints[0]["traversal_ids"], [])

    def test_recorded_route_uses_fresh_relative_angle_and_query_deep_copies(self):
        memory, a, b, m = single_trip()
        memory.record_completed_traversal([a, b], [m])
        current = observe(memory, 3, 0, 0, 200, (0,), heading=35)
        before = copy.deepcopy(memory.__dict__)
        hints = query(memory, current)
        self.assertEqual(len(hints), 1)
        self.assertEqual(hints[0]["next_exit_angle_deg"], -35)
        self.assertEqual(hints[0]["recorded_travelled_cm"], 100)
        self.assertEqual(hints[0]["target_anchor_gap_cm"], 0)
        self.assertTrue(hints[0]["requires_fresh_arrival_and_exit_recheck"])
        self.assertEqual(memory.__dict__, before)
        hints[0]["arrival_anchor"]["position_m"][0] = 999
        hints[0]["traversal_ids"].append("invented")
        memory.traversal_records()[0]["departure"]["position_m"][0] = 999
        next(iter(memory.exit_observation_anchors().values()))[0]["node_id"] = "invented"
        self.assertEqual(memory.__dict__, before)

    def test_at_most_three_targets(self):
        memory, a, b, m = single_trip(end_exits=(180, 30, 60, 90, 120))
        memory.record_completed_traversal([a, b], [m])
        current = observe(memory, 3, 0, 0, 200, (0,))
        self.assertEqual(len(query(memory, current, limit=99)), 3)
        self.assertEqual(len(query(memory, current, limit=1)), 1)

    def test_disconnected_memory_is_not_reachable_via_breadcrumbs(self):
        memory = nav.RoadMemory()
        observe(memory, 1, 0, 0, 0, (0,))
        observe(memory, 2, 0, 40, 40, (180, 90))
        current = observe(memory, 3, 0, 0, 80, (0,))
        memory.nodes[0]["exits"][0]["completed"] = True
        self.assertTrue(memory.edges[0], "baseline undirected breadcrumb exists")
        self.assertEqual(query(memory, current), [])

    def test_first_fresh_angle_ambiguous_or_missing_returns_no_route(self):
        for exits in ((0, 4), (90,)):
            with self.subTest(exits=exits):
                memory, a, b, m = single_trip()
                memory.record_completed_traversal([a, b], [m])
                current = observe(memory, 3, 0, 0, 200, exits)
                for e in memory.nodes[0]["exits"]:
                    e["completed"] = True
                self.assertEqual(query(memory, current), [])

    def test_blocked_recorded_departure_is_not_recommended(self):
        memory, a, b, m = single_trip()
        memory.record_completed_traversal([a, b], [m])
        memory.nodes[0]["exits"][0]["blocked"] = True
        current = observe(memory, 3, 0, 0, 200, (0,))
        self.assertEqual(query(memory, current), [])

    def test_same_bucket_but_shifted_current_anchor_cannot_invent_a_start_leg(self):
        memory, a, b, m = single_trip()
        memory.record_completed_traversal([a, b], [m])
        current = observe(memory, 3, 0, 5, 195, (0,))
        self.assertEqual(memory.current_node(current["odometry"])["id"], memory.nodes[0]["id"])
        self.assertEqual(query(memory, current), [])

    def test_mixed_fresh_context_at_same_position_cannot_start_old_route(self):
        memory, a, b, m = single_trip(start_exits=(0, 90))
        memory.record_completed_traversal([a, b], [m])
        current = observe(memory, 3, 0, 0, 200, (0, -90))
        for e in memory.nodes[0]["exits"]:
            e["completed"] = True
        self.assertEqual(query(memory, current), [])

    def test_two_completed_directed_trips_can_be_concatenated(self):
        memory, a, b, m = single_trip()
        memory.record_completed_traversal([a, b], [m])
        select(memory, b, 90)
        c = observe(memory, 3, -100, 100, 200, (-90, 0))
        self.assertTrue(memory.record_completed_traversal([b, c], [motion(b, c, 90)])["recorded"])
        current = observe(memory, 4, 0, 0, 400, (0,))
        hints = query(memory, current)
        target = next(h for h in hints if h["target_heading_deg"] == 0)
        self.assertEqual(target["traversal_ids"], ["traversal-1", "traversal-2"])
        self.assertEqual(target["recorded_travelled_cm"], 200)

    def test_same_bucket_different_context_cannot_concatenate(self):
        memory, a, b, m = single_trip()
        memory.record_completed_traversal([a, b], [m])
        shifted = observe(memory, 3, 0, 105, 105, (180, 90))
        select(memory, shifted, 90)
        c = observe(memory, 4, -100, 105, 205, (-90, 0))
        memory.record_completed_traversal([shifted, c], [motion(shifted, c, 90)])
        current = observe(memory, 5, 0, 0, 405, (0,))
        self.assertEqual(query(memory, current), [])

    def test_target_anchor_gap_is_explicit_and_does_not_retire_obligations(self):
        memory, a, b, m = single_trip()
        memory.record_completed_traversal([a, b], [m])
        observe(memory, 3, 0, 105, 105, (180, 90))
        current = observe(memory, 4, 0, 0, 210, (0,))
        before = legacy(memory)
        hints = query(memory, current)
        self.assertAlmostEqual(hints[0]["target_anchor_gap_cm"], 5)
        self.assertEqual(hints[0]["target_observation_anchor"]["observation_index"], 3)
        self.assertEqual(hints[0]["arrival_anchor"]["observation_index"], 2)
        self.assertEqual(legacy(memory), before)

    def test_later_closer_node_cannot_reassign_a_historical_arrival_anchor(self):
        memory = nav.RoadMemory()
        observe(memory, 1, 0, 100, 0, (180, 90))
        a = observe(memory, 2, 0, 0, 100, (0,)); select(memory, a)
        b = observe(memory, 3, 0, 114, 214, (180, 90))
        original_node = memory.current_node(b["odometry"])["id"]
        observe(memory, 4, 0, 125, 225, (180, 90))
        self.assertNotEqual(memory.current_node(b["odometry"])["id"], original_node)
        result = memory.record_completed_traversal([a, b], [motion(a, b)])
        self.assertTrue(result["recorded"])
        self.assertEqual(result["trip"]["arrival"]["node_id"], original_node)

    def test_minimal_snapshots_without_optional_sensor_payload_are_supported(self):
        memory, a, b, m = single_trip(sensor=False)
        self.assertTrue(memory.record_completed_traversal([a, b], [m])["recorded"])

    def test_primitive_completion_contract_and_readonly_captured_anchor(self):
        for method in ("forward", "backward"):
            for completed in (True, False):
                with self.subTest(method=method, completed=completed):
                    memory = nav.RoadMemory()
                    a = observe(memory, 1, 0, 0, 0, (0,)); select(memory, a)
                    heading = 180 if method == "backward" else 0
                    b = observe(memory, 2, 0, 40, 40, (), heading=heading)
                    c = observe(memory, 3, 0, 100, 100, (180, 90), heading=heading)
                    second = {"method": method, "params": {}, "before_observation": 2,
                              "after_observation": 3, "actuator_result": {"completed": completed}}
                    result = memory.record_completed_traversal([a, b, c], [motion(a, b), second])
                    self.assertEqual(result["recorded"], completed)
                    anchor = memory.observation_anchor(1)
                    anchor["position_m"][0] = 999
                    self.assertEqual(memory.observation_anchor(1)["position_m"], [0, 0])

    def test_legacy_calls_without_anchors_cannot_create_trips_or_hints(self):
        memory = nav.RoadMemory()
        temp, a, b, m = single_trip()
        memory.update(a["odometry"], a["road"])
        memory.chosen(a["odometry"], 0)
        memory.update(b["odometry"], b["road"])
        self.assertFalse(memory.record_completed_traversal([a, b], [m])["recorded"])
        self.assertEqual(query(memory, b), [])
        self.assertEqual(memory.exit_observation_anchors(), {})

    def test_unobserved_arrival_is_pending_not_completed(self):
        memory, a, b, m = single_trip(end_exits=())
        result = memory.record_completed_traversal([a, b], [m])
        self.assertEqual(result["status"], "pending")
        self.assertEqual(memory.traversal_records(), [])

    def test_same_node_no_progress_is_not_a_completed_trip(self):
        memory, a, b, m = single_trip(end_exits=(0,), travelled=0, end_z=0)
        self.assertFalse(memory.record_completed_traversal([a, b], [m])["recorded"])

    def test_bad_public_motion_never_creates_route_even_if_v4_already_completed(self):
        for result in ({"stoppedBy": s} for s in ("collision", "wrong_way", "front_clearance", "off_road")):
            memory, a, b, m = single_trip(result=result)
            before = legacy(memory)
            self.assertFalse(memory.record_completed_traversal([a, b], [m])["recorded"])
            self.assertEqual(memory.traversal_records(), [])
            self.assertEqual(legacy(memory), before)
        for result in ({"accepted": False}, {"accepted": None}, {"error": "synthetic"}):
            memory, a, b, m = single_trip(result=result)
            self.assertFalse(memory.record_completed_traversal([a, b], [m])["recorded"])

    def test_offroad_observation_cancels_even_with_accepted_motion(self):
        memory = nav.RoadMemory()
        a = observe(memory, 1, 0, 0, 0, (0,)); select(memory, a)
        b = observe(memory, 2, 0, 100, 100, (180, 90), on_road=False)
        self.assertFalse(memory.record_completed_traversal([a, b], [motion(a, b)])["recorded"])

    def test_missing_nonfinite_or_decreasing_odometer_is_rejected(self):
        for value in (None, float("nan"), float("inf"), -1):
            memory, a, b, m = single_trip(travelled=value)
            self.assertFalse(memory.record_completed_traversal([a, b], [m])["recorded"])
        memory = nav.RoadMemory()
        a = observe(memory, 1, 0, 0, 200, (0,)); select(memory, a)
        b = observe(memory, 2, 0, 100, 100, (180, 90))
        self.assertFalse(memory.record_completed_traversal([a, b], [motion(a, b)])["recorded"])

    def test_missing_or_nonconsecutive_motion_observation_window_is_rejected(self):
        memory, a, b, m = single_trip()
        self.assertFalse(memory.record_completed_traversal([a, b], [])["recorded"])
        changed = copy.deepcopy(b); changed["observation_index"] = 9
        self.assertFalse(memory.record_completed_traversal([a, changed], [m])["recorded"])

    def test_stationary_extra_observation_supported_but_unaccounted_motion_rejected(self):
        for moved in (False, True):
            memory = nav.RoadMemory()
            a = observe(memory, 1, 0, 0, 0, (0,)); select(memory, a)
            middle = observe(memory, 2, 0, 40, 40, ())
            extra = copy.deepcopy(middle); extra["observation_index"] = 3; extra["observation"]["frameId"] = 3
            if moved:
                extra["odometry"]["forwardCm"] = 41; extra["odometry"]["distanceCm"] = 41
            memory.update(extra["odometry"], extra["road"], 3)
            end = observe(memory, 4, 0, 100, 100, (180, 90))
            m2 = motion(extra, end); m2["method"] = "follow_road"; m2["params"] = {"distanceCm": 60}
            result = memory.record_completed_traversal([a, middle, extra, end], [motion(a, middle), m2])
            self.assertEqual(result["recorded"], not moved)

    def test_stale_sensor_frames_or_conflicting_registered_snapshot_rejected(self):
        memory, a, b, m = single_trip()
        b["observation"]["frameId"] = a["observation"]["frameId"]
        self.assertFalse(memory.record_completed_traversal([a, b], [m])["recorded"])
        b["road"]["frontClearanceCm"] = 50
        memory.update(b["odometry"], b["road"], 2)
        self.assertFalse(memory.record_completed_traversal([a, b], [m])["recorded"])
        self.assertEqual(query(memory, b), [])


if __name__ == "__main__":
    unittest.main()
