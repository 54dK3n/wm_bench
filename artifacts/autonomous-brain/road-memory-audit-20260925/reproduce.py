#!/usr/bin/env python3
"""Reproduce Run11 road bookkeeping using frozen source and public brain logs only."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
COMMIT = "913474816dbd6271d223cf0cf79366ff668b1e42"
SOURCE = "autonomous_brain/navigation.py"
BRAIN = "artifacts/autonomous-brain/map05-run-11/map-05-run-1/brain"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def rows(name, key):
    path = ROOT / BRAIN / name
    result = {}
    for line in path.read_text().splitlines():
        row = json.loads(line)
        if row.get("round", 0) <= 77:
            result[row[key]] = row
    return result


def main():
    source = subprocess.check_output(["git", "show", f"{COMMIT}:{SOURCE}"], cwd=ROOT)
    scope = {"__name__": "frozen_navigation_audit"}
    exec(compile(source, f"{COMMIT}:{SOURCE}", "exec"), scope)
    rounds = rows("rounds.jsonl", "round")
    observations = rows("observations.jsonl", "observation_index")
    memory = scope["RoadMemory"]()
    memory.nodes = [
        {"id": row["id"], "position": (row["position_m"]["x"], row["position_m"]["z"]),
         "exits": copy.deepcopy(row["exits"])}
        for row in rounds[76]["state"]["junction_history"]
    ]
    before = memory.summary()
    count_before = memory.unexplored()
    origin = observations[409]
    arrival = observations[410]
    memory.chosen(origin["odometry"], 0)
    reverse = scope["heading_to"](scope["position"](arrival["odometry"]), scope["position"](origin["odometry"]))
    headings = [scope["wrap"](arrival["odometry"]["headingDeg"] + e["angleDeg"])
                for e in arrival["road"]["exits"]]
    memory.update(arrival["odometry"], arrival["road"])
    after = memory.summary()
    exact = after == rounds[77]["state"]["junction_history"]
    assert exact, "Frozen source replay differs from the saved next state"
    old = next(n for n in before if n["id"] == "junction-19")
    new = next(n for n in after if n["id"] == "junction-19")
    assert next(e for e in old["exits"] if e["heading_deg"] == -90)["completed"] is False
    assert next(e for e in new["exits"] if e["heading_deg"] == -90)["completed"] is True
    assert all(abs(scope["wrap"](h + 90)) >= 15 for h in headings)
    transitions = []
    for a, b in ((75, 76), (76, 77)):
        left = {n["id"]: n for n in rounds[a]["state"]["junction_history"]}
        right = {n["id"]: n for n in rounds[b]["state"]["junction_history"]}
        transitions.append({"from_state_round": a, "to_state_round": b,
            "node_count_before": len(left), "node_count_after": len(right),
            "unexplored_before": rounds[a]["state"]["unexplored_exit_count"],
            "unexplored_after": rounds[b]["state"]["unexplored_exit_count"],
            "changed_nodes": [{"before": left.get(k), "after": v}
                              for k, v in right.items() if left.get(k) != v]})
    return {
        "schema": "sensor-only-road-memory-reproduction/v1",
        "scope": "Frozen source and recorded public odometry/local_road/brain state; no simulator, network, truth or layout",
        "source_commit": COMMIT, "source_file": SOURCE, "source_sha256": sha(source),
        "inputs": {f"{BRAIN}/{name}": sha((ROOT / BRAIN / name).read_bytes())
                   for name in ("rounds.jsonl", "observations.jsonl", "motions.jsonl")},
        "input_round_limit": 77,
        "replay_operations": ["nodes <- state76.junction_history", "chosen(obs409.odometry, 0)",
                              "update(obs410.odometry, obs410.road)"],
        "full_replayed_junction_history_equals_state77": exact,
        "reverse_heading_deg": reverse,
        "current_observed_absolute_headings_deg": headings,
        "historical_completed_heading_deg": -90,
        "historical_heading_error_to_reverse_deg": abs(scope["wrap"](-90 - reverse)),
        "historical_heading_min_error_to_current_exit_deg": min(abs(scope["wrap"](h + 90)) for h in headings),
        "current_heading_errors_to_reverse_deg": [abs(scope["wrap"](h - reverse)) for h in headings],
        "unexplored_before_replay": count_before, "unexplored_after_replay": memory.unexplored(),
        "transitions": transitions,
        "observations": [{k: observations[i][k] for k in
                          ("observation_index", "round", "simulation_seconds", "odometry", "road")}
                         for i in (389, 391, 402, 403, 404, 405, 406, 409, 410)],
        "source_locations": {"node_selection": "navigation.py:65-73", "reverse_completion": "navigation.py:78-86"},
        "limitations": ["Similar exit signatures and out/back odometry support observation-location fragmentation; they do not prove physical node identity.",
                        "Historical reverse completion is reproduced exactly, but this does not prove the sole cause of Run11 incompletion.",
                        "No source changes or navigation fix are included."],
    }


if __name__ == "__main__":
    json.dump(main(), sys.stdout, ensure_ascii=False, indent=2, allow_nan=False)
    print()
