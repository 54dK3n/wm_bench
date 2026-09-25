"""Consistent nearest-within-15-cm node lookup from sensor-only fixtures.

Querying current exits and choosing one must use the same node as observation
updates. The tests retain strict distance boundaries, insertion-order ties,
and the existing direct-node-to-node traversal completion semantics.
"""
import copy

import pytest

from autonomous_brain.navigation import RoadMemory, distance, position, wrap


def odometry(right_cm=0, forward_cm=0, heading_deg=0):
    return {"rightCm": right_cm, "forwardCm": forward_cm, "headingDeg": heading_deg}


def road(*angles, error=0):
    return {"onRoad": True, "atNode": True, "atJunction": True,
            "headingErrorDeg": error, "exits": [{"angleDeg": angle} for angle in angles]}


def overlapping_run14_anchors():
    # Run14 observations133/145 created junction9/10 respectively. This
    # isolated two-node fixture intentionally renumbers those same anchors.
    memory = RoadMemory()
    original = odometry(-209.3, 116.8, -96.9)
    memory.update(original, road(157.4, 28.1, -52.2, error=-32.9))
    earlier = memory.nodes[0]
    # The r27 input reports the earlier -68.8deg exit as visited+blocked.
    # Establish that state via the normal navigation API, not truth metadata.
    memory.chosen(original, 28.1, blocked=True)
    memory.mark_blocked()
    memory.update(odometry(-187.7, 109.3, 98.5), road(112.4, -38, -167.3))
    nearer = memory.nodes[1]
    current = odometry(-200.1, 107.7, -84.3)  # observations161–163
    observed = road(144.8, 15.5, -64.8, error=15.5)
    memory.update(current, observed)
    assert len(memory.nodes) == 2
    assert distance(position(current), earlier["position"]) * 100 == pytest.approx(12.9402472939)
    assert distance(position(current), nearer["position"]) * 100 == pytest.approx(12.5027996865)
    return memory, earlier, nearer, current, observed


def exit_at(node, heading):
    matches = [e for e in node["exits"] if abs(wrap(e["heading_deg"] - heading)) < 1e-6]
    assert len(matches) == 1
    return matches[0]


def test_current_node_uses_the_nearer_run14_anchor_despite_insertion_order():
    memory, earlier, nearer, current, observed = overlapping_run14_anchors()
    # A synthetic extra sensor exit makes update's destination observable;
    # the original three angles and geometric/angle thresholds are unchanged.
    observed = copy.deepcopy(observed)
    observed["exits"].append({"angleDeg": 84.3})  # absolute0deg
    memory.update(current, observed)
    assert exit_at(nearer, 0)["visits"] == 0
    assert not any(abs(e["heading_deg"]) < 1e-6 for e in earlier["exits"])
    assert memory.current_node(current) is nearer


def test_current_exit_state_comes_from_the_node_receiving_current_observations():
    memory, earlier, nearer, current, observed = overlapping_run14_anchors()
    assert exit_at(earlier, -68.8)["blocked"] is True
    assert exit_at(nearer, -68.8)["blocked"] is False
    seen = next(e for e in memory.exits(current, observed) if e["angle_deg"] == 15.5)
    assert seen["visits"] == 0
    assert seen["blocked"] is False
    assert seen["completed"] is False


def test_chosen_after_run14_stationary_alignment_updates_the_same_nearest_node():
    memory, earlier, nearer, _, _ = overlapping_run14_anchors()
    aligned = odometry(-200.1, 107.7, -68.8)  # observation164
    memory.update(aligned, road(129.3, 0, -80.3))
    before_earlier = copy.deepcopy(earlier)
    memory.chosen(aligned, 0)
    assert memory.active_exit["node"] is nearer
    assert exit_at(nearer, -68.8)["visits"] == 1
    assert earlier == before_earlier
    assert exit_at(nearer, -68.8)["completed"] is False


@pytest.mark.parametrize("reverse_insertion", [False, True])
def test_equal_distance_tie_remains_stable_for_update_lookup_and_selection(reverse_insertion):
    memory = RoadMemory()
    anchors = [odometry(0), odometry(20)]
    if reverse_insertion:
        anchors.reverse()
    for anchor in anchors:
        memory.update(anchor, road(0))
    first, second = memory.nodes
    midpoint = odometry(10)
    memory.update(midpoint, road(0, 90))
    assert memory.current_node(midpoint) is first
    assert exit_at(first, 90)["visits"] == 0
    assert len(second["exits"]) == 1
    memory.chosen(midpoint, 90)
    assert memory.active_exit["node"] is first
    assert exit_at(first, 90)["visits"] == 1
    assert len(memory.nodes) == 2
    assert memory.unexplored() == 3


@pytest.mark.parametrize("right_cm", [15, 15.0001])
def test_original_fifteen_centimetre_boundary_does_not_merge_nodes(right_cm):
    memory = RoadMemory()
    memory.update(odometry(), road(0))
    earlier = memory.nodes[0]
    before = copy.deepcopy(earlier)
    current = odometry(right_cm)
    assert memory.current_node(current) is None
    memory.update(current, road(90))
    assert len(memory.nodes) == 2
    assert memory.current_node(current) is memory.nodes[1]
    assert earlier == before
    assert memory.unexplored() == 2


def test_position_just_inside_original_boundary_reuses_existing_node():
    memory = RoadMemory()
    memory.update(odometry(), road(0))
    earlier = memory.nodes[0]
    current = odometry(14.9999)
    memory.update(current, road(90))
    assert memory.current_node(current) is earlier
    assert len(memory.nodes) == 1
    assert len(earlier["exits"]) == 2


@pytest.mark.parametrize("has_distant_node", [False, True])
def test_no_near_node_returns_none_and_cannot_mutate_another_node(has_distant_node):
    memory = RoadMemory()
    if has_distant_node:
        memory.update(odometry(), road(0))
    before = copy.deepcopy(memory.nodes)
    elsewhere = odometry(100, 100)
    assert memory.current_node(elsewhere) is None
    memory.chosen(elsewhere, 0)
    assert memory.active_exit is None
    assert memory.nodes == before
    assert memory.exits(elsewhere, road(0)) == [{"angle_deg": 0, "heading_deg": 0,
        "visits": 0, "completed": False, "blocked": False}]


def test_direct_node_to_node_observation_still_completes_only_traversed_exits():
    memory = RoadMemory()
    start = odometry()
    memory.update(start, road(0))
    memory.chosen(start, 0)
    # Consecutive atNode=True samples may span a whole segment. A locator fix
    # must not collapse these nodes merely because no False frame was sampled.
    arrival = odometry(forward_cm=25)
    memory.update(arrival, road(180, 90))
    assert len(memory.nodes) == 2
    assert memory.current_node(arrival) is memory.nodes[1]
    assert memory.nodes[0]["exits"][0]["completed"] is True
    assert [e["completed"] for e in memory.exits(arrival, road(180, 90))] == [True, False]
    assert memory.unexplored() == 1
    assert memory.active_exit is None
