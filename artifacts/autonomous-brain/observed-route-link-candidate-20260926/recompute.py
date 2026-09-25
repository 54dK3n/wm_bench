"""Offline candidate verification from fixed public snapshots; stdout only."""
import copy
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path

import candidate_navigation as nav

HERE = Path(__file__).resolve().parent


def read(name):
    return json.loads((HERE / name).read_text())


def sha(name):
    return hashlib.sha256((HERE / name).read_bytes()).hexdigest()


def feed(memory, row):
    memory.update(row["odometry"], row["road"], observation_index=row["observation_index"])


def seed(state):
    memory = nav.RoadMemory()
    memory.nodes = [{"id": n["id"], "position": (n["position_m"]["x"], n["position_m"]["z"]),
                     "exits": copy.deepcopy(n["exits"])} for n in state["junction_history"]]
    return memory


def geometry(nodes):
    return [(n["id"], n["position_m"], [e["heading_deg"] for e in n["exits"]]) for n in nodes]


def synchronize_logged_flags(memory, state):
    assert geometry(memory.summary()) == geometry(state["junction_history"])
    for node, saved in zip(memory.nodes, state["junction_history"]):
        for e, original in zip(node["exits"], saved["exits"]):
            for field in ("visits", "completed", "blocked"):
                e[field] = original[field]
    assert memory.unexplored() == state["unexplored_exit_count"]


def query(memory, row):
    before = (memory.summary(), memory.unexplored(), memory.traversal_records())
    hints = memory.frontier_hints(row["odometry"], row["road"], row["observation_index"])
    assert before == (memory.summary(), memory.unexplored(), memory.traversal_records())
    assert len(hints) <= 3
    for h in hints:
        matches = [e["angleDeg"] for e in row["road"]["exits"]
                   if abs(nav.wrap(e["angleDeg"] - h["next_exit_angle_deg"])) <= 5]
        assert len(matches) == 1
    return hints


def historical_checks(data):
    positive = []
    for run in ("run18", "run19"):
        observations = data[run].get("road_observations_through_851", data[run].get("observations"))
        first = {r["observation_index"]: r for r in observations}
        m = next(m for m in data[run]["motions"] if m["before_observation"] == 1)
        memory = nav.RoadMemory(); feed(memory, first[1])
        memory.chosen(first[1]["odometry"], m["params"]["angleDeg"], observation_index=1)
        feed(memory, first[2]); result = memory.record_completed_traversal([first[1], first[2]], [m])
        assert result["recorded"] and result["trip"]["travelled_cm"] == 25
        positive.append({"run": run, "window": [1, 2], "departure": result["trip"]["departure"],
                         "arrival": result["trip"]["arrival"], "travelled_cm": 25,
                         "motion_result": m["actuator_result"]})

    r18 = {r["round"]: r for r in data["run18"]["rounds"]}
    o18 = {r["observation_index"]: r for r in data["run18"]["road_observations_through_851"]}
    motions = {m["before_observation"]: m for m in data["run18"]["motions"]}
    memory = nav.RoadMemory(); record_results = {}
    for i, row in o18.items():
        feed(memory, row)
        if i in motions:
            memory.chosen(row["odometry"], motions[i]["params"]["angleDeg"], observation_index=i)
        if i in (2, 738):
            record_results[i] = memory.record_completed_traversal([o18[i - 1], row], [motions[i - 1]])
    synchronize_logged_flags(memory, r18[126]["state"])
    target = next(n for n in memory.nodes if n["id"] == "junction-16")
    path = memory.route_to(o18[851]["odometry"], target["position"])
    chord = nav._base.heading_to(*path[:2])
    heading = o18[851]["odometry"]["headingDeg"]
    fresh = [e["angleDeg"] for e in o18[851]["road"]["exits"]]
    old_angle = nav.wrap(chord - heading)
    departure = nav.wrap(o18[737]["odometry"]["headingDeg"] + motions[737]["params"]["angleDeg"])
    correct = nav.wrap(departure - heading)
    wrong_matches = [a for a in fresh if abs(nav.wrap(a - old_angle)) <= 5]
    actual_matches = [a for a in fresh if abs(nav.wrap(a - correct)) <= 5]
    assert not wrong_matches and actual_matches == [-89.9]
    assert record_results[738]["status"] == "pending"
    hints = query(memory, o18[851]); assert hints == []

    o19 = {o["observation_index"]: o for o in data["run19"]["observations"]}
    final = next(r["state"] for r in data["run19"]["rounds"] if r["round"] == 163)
    mixed = seed(final); feed(mixed, o19[332]); feed(mixed, o19[681])
    before = mixed.unexplored(); mixed_hints = query(mixed, o19[681])
    old = next(e for n in mixed.nodes if n["id"] == "junction-18" for e in n["exits"] if e["heading_deg"] == -90)
    assert old == {"heading_deg": -90.0, "visits": 0, "completed": False, "blocked": False}
    assert not any(h["target_heading_deg"] == -90 for h in mixed_hints)
    assert not nav.same_context(mixed._frame_anchors[332], mixed._frame_anchors[681], exact_position=False)
    split = seed(final); feed(split, o19[523]); first_hints = query(split, o19[523])
    feed(split, o19[556]); second_hints = query(split, o19[556])
    assert split._frame_anchors[523]["node_id"] == "junction-24"
    assert split._frame_anchors[556]["node_id"] == "junction-25"
    assert not nav.same_context(split._frame_anchors[523], split._frame_anchors[556], exact_position=False)
    assert split.unexplored() == before == final["unexplored_exit_count"]
    return {"real_completed_window_examples": positive,
            "run18_chord_counterexample": {"round": 126, "observation_index": 851,
                "chord_relative_angle_deg": old_angle, "chord_fresh_matches": wrong_matches,
                "actual_departure_absolute_deg": departure, "actual_departure_relative_deg": correct,
                "actual_departure_fresh_matches": actual_matches,
                "first_edge_chord_cm": math.dist(*path[:2]) * 100,
                "public_odometer_delta_cm": o18[738]["odometry"]["distanceCm"] - o18[737]["odometry"]["distanceCm"],
                "record_737_738": record_results[738], "candidate_hints": hints,
                "limitation": "obs738 is not a node; no completed connection or extra motion was invented"},
            "run19_mixed_and_similar_memory": {"unexplored_before_after": [before, split.unexplored()],
                "mixed_anchor_observations": [332, 681], "mixed_query_hints": mixed_hints,
                "old_minus90_retained": old, "similar_node_ids": ["junction-24", "junction-25"],
                "similar_queries": [first_hints, second_hints], "aliases_created": 0}}


def run20_coverage(data):
    memory = nav.RoadMemory(); by_after = defaultdict(list); by_before = defaultdict(list)
    for m in data["motions"]:
        by_before[m["before_observation"]].append(m); by_after[m["after_observation"]].append(m)
    first = {}
    for row in data["observations"]:
        first.setdefault(row["round"], row["observation_index"])
    rounds_at = {first[r["round"]]: r for r in data["rounds"]}
    window, completed, rejected, queried, eligible = None, [], [], [], []
    def close(reason=None):
        nonlocal window
        span = {"start_observation": window["observations"][0]["observation_index"],
                "end_observation": window["observations"][-1]["observation_index"],
                "start_round": window["observations"][0]["round"],
                "end_round": window["observations"][-1]["round"],
                "motion_count": len(window["motions"]), "observation_count": len(window["observations"]),
                "public_outcome_flags": [{"method": m["method"], "before_observation": m["before_observation"],
                    "after_observation": m["after_observation"],
                    "result": {k: m["actuator_result"][k] for k in ("accepted", "completed", "stoppedBy")
                               if k in m["actuator_result"]}} for m in window["motions"]]}
        if reason:
            rejected.append({**span, "reason": reason})
        else:
            result = memory.record_completed_traversal(window["observations"], window["motions"])
            if result["recorded"]:
                t = result["trip"]
                completed.append({"trip_id": t["trip_id"], "from": t["departure"]["node_id"],
                    "to": t["arrival"]["node_id"], "window": [t["departure"]["observation_index"], t["arrival"]["observation_index"]],
                    "travelled_cm": t["travelled_cm"], "motion_count": len(t["motions"]),
                    "observation_count": len(t["observed_path"])})
            else:
                rejected.append({**span, **result})
        window = None

    for row in data["observations"]:
        i = row["observation_index"]; feed(memory, row)
        if window is not None:
            window["observations"].append(row)
            window["motions"].extend(by_after[i])
            bad = any(m["actuator_result"].get("stoppedBy") in {"collision", "wrong_way", "front_clearance", "off_road"}
                      or m["actuator_result"].get("accepted") is False for m in by_after[i])
            current = memory.observation_anchor(i)
            if any(m["method"] not in {"take_exit", "follow_road", "forward", "backward", "turn"}
                   for m in by_after[i]):
                close("non_road_action_terminates_window")
            elif bad or row["road"].get("onRoad") is not True:
                close()
            elif current and current["node_id"] != window["node_id"]:
                close()
            elif current and window["left_origin"]:
                close("returned_to_origin_before_distinct_arrival")
            elif current is None:
                window["left_origin"] = True
        if i in rounds_at:
            r = rounds_at[i]; synchronize_logged_flags(memory, r["state"])
            hints = query(memory, row)
            entry = {"round": r["round"], "observation_index": i,
                "unexplored_exit_count": memory.unexplored(), "recorded_trips_available": len(memory.traversal_records()),
                "hint_count": len(hints), "hints": hints}
            anchor = memory.observation_anchor(i)
            entry["current_anchor"] = anchor
            entry["same_node_recorded_departures"] = [
                {"trip_id": t["trip_id"], "departure_observation": t["departure"]["observation_index"],
                 "position_gap_cm": math.dist(anchor["position_m"], t["departure"]["position_m"]) * 100,
                 "exact_position_and_context_compatible": nav.same_context(anchor, t["departure"]),
                 "within_15cm_and_context_compatible": nav.same_context(anchor, t["departure"], exact_position=False)}
                for t in memory.traversal_records() if anchor and t["departure"]["node_id"] == anchor["node_id"]]
            queried.append(entry)
            exits = r["state"]["robot"]["exits"]
            if (row["road"].get("onRoad") and row["road"].get("atNode") and exits
                    and all(e["completed"] for e in exits) and memory.unexplored() > 0):
                assert all(h["kind"] == "recorded_directed_route" for h in hints)
                eligible.append(entry)
        for m in by_before[i]:
            if m["method"] != "take_exit":
                continue
            if window is not None:
                close("new_departure_before_window_completion")
            memory.chosen(row["odometry"], m["params"]["angleDeg"], observation_index=i)
            anchor = memory.observation_anchor(i)
            window = {"observations": [row], "motions": [], "node_id": anchor["node_id"] if anchor else None,
                      "left_origin": False}
    if window is not None:
        close("unfinished_at_end_of_public_record")
    return {"scope": "Run20 completed public inputs only; no actions executed; v4 geometry verified at all 200 round starts; logged visits/completed/blocked synchronized at each round start, not inferred from missing action callbacks",
            "rounds": len(data["rounds"]), "observations": len(data["observations"]), "motions": len(data["motions"]),
            "take_exit_windows": sum(m["method"] == "take_exit" for m in data["motions"]),
            "completed_trip_count": len(completed), "completed_trips": completed,
            "rejected_or_unfinished_count": len(rejected), "rejection_reasons": dict(Counter(r["reason"] for r in rejected)),
            "rejected_or_unfinished_windows": rejected,
            "eligible_all_fresh_completed_rounds": len(eligible),
            "eligible_nonempty_hint_rounds": sum(bool(r["hints"]) for r in eligible),
            "eligible_empty_hint_rounds": sum(not r["hints"] for r in eligible),
            "eligible_queries": eligible,
            "requested_rounds_155_156": [r for r in queried if r["round"] in (155, 156)],
            "all_query_rounds_with_hints": [r["round"] for r in queried if r["hints"]],
            "interpretation": "Offline hint coverage only; no claim of improved decisions, convergence, U reduction, physical junction equivalence, or formal success"}


def main():
    manifest = read("input-manifest.json"); run20_manifest = read("run20-input-manifest.json")
    assert sha("baseline_navigation.py") == manifest["baseline_sha256"]
    assert sha("public-inputs.json") == manifest["public_snapshot_sha256"]
    assert sha("run20-public-inputs.json") == run20_manifest["snapshot_sha256"]
    result = {"schema": "observed-directed-route-candidate-evidence/v1", "candidate_only": True,
              "baseline_sha256": sha("baseline_navigation.py"), "candidate_sha256": sha("candidate_navigation.py"),
              "history": historical_checks(read("public-inputs.json")),
              "run20_coverage": run20_coverage(read("run20-public-inputs.json")),
              "production_modified": False, "action_calls": 0, "truth_inputs": 0, "network_calls": 0}
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
