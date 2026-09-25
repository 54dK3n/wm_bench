"""Read-only reproduction from archived Run14 public brain sensor/state logs."""
import copy
import json
from pathlib import Path

import pytest

from autonomous_brain.navigation import RoadMemory, distance, position


ROOT = Path(__file__).resolve().parents[4]
BRAIN = ROOT / "artifacts/autonomous-brain/map05-run-14/map-05-run-1/brain"


def test_actual_run14_sensor_frames_select_and_mutate_the_nearest_saved_node():
    observations = {}
    with (BRAIN / "observations.jsonl").open() as stream:
        for line in stream:
            row = json.loads(line)
            index = row["observation_index"]
            if index in {161, 162, 163, 164}:
                observations[index] = {key: copy.deepcopy(row[key])
                    for key in ("observation_index", "round", "odometry", "road")}
            if index >= 164:
                break
    with (BRAIN / "rounds.jsonl").open() as stream:
        for line in stream:
            row = json.loads(line)
            if row["round"] == 27:
                saved_history = copy.deepcopy(row["state"]["junction_history"])
                break
    with (BRAIN / "motions.jsonl").open() as stream:
        for line in stream:
            row = json.loads(line)
            if row["before_observation"] == 164:
                recorded_motion = row
                break

    assert sorted(observations) == [161, 162, 163, 164]
    assert recorded_motion["round"] == 27
    assert recorded_motion["method"] == "take_exit"
    assert recorded_motion["params"]["angleDeg"] == 0
    memory = RoadMemory()
    # This is the junction history the brain actually supplied to the model,
    # not platform road IDs or a reconstructed physical road graph.
    memory.nodes = [{"id": node["id"],
                     "position": (node["position_m"]["x"], node["position_m"]["z"]),
                     "exits": copy.deepcopy(node["exits"])} for node in saved_history]
    nodes = {node["id"]: node for node in memory.nodes}
    earlier, nearest = nodes["junction-9"], nodes["junction-10"]
    before_earlier = copy.deepcopy(earlier)
    assert distance(position(observations[161]["odometry"]), earlier["position"]) * 100 == pytest.approx(12.9402472939)
    assert distance(position(observations[161]["odometry"]), nearest["position"]) * 100 == pytest.approx(12.5027996865)

    observed_trace = []
    for index, row in observations.items():
        odo, road = row["odometry"], row["road"]
        memory.update(odo, road)
        assert len(memory.nodes) == len(saved_history)
        assert memory.current_node(odo) is nearest
        selected = next(exit for exit in memory.exits(odo, road)
                        if abs(exit["heading_deg"] - (-68.8)) < 1e-6)
        assert selected["visits"] == 0
        assert selected["blocked"] is False
        assert selected["completed"] is False
        observed_trace.append({"observation_index": index, "tick": odo["tick"],
                               "located_node": nearest["id"], "exit": selected})

    memory.chosen(observations[164]["odometry"], recorded_motion["params"]["angleDeg"])
    assert memory.active_exit["node"] is nearest
    chosen = memory.active_exit["exit"]
    assert chosen["heading_deg"] == pytest.approx(-68.8)
    assert chosen["visits"] == 1
    assert chosen["blocked"] is False
    assert chosen["completed"] is False
    assert earlier == before_earlier
    # No movement was replayed or invented: selection only spends a visit.
    assert memory.unexplored() == sum(not exit["completed"] and not exit["blocked"]
                                     for node in saved_history for exit in node["exits"])
    print(json.dumps({"source": str(BRAIN.relative_to(ROOT)),
                      "updates_and_lookups": observed_trace,
                      "recorded_motion_before_observation": 164,
                      "chosen_node": memory.active_exit["node"]["id"],
                      "chosen_heading_deg": chosen["heading_deg"],
                      "earlier_node_unchanged": earlier == before_earlier,
                      "node_count_unchanged": len(memory.nodes) == len(saved_history)},
                     sort_keys=True))
