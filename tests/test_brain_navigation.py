"""Retain legacy sensor coordinates while requiring complete public motion windows."""
import unittest

from autonomous_brain.navigation import RoadMemory
from test_brain_stage2_adversarial import SensorTrace, exit_at


def odometry(right_cm=0, forward_cm=0, heading_deg=0):
    return {"rightCm": right_cm, "forwardCm": forward_cm, "headingDeg": heading_deg,
            "distanceCm": 0, "tick": 0}


def road(*angles, at_node=True, error=0):
    return {"onRoad": True, "atNode": at_node, "headingErrorDeg": error,
            "exits": [{"angleDeg": angle} for angle in angles]}


class RoadMemoryTraversalTests(unittest.TestCase):
    def start_exit(self):
        memory = RoadMemory()
        memory.update(odometry(), road(0))
        memory.chosen(odometry(), 0)
        return memory

    def test_direct_node_updates_without_motion_complete_neither_direction(self):
        memory = self.start_exit()

        # One action reaches the next node; no atNode=False frame is available.
        arrival = odometry(forward_cm=25)
        memory.update(arrival, road(180, 90))

        self.assertEqual(memory.traversal_records(), [])
        self.assertFalse(memory.exploration_status()["complete"])
        self.assertEqual([exit["completed"] for exit in memory.exits(arrival, road(180, 90))],
                         [False, False])
        self.assertGreater(memory.exploration_status()["unresolved_node_count"], 0)
        self.assertIsNone(memory.active_exit)

    def test_stationary_heading_updates_without_motion_do_not_complete_exit(self):
        memory = self.start_exit()

        for heading in (90, 180, -90, 0):
            memory.update(odometry(heading_deg=heading), road(-heading))

        self.assertEqual(memory.traversal_records(), [])
        self.assertFalse(memory.exploration_status()["complete"])
        self.assertIsNone(memory.active_exit)

        memory.update(odometry(forward_cm=25), road(180))
        self.assertEqual(memory.traversal_records(), [])
        self.assertFalse(memory.exploration_status()["complete"])

    def test_curved_position_updates_without_motion_cannot_complete_a_reverse(self):
        memory = self.start_exit()
        memory.update(odometry(forward_cm=40), road(at_node=False))

        # The final motion is rightward. The origin-to-arrival chord points
        # diagonally, and the robot's current heading is different again.
        arrival = odometry(right_cm=40, forward_cm=40, heading_deg=45)
        memory.update(arrival, road(45, 90, -45, error=45))

        self.assertEqual([exit["completed"] for exit in memory.exits(arrival, road(45, 90, -45))],
                         [False, False, False])
        self.assertEqual(memory.traversal_records(), [])
        self.assertFalse(memory.exploration_status()["complete"])

    def test_stationary_arrival_does_not_upgrade_unverified_position_history(self):
        memory = self.start_exit()
        memory.update(odometry(forward_cm=40), road(at_node=False))
        memory.update(odometry(right_cm=40, forward_cm=40), road(at_node=False, error=-90))

        # A turn or a repeated frame must not replace the rightward movement
        # with an artificial zero-length segment bearing.
        arrival = odometry(right_cm=40, forward_cm=40, heading_deg=45)
        memory.update(arrival, road(at_node=False))
        memory.update(arrival, road(45, 90, -45))

        self.assertEqual([exit["completed"] for exit in memory.exits(arrival, road(45, 90, -45))],
                         [False, False, False])


    def test_full_public_direct_traversal_completes_only_its_departure_exit(self):
        trace = SensorTrace()
        trace.publish(0, 0, absolute_exits=(0,))
        params = trace.select(0)
        trace.publish(0, 25, travelled=25, absolute_exits=(180, 90),
                      method="take_exit", params=params,
                      result={"accepted": True, "stoppedBy": "junction"})
        evidence = trace.evidence()
        self.assertEqual(len(evidence["traversals"]), 1)
        self.assertEqual(exit_at(evidence, 1, 0)["state"], "verified")
        self.assertNotEqual(exit_at(evidence, 2, 180)["state"], "verified")
        self.assertEqual(trace.roads.exploration_status()["pending_exit_count"], 2)

    def test_full_public_curved_traversal_preserves_its_motion_and_direction(self):
        trace = SensorTrace()
        trace.publish(0, 0, absolute_exits=(0,))
        params = trace.select(0)
        trace.publish(0, 40, travelled=40, method="take_exit", params=params)
        trace.publish(40, 40, heading=-90, travelled=90, absolute_exits=(90, 135, 0),
                      method="follow_road", params={"distanceCm": 50})
        evidence = trace.evidence()
        self.assertEqual(exit_at(evidence, 1, 0)["state"], "verified")
        self.assertNotEqual(exit_at(evidence, 3, 90)["state"], "verified")
        self.assertEqual(evidence["traversals"][0]["observation_indices"], [1, 2, 3])
        self.assertEqual(len(evidence["traversals"][0]["motion_refs"]), 2)


if __name__ == "__main__":
    unittest.main()
