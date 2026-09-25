"""Recompute a fixed public Run21 prefix, without simulator or hidden inputs.

Reads exact raw-line prefixes, verifies their hashes before/after, and writes only
the diagnostic JSON in this directory. Historical node anchors remain immutable.
"""
from __future__ import annotations

import collections
import copy
import hashlib
import json
import math
from pathlib import Path
import sys
import types

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
MANIFEST = json.loads((HERE / "input-manifest.json").read_text())


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_inputs():
    rows = {}
    for name, info in MANIFEST["inputs"].items():
        with (ROOT / info["path"]).open("rb") as handle:
            lines = [handle.readline() for _ in range(info["line_count"])]
        assert all(line.endswith(b"\n") for line in lines)
        raw = b"".join(lines)
        assert len(raw) == info["byte_count"] and sha(raw) == info["sha256"]
        rows[name] = [json.loads(line) for line in lines]
    return rows


def geometry(nodes):
    return [(n["id"], n["position_m"], [e["heading_deg"] for e in n["exits"]]) for n in nodes]


def context_angles_match(a, b):
    if a is None or b is None:
        return False
    left, right = a["fresh_headings_deg"], b["fresh_headings_deg"]
    return bool(left) and len(left) == len(right) and all(
        sum(abs(nav.wrap(x - y)) <= 5 for y in right) == 1 for x in left
    ) and all(sum(abs(nav.wrap(x - y)) <= 5 for x in left) == 1 for y in right)


source_info = MANIFEST["frozen_navigation"]
source = (HERE / source_info["path"]).read_bytes()
assert sha(source) == source_info["sha256"]
nav = types.ModuleType("frozen_navigation_v5")
exec(compile(source, source_info["path"], "exec"), nav.__dict__)


def main():
    data = read_inputs()
    observations, rounds, motions = data["observations"], data["rounds"], data["motions"]
    assert [r["round"] for r in rounds] == list(range(1, 139))
    assert [o["observation_index"] for o in observations] == list(range(1, 894))
    assert all(o["round"] <= 138 for o in observations)
    assert all(m["round"] <= 138 and m["after_observation"] <= 893 for m in motions)
    assert rounds[-1]["result"]["evidence"]["final_observation"] == 893
    by_index = {o["observation_index"]: o for o in observations}
    before = {m["before_observation"]: m for m in motions}
    after = {m["after_observation"]: m for m in motions}
    assert len(before) == len(after) == len(motions)
    first = {}
    for o in observations:
        first.setdefault(o["round"], o["observation_index"])
    decision_at = {first[r["round"]]: r for r in rounds}
    memory, old = nav.RoadMemory(), nav._BreadcrumbMemory()
    anchors, queries, remaps, old_equal = {}, {}, {}, 0
    compact_keys = {"kind", "target_node_id", "target_exit_index", "target_heading_deg",
                    "next_exit_angle_deg", "recorded_travelled_cm", "cost_basis", "traversal_ids",
                    "target_anchor_gap_cm", "requires_fresh_arrival_and_exit_recheck"}
    for o in observations:
        i = o["observation_index"]
        old.update(o["odometry"], o["road"])
        memory.update(o["odometry"], o["road"], observation_index=i)
        memory.observe_traversal(o, after.get(i))
        anchors[i] = memory.observation_anchor(i)
        if i in decision_at:
            r = decision_at[i]
            # Original action callbacks are not guessed. Restore only these
            # three original flags at each decision, after checking geometry.
            for store in (old, memory):
                assert geometry(store.summary()) == geometry(r["state"]["junction_history"])
                for node, saved in zip(store.nodes, r["state"]["junction_history"]):
                    for e, se in zip(node["exits"], saved["exits"]):
                        for field in ("visits", "completed", "blocked"):
                            e[field] = se[field]
                assert store.unexplored() == r["state"]["unexplored_exit_count"]
            stable = copy.deepcopy(memory.__dict__)
            hints = memory.frontier_hints(o["odometry"], o["road"], observation_index=i)
            assert memory.__dict__ == stable
            assert [{k: v for k, v in h.items() if k in compact_keys} for h in hints] == r["state"]["exploration_hints"]
            assert all(h["next_exit_angle_deg"] in [e["angleDeg"] for e in o["road"]["exits"]] for h in hints)
            queries[r["round"]] = hints
            remaps[r["round"]] = {}
            for t in memory.traversal_records():
                original = t["arrival"]
                current = memory.current_node(by_index[original["observation_index"]]["odometry"])
                remaps[r["round"]][t["trip_id"]] = current["id"] if current else None
        if i in before and before[i]["method"] == "take_exit":
            angle = before[i]["params"]["angleDeg"]
            old.chosen(o["odometry"], angle)
            memory.chosen(o["odometry"], angle, observation_index=i)
        assert old.__dict__ == {key: getattr(memory, key) for key in old.__dict__}
        old_equal += 1
    trips = {t["trip_id"]: t for t in memory.traversal_records()}

    def obs(i):
        o, a = by_index[i], anchors[i]
        return {"observation_index": i, "round": o["round"], "odometry": o["odometry"],
                "on_road": o["road"].get("onRoad"), "at_node": o["road"].get("atNode"),
                "fresh_exits": o["road"].get("exits"), "anchor": a}

    def comparison(expected, actual):
        return {"actual_anchor": actual, "same_node": actual is not None and expected["node_id"] == actual["node_id"],
                "position_gap_cm": math.dist(expected["position_m"], actual["position_m"]) * 100 if actual else None,
                "full_heading_context_matches": context_angles_match(expected, actual),
                "frozen_same_context_exact": actual is not None and nav.same_context(expected, actual)}

    cross_bucket = []
    for i in range(1, 893):
        a, b = anchors[i], anchors[i + 1]
        if a and b and a["node_id"] != b["node_id"] and context_angles_match(a, b):
            cross_bucket.append({"before": obs(i), "after": obs(i + 1), "motion": after.get(i + 1),
                "pose_gap_cm": math.dist(a["position_m"], b["position_m"]) * 100,
                "odometer_delta_cm": b["odometer_cm"] - a["odometer_cm"]})
    assert len(cross_bucket) == 1 and cross_bucket[0]["before"]["observation_index"] == 141
    recorded = [(r, h) for r, hs in queries.items() for h in hs if h["kind"] == "recorded_directed_route"]
    trace = []
    for r in rounds[114:122]:
        number = r["round"]
        actual_motions = [m for m in motions if m["round"] == number]
        departures = [m for m in actual_motions if m["method"] == "take_exit"]
        assert len(departures) <= 1
        departure = departures[0] if departures else None
        start = by_index[first[number]]
        effective_angle = nav.wrap(by_index[departure["before_observation"]]["odometry"]["headingDeg"]
                                   + departure["params"]["angleDeg"] - start["odometry"]["headingDeg"]) if departure else None
        matched = [h for h in queries[number] if h["kind"] == "recorded_directed_route"
                   and effective_angle is not None and abs(nav.wrap(h["next_exit_angle_deg"] - effective_angle)) < 1e-8]
        final_i = r["result"]["evidence"]["final_observation"]
        comparisons = []
        for h in matched:
            trip = trips[h["traversal_ids"][0]]
            expected = trip["arrival"]
            first_arrivals = [i for i in range(departure["after_observation"], final_i + 1)
                              if anchors[i] and anchors[i]["node_id"] != anchors[departure["before_observation"]]["node_id"]]
            comparisons.append({"hint": h, "first_trip_id": trip["trip_id"],
                "expected_arrival_anchor": expected,
                "historical_arrival_current_node_at_decision": remaps[number][trip["trip_id"]],
                "historical_arrival_current_node_at_next_decision": remaps[number + 1][trip["trip_id"]],
                "first_distinct_arrival_observation": first_arrivals[0] if first_arrivals else None,
                "first_distinct_arrival_comparison": comparison(expected, anchors[first_arrivals[0]]) if first_arrivals else None,
                "action_final_comparison": comparison(expected, anchors[final_i]),
                "next_round_comparison": comparison(expected, anchors[first[number + 1]]),
                "ultimate_target_arrival_at_action_final": nav.same_context(h["arrival_anchor"], anchors[final_i]) if anchors[final_i] else False})
        current_exits = r["state"]["robot"]["exits"]
        trace.append({"round": number, "action": r["action"], "result_reason": r["result"]["reason"],
            "start": obs(first[number]), "final": obs(final_i), "next_round": obs(first[number + 1]),
            "state_unexplored_exit_count": r["state"]["unexplored_exit_count"],
            "current_exits": current_exits, "hints": queries[number], "motions": actual_motions,
            "actual_departure_relative_to_round_start_deg": effective_angle,
            "explicit_angle_omitted": r["action"]["action"] == "explore" and "exit_angle" not in r["action"]["params"],
            "old_automatic_minimum": min(current_exits, key=lambda e: (e["blocked"], e["completed"], e["visits"], abs(e["angle_deg"]))) if current_exits else None,
            "matching_hint_count": len(matched), "selected_first_trip_checks": comparisons})
    followed = [t for t in trace if t["matching_hint_count"]]
    assert [t["round"] for t in followed] == [115, 116, 117, 120]
    assert all(c[k]["frozen_same_context_exact"] for t in followed for c in t["selected_first_trip_checks"]
               for k in ("first_distinct_arrival_comparison", "action_final_comparison", "next_round_comparison"))
    assert all(c["historical_arrival_current_node_at_decision"] == c["expected_arrival_anchor"]["node_id"]
               == c["historical_arrival_current_node_at_next_decision"] for t in followed for c in t["selected_first_trip_checks"])
    assert not any(c["ultimate_target_arrival_at_action_final"] for t in followed for c in t["selected_first_trip_checks"])
    assert trace[3]["actual_departure_relative_to_round_start_deg"] == -180
    assert trace[3]["old_automatic_minimum"]["angle_deg"] == -180 and trace[3]["matching_hint_count"] == 0
    assert trace[7]["actual_departure_relative_to_round_start_deg"] == 90 and trace[7]["matching_hint_count"] == 0
    report = {"version": "run21-public-route-prefix-review/v1", "pass": True,
        "scope": MANIFEST["scope"], "inputs": MANIFEST["inputs"], "frozen_navigation_sha256": sha(source),
        "legacy_fields_equal_observations": old_equal, "geometry_and_original_flags_checked_rounds": len(rounds),
        "original_flags_synchronized": ["visits", "completed", "blocked"],
        "query_purity_and_saved_hints_equal_rounds": len(queries), "recorded_trip_count": len(trips),
        "cross_bucket_adjacent_sampled_node_context_matches": cross_bucket,
        "same_context_sampled_corridor": [obs(i) for i in range(140, 146)],
        "four_exit_node_counterexamples": {"J23_to_J24": [obs(i) for i in range(472, 480)],
            "J23_north_departure": [obs(i) for i in range(547, 554)],
            "J29_arrival": [obs(i) for i in range(637, 644)]},
        "round138_named_nodes": [n for n in rounds[-1]["state"]["junction_history"] if n["id"] in {"junction-23", "junction-24", "junction-29"}],
        "recorded_hint_summary": {"count": len(recorded), "rounds": sorted({r for r, _ in recorded}),
            "targets": dict(collections.Counter(h["target_node_id"] for _, h in recorded)),
            "targets_by_exit": dict(collections.Counter(f'{h["target_node_id"]}/exit-{h["target_exit_index"]}' for _, h in recorded)),
            "no_hints_to_observed_cross_bucket_pair": all(h["target_node_id"] not in {"junction-10", "junction-11"} for _, h in recorded)},
        "round115_122_trace": trace, "selected_hint_rounds": [t["round"] for t in followed],
        "selected_hint_first_trips_all_arrived_exactly": True, "selected_arrival_node_remap_detected": False,
        "selected_hint_ultimate_U_target_reached": False,
        "physical_junction_identity_claim": False, "intersample_at_node_continuity_claim": False,
        "formal_physical_success_claim": False,
        "limitations": ["Consecutive samples do not establish intersample road state or physical junction identity.",
            "Only original visits/completed/blocked flags are synchronized; omitted original callbacks are not inferred.",
            "A matching first traversal does not mean the ultimate U frontier was reached.",
            "Memory U obligations do not independently establish untraveled physical exits."]}
    assert read_inputs() == data
    assert sha((HERE / source_info["path"]).read_bytes()) == source_info["sha256"]
    (HERE / "findings.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    print(json.dumps({k: report[k] for k in ("version", "pass", "legacy_fields_equal_observations",
        "query_purity_and_saved_hints_equal_rounds", "recorded_trip_count", "recorded_hint_summary",
        "selected_hint_rounds", "selected_hint_first_trips_all_arrived_exactly",
        "selected_arrival_node_remap_detected", "selected_hint_ultimate_U_target_reached",
        "physical_junction_identity_claim", "formal_physical_success_claim")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
