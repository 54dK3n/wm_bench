import unittest

from autonomous_brain.navigation import RoadMemory


def odometry(right_cm=0, forward_cm=0, heading_deg=0):
    return {"rightCm": right_cm, "forwardCm": forward_cm, "headingDeg": heading_deg}


def road(*angles, at_node=True, error=0):
    return {"onRoad": True, "atNode": at_node, "headingErrorDeg": error,
            "exits": [{"angleDeg": angle} for angle in angles]}


class RoadMemoryTraversalTests(unittest.TestCase):
    def start_exit(self):
        memory = RoadMemory()
        memory.update(odometry(), road(0))
        memory.chosen(odometry(), 0)
        return memory

    def test_direct_node_to_node_completes_forward_and_reverse_exits(self):
        memory = self.start_exit()

        # One action reaches the next node; no atNode=False frame is available.
        arrival = odometry(forward_cm=25)
        memory.update(arrival, road(180, 90))

        self.assertTrue(memory.nodes[0]["exits"][0]["completed"])
        self.assertEqual([exit["completed"] for exit in memory.exits(arrival, road(180, 90))],
                         [True, False])
        self.assertEqual(memory.unexplored(), 1)
        self.assertIsNone(memory.active_exit)

    def test_stationary_turns_at_origin_do_not_complete_or_discard_exit(self):
        memory = self.start_exit()

        for heading in (90, 180, -90, 0):
            memory.update(odometry(heading_deg=heading), road(-heading))

        self.assertEqual(len(memory.nodes), 1)
        self.assertFalse(memory.nodes[0]["exits"][0]["completed"])
        self.assertEqual(memory.unexplored(), 1)
        self.assertIsNotNone(memory.active_exit)
        self.assertFalse(memory.active_exit["departed"])

        memory.update(odometry(forward_cm=25), road(180))
        self.assertEqual(memory.unexplored(), 0)

    def test_curved_route_reverse_uses_final_observed_segment(self):
        memory = self.start_exit()
        memory.update(odometry(forward_cm=40), road(at_node=False))

        # The final motion is rightward. The origin-to-arrival chord points
        # diagonally, and the robot's current heading is different again.
        arrival = odometry(right_cm=40, forward_cm=40, heading_deg=45)
        memory.update(arrival, road(45, 90, -45, error=45))

        self.assertEqual([exit["completed"] for exit in memory.exits(arrival, road(45, 90, -45))],
                         [True, False, False])
        self.assertTrue(memory.nodes[0]["exits"][0]["completed"])

    def test_stationary_arrival_observation_preserves_last_movement_direction(self):
        memory = self.start_exit()
        memory.update(odometry(forward_cm=40), road(at_node=False))
        memory.update(odometry(right_cm=40, forward_cm=40), road(at_node=False, error=-90))

        # A turn or a repeated frame must not replace the rightward movement
        # with an artificial zero-length segment bearing.
        arrival = odometry(right_cm=40, forward_cm=40, heading_deg=45)
        memory.update(arrival, road(at_node=False))
        memory.update(arrival, road(45, 90, -45))

        self.assertEqual([exit["completed"] for exit in memory.exits(arrival, road(45, 90, -45))],
                         [True, False, False])


if __name__ == "__main__":
    unittest.main()
