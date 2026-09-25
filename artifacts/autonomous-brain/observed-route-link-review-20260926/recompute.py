"""Read-only, offline recomputation from saved public inputs and frozen nav.

Prints JSON to stdout. Does not modify files, issue actions, access credentials,
or import any runtime/bridge/model/network client. The copied nav imports only
math and heapq. No production module is imported.
"""
import copy
import hashlib
import importlib.util
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main():
    manifest = json.loads((HERE / "capture-manifest.json").read_text())
    raw = (HERE / "public-inputs.json").read_bytes()
    assert hashlib.sha256(raw).hexdigest() == manifest["snapshot_sha256"]
    nav_path = HERE / "frozen_navigation.py"
    source = next(row for row in manifest["sources"] if row["path"] == "autonomous_brain/navigation.py")
    assert hashlib.sha256(nav_path.read_bytes()).hexdigest() == source["sha256"]
    spec = importlib.util.spec_from_file_location("frozen_review_navigation", nav_path)
    nav = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(nav)
    data = json.loads(raw)
    checks = {}

    def check(name, value):
        checks[name] = bool(value)
        assert value, name

    def index(rows, key):
        return {row[key]: row for row in rows}

    def seed(state):
        result = nav.RoadMemory()
        result.nodes = [{"id": n["id"], "position": (n["position_m"]["x"], n["position_m"]["z"]),
                         "exits": copy.deepcopy(n["exits"])} for n in state["junction_history"]]
        return result

    def node(state, name):
        return next(row for row in state["junction_history"] if row["id"] == name)

    def headings(observation):
        return [round(nav.wrap(observation["odometry"]["headingDeg"] + e["angleDeg"]), 1)
                for e in observation["road"]["exits"]]

    def signatures(memory):
        return [{"id": n["id"], "position_m": {"x": round(n["position"][0], 3), "z": round(n["position"][1], 3)},
                 "headings": [round(e["heading_deg"], 1) for e in n["exits"]]} for n in memory.nodes]

    o18 = index(data["run18"]["road_observations_through_851"], "observation_index")
    r18 = index(data["run18"]["rounds"], "round")
    memory = nav.RoadMemory()
    for observation in o18.values():
        memory.update(observation["odometry"], observation["road"])
    state = r18[126]["state"]
    check("run18_rebuilt_node_geometry_equals_saved_state126", signatures(memory) == signatures(seed(state)))
    before_query = copy.deepcopy(memory.__dict__)
    candidates = []
    for n in state["junction_history"]:
        pending = [e["heading_deg"] for e in n["exits"] if not e["completed"] and not e["blocked"]]
        if not pending:
            continue
        p = n["position_m"]
        path = memory.route_to(o18[851]["odometry"], (p["x"], p["z"]))
        if path:
            candidates.append({"node_id": n["id"], "pending_headings_deg": pending,
                               "recorded_graph_chord_weight_cm": sum(math.dist(a, b) for a, b in zip(path, path[1:])) * 100,
                               "path_m": path, "endpoint_gap_cm": math.dist(path[-1], (p["x"], p["z"])) * 100})
    candidates.sort(key=lambda row: (row["recorded_graph_chord_weight_cm"], row["node_id"]))
    check("readonly_route_query_does_not_mutate_memory", before_query == memory.__dict__)
    check("r126_has_only_completed_current_exits_but_pending_history", state["unexplored_exit_count"] == 29 and
          all(e["completed"] for e in state["robot"]["exits"]))
    nearest = candidates[0]
    check("nearest_recorded_graph_candidate_is_junction16", nearest["node_id"] == "junction-16")
    chord = nav.heading_to(*nearest["path_m"][:2])
    relative = nav.wrap(chord - state["robot"]["pose"]["heading_deg"])
    fresh = state["robot"]["exit_angles"]
    chord_matches = [a for a in fresh if abs(nav.wrap(a - relative)) <= 5]
    motion = next(row for row in data["run18"]["motions"] if row["after_observation"] == 738)
    departure = nav.wrap(o18[737]["odometry"]["headingDeg"] + motion["params"]["angleDeg"])
    departure_relative = nav.wrap(departure - state["robot"]["pose"]["heading_deg"])
    departure_matches = [a for a in fresh if abs(nav.wrap(a - departure_relative)) <= 5]
    check("chord_has_no_fresh_exit_match_under_existing_5deg_gate", chord_matches == [])
    check("recorded_departure_has_one_fresh_exit_match", len(departure_matches) == 1 and departure_matches[0] == -89.9)
    check("first_graph_edge_is_actual737_to738_endpoints", all(math.dist(p, nav.position(o18[i]["odometry"])) < 1e-10
          for p, i in zip(nearest["path_m"][:2], (737, 738))))
    check("historical_motion_is_take_exit_zero_relative", motion["method"] == "take_exit" and motion["params"]["angleDeg"] == 0)
    check("chord_length_is_not_travel_distance", abs(math.dist(*nearest["path_m"][:2]) * 100 - motion["actuator_result"]["distanceCm"]) > 1)

    o19 = index(data["run19"]["observations"], "observation_index")
    r19 = index(data["run19"]["rounds"], "round")
    merge = seed(r19[104]["state"])
    chosen = merge.current_node(o19[681]["odometry"])
    p681 = nav.position(o19[681]["odometry"])
    gaps = {n["id"]: math.dist(p681, n["position"]) * 100 for n in merge.nodes if n["id"] in ("junction-18", "junction-5")}
    old_headings = [e["heading_deg"] for e in chosen["exits"]]
    check("obs681_nearest_within_15cm_is_existing_junction18", chosen["id"] == "junction-18" and gaps["junction-18"] < 15)
    check("junction5_with_matching_signature_is_outside_15cm", gaps["junction-5"] >= 15)
    merge.update(o19[681]["odometry"], o19[681]["road"])
    updated = next(n for n in merge.nodes if n["id"] == "junction-18")
    saved105 = node(r19[105]["state"], "junction-18")
    check("mixed_node_six_headings_match_saved105", len(updated["exits"]) == 6 and
          [round(e["heading_deg"], 1) for e in updated["exits"]] == [e["heading_deg"] for e in saved105["exits"]])
    final18 = next(e for e in node(r19[163]["state"], "junction-18")["exits"] if e["heading_deg"] == -90)
    check("junction18_old_minus90_still_pending_in_r163", final18["visits"] == 0 and not final18["completed"] and not final18["blocked"])
    check("old_minus90_not_present_in_obs681_to684", all(not any(abs(nav.wrap(h + 90)) < 15 for h in headings(o19[i]))
          for i in (681, 682, 683, 684)))

    split = seed(r19[86]["state"])
    p556 = nav.position(o19[556]["odometry"])
    before = split.current_node(o19[556]["odometry"])
    old24 = next(n for n in split.nodes if n["id"] == "junction-24")
    gap = math.dist(p556, old24["position"]) * 100
    split.update(o19[556]["odometry"], o19[556]["road"])
    new25 = split.current_node(o19[556]["odometry"])
    check("obs556_outside_existing_node_gate_creates_junction25", before is None and gap >= 15 and new25["id"] == "junction-25")
    h523, h556 = headings(o19[523]), headings(o19[556])
    differences = [min(abs(nav.wrap(a - b)) for b in h556) for a in h523]
    check("two_fresh_three_exit_signatures_differ_at_most_point1deg", len(h523) == len(h556) == 3 and max(differences) <= .1000001)
    split_pending = []
    for name, angle in (("junction-24", 125.5), ("junction-25", 125.6)):
        entry = next(e for e in node(r19[163]["state"], name)["exits"] if e["heading_deg"] == angle)
        split_pending.append({"node_id": name, **entry})
    check("both_similar125deg_entries_still_pending", all(e["visits"] == 0 and not e["completed"] and not e["blocked"] for e in split_pending))
    crossing = next(m for m in data["run18"]["motions"] if m["after_observation"] == 2)
    check("sampled_atnode_true_does_not_identify_one_junction", o18[1]["road"]["atNode"] and o18[2]["road"]["atNode"]
          and headings(o18[1]) != headings(o18[2]) and crossing["actuator_result"]["distanceCm"] == 25)

    result = {"schema": "observed-route-link-review/v1", "verification_status": "PASS",
              "meaning": "Historical code/log assertions reproduced; no navigation fix, recovery, physical-identity equivalence, U retirement, or formal-run PASS is asserted.",
              "frozen_commit": manifest["frozen_commit"], "frozen_navigation_sha256": source["sha256"],
              "public_snapshot_sha256": manifest["snapshot_sha256"], "checks": checks, "checks_passed": len(checks),
              "run18_chord_counterexample": {"decision_round": 126, "observation_index": 851,
                  "current_heading_deg": state["robot"]["pose"]["heading_deg"], "current_fresh_relative_exits": fresh,
                  "unexplored_exit_count": state["unexplored_exit_count"], "nearest_candidate": nearest,
                  "chord_absolute_heading_deg": chord, "chord_relative_heading_deg": relative,
                  "chord_fresh_matches_within5deg": chord_matches, "historical_departure_motion": motion,
                  "historical_departure_absolute_heading_deg": departure,
                  "historical_departure_relative_at_r126_deg": departure_relative,
                  "departure_fresh_matches_within5deg": departure_matches,
                  "first_edge_chord_length_cm": math.dist(*nearest["path_m"][:2]) * 100,
                  "historical_motion_distance_cm": motion["actuator_result"]["distanceCm"],
                  "interpretation": "Graph chord direction is not the observed departure exit; graph chord cost is not actual travelled length."},
              "run19_mixed_view_node": {"created_at_observation": 332, "later_observation": 681,
                  "node_id": "junction-18", "distance_to_node_centres_cm": gaps,
                  "original_headings_deg": old_headings, "fresh681_headings_deg": headings(o19[681]),
                  "saved105_headings_deg": [e["heading_deg"] for e in saved105["exits"]],
                  "r163_pending_old_entry": final18,
                  "interpretation": "One spatial bucket contains different local exit sets; this does not prove that an old exit physically does not exist."},
              "run19_similar_node_candidates": {"observation_indexes": [523, 556], "node_ids": ["junction-24", "junction-25"],
                  "node_centre_gap_cm": gap, "fresh_absolute_headings_deg": [h523, h556],
                  "nearest_heading_differences_deg": differences, "r163_pending_entries": split_pending,
                  "interpretation": "Similar observed signatures and proximity are not physical-identity proof; neither obligation may be automatically cleared."},
              "sampled_node_continuity_counterexample": {"observations": [1, 2], "both_at_node": True,
                  "fresh_absolute_headings_deg": [headings(o18[1]), headings(o18[2])], "motion": crossing,
                  "interpretation": "Two endpoint samples with atNode=true do not establish continuous-time residence in one junction."},
              "safety_scope": {"action_calls": 0, "network_calls": 0, "production_imports": 0,
                               "truth_or_layout_inputs": 0, "changed_thresholds": [], "completion_obligations_removed": 0}}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
