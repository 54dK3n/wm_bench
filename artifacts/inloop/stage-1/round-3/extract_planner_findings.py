"""Read-only extraction for PLANNER_FINDINGS.md; never starts a simulator.

Only dijkstra/_vp_path are AST-extracted from the frozen program. Node reads the
platform's public graph projection and road-anchor geometry; no action API runs.
Output is JSON on stdout. No source, log, sample, or report file is rewritten.
"""

import argparse
import ast
from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess


HERE = Path(__file__).resolve().parent
BASE = HERE.parent


def read(round_number, map_number):
    path = BASE / f"round-{round_number}" / f"map-{map_number:02}.json"
    data = json.loads(path.read_text())
    return path, data["lines"]


def events(lines, name, start=0, stop=None):
    return [{"line_index": index, **item} for index, item in enumerate(lines)
            if index >= start and (stop is None or index < stop) and item["event"] == name]


def summarize(round_number, map_number):
    path, lines = read(round_number, map_number)
    confirmed = events(lines, "memory_confirmed")
    start = confirmed[0]["line_index"] + 1 if confirmed else 0
    delivery = events(lines, "delivery_phase_start")
    stop = delivery[0]["line_index"] if delivery else len(lines)
    names = ("memory_confirmed", "wm_targets", "viewpoint_direction_blocked",
             "approach_memory_stop", "approach_graph_memory_distance",
             "approach_min_distance_failed", "viewpoint_progress_replan",
             "approach_graph_rejected", "grab_step", "flow_end")
    report = json.loads((path.parent / "stage_report.json").read_text())
    row = next(item for item in report["runs"] if item["map"] == f"map-{map_number:02}")
    return {
        "source": str(path.relative_to(BASE)),
        "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "report_fields": {key: row.get(key) for key in
                          ("ball", "wm_final_err_cm", "grabs", "grabbed", "mission",
                           "platform_program_error_count", "grab_attempts")},
        "post_confirmation_pre_delivery_counts": dict(Counter(
            item["event"] for item in lines[start:stop])),
        "events": {name: events(lines, name) for name in names},
    }


def pure_path_checks(core_path):
    # Reproduce public map_graph and the same nearest-road anchor rule used by
    # mission(). Sample truth is diagnostic input only, not planner input/code.
    sample_file = HERE / "map-02.samples.json"
    node_source = r"""
const fs = require('fs');
const core = require(process.argv[1]);
const config = core.GUANGYANG_ISLAND_CONFIG;
const first = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[0];
const obstacleRoads = first.packages.filter(item => item.role === 'obstacle').map(item => {
  const matches = config.rules.roads.map(road => ({id: road.id,
    distance: core.geometry.distanceToPolyline([item.x, item.z], road.points).distance}));
  matches.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  return matches[0].id;
});
console.log(JSON.stringify({graph: core.projectNavigationQuery('map_graph', {rules:config.rules}),
  obstacleRoads}));
"""
    public = json.loads(subprocess.check_output(
        ["node", "-e", node_source, str(core_path), str(sample_file)], text=True))
    edges = {edge["roadId"]: edge for edge in public["graph"]["edges"]}
    adjacency = {node["nodeId"]: [] for node in public["graph"]["nodes"]}
    for edge in edges.values():
        adjacency[edge["fromNodeId"]].append((edge["toNodeId"], edge["roadId"], edge["lengthCm"]))
        if not edge["oneWay"]:
            adjacency[edge["toNodeId"]].append((edge["fromNodeId"], edge["roadId"], edge["lengthCm"]))
    source = HERE / "program.py"
    tree = ast.parse(source.read_text())
    functions = [item for item in tree.body if isinstance(item, ast.FunctionDef)
                 and item.name in ("dijkstra", "_vp_path")]
    namespace = dict(edge_by_road=edges, adj=adjacency,
                     blocked_roads=set(public["obstacleRoads"]), blocked_directions=set())
    constant = next(item for item in tree.body if isinstance(item, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == "VP_EXIT_ENTRY_CM"
                            for target in item.targets))
    namespace["VP_EXIT_ENTRY_CM"] = ast.literal_eval(constant.value)
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), namespace)
    _, lines = read(3, 2)
    blocks = events(lines, "viewpoint_direction_blocked")
    keys = [(item["fromNodeId"], item["toNodeId"], item["roadId"]) for item in blocks]
    namespace["blocked_directions"].update(keys)
    state = {"roadId": blocks[-1]["roadId"], "roadProgressCm": blocks[-1]["roadProgressCm"]}
    path = namespace["_vp_path"]
    checks = {
        "public_obstacle_roads": public["obstacleRoads"],
        "central_south_edge": edges[state["roadId"]],
        "recorded_final_state": state,
        "both_whole_directions_blocked": {
            "retreat_to_start": path(state, state["roadId"], 0.0),
            "oil_south_25": path(state, "oil-south", 25.0),
        },
    }
    namespace["blocked_directions"].remove(keys[0])
    checks["counterfactual_remove_opposite_end_global_block_only"] = {
        "retreat_to_start": path(state, state["roadId"], 0.0),
        "oil_south_25": path(state, "oil-south", 25.0),
        "scope": "Pure graph result; not a rerun or a claim of counterfactual grab success.",
    }
    namespace["blocked_directions"].clear()
    landing = lines[768]
    state = {"roadId": landing["actualRoadId"], "roadProgressCm": landing["actualProgressCm"]}
    checks["unknown_gateway_same_landing"] = {
        "recorded_state": state,
        "requested_progress_cm": 0.0,
        "enter_only": path(state, state["roadId"], 0.0, True),
        "strict_point_comparison": path(state, state["roadId"], 0.0, False),
    }
    checks["frozen_program_sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
    checks["platform_core_sha256"] = hashlib.sha256(core_path.read_bytes()).hexdigest()
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", type=Path, default=Path(
        "/Users/ken/Desktop/robot_competition-main/projects/car-python/competition-core.js"))
    args = parser.parse_args()
    output = {f"r{r}_map{m:02}": summarize(r, m) for r, m in ((2, 2), (3, 2), (2, 9), (3, 9))}
    first = output["r2_map02"]["events"]["memory_confirmed"][0].copy()
    second = output["r3_map02"]["events"]["memory_confirmed"][0].copy()
    first.pop("line_index")
    second.pop("line_index")
    output["map02_confirmation_identical"] = first == second
    output["pure_path_checks"] = pure_path_checks(args.core)
    output["indexed_raw_excerpts"] = {}
    for round_number, map_number, ranges in (
            (3, 2, ((758, 770), (822, 827), (890, 900), (964, 970))),
            (2, 9, ((959, 976),)),
            (3, 9, ((973, 983), (993, 1009)))):
        _, raw_lines = read(round_number, map_number)
        output["indexed_raw_excerpts"][f"r{round_number}_map{map_number:02}"] = [
            {"line_index": index, **raw_lines[index]}
            for left, right in ranges for index in range(left, right)]
    _, lines = read(3, 7)
    last_hit_start = events(lines, "memory_hit")[0]["line_index"]
    names = ("observe", "memory_hit", "confirmation_sample", "viewpoint_selected",
             "viewpoint_failed", "viewpoint_take_exit", "confirmation_failed", "flow_end")
    output["r3_map07_final_confirmation"] = {
        name: events(lines, name, last_hit_start if name != "observe" else last_hit_start - 5)
        for name in names}
    last_candidates = events(lines, "viewpoint_candidates")[-1]["line_index"]
    previous_nonrejection = next(index for index in range(last_candidates - 1, -1, -1)
                                 if lines[index]["event"] != "viewpoint_candidate_rejected")
    output["r3_map07_last_candidate_rejection_counts"] = dict(Counter(
        item["reason"] for item in lines[previous_nonrejection + 1:last_candidates]))
    print(json.dumps(output, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
