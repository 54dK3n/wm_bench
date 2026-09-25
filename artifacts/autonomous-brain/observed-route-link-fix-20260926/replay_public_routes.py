"""Read-only production collector check against frozen Run20 sensor inputs."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from autonomous_brain.navigation import RoadMemory

HERE = Path(__file__).resolve().parent
CANDIDATE = HERE.with_name("observed-route-link-candidate-20260926")
spec = importlib.util.spec_from_file_location("frozen_road_v4", CANDIDATE / "baseline_navigation.py")
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    input_path = CANDIDATE / "run20-public-inputs.json"
    data = json.loads(input_path.read_text())
    expected = json.loads((CANDIDATE / "findings.json").read_text())["run20_coverage"]
    manifest = json.loads((CANDIDATE / "run20-input-manifest.json").read_text())
    assert sha(input_path) == manifest["snapshot_sha256"]
    before = {str(p.relative_to(ROOT)): sha(p) for p in (
        input_path, CANDIDATE / "baseline_navigation.py", CANDIDATE / "findings.json",
        ROOT / "autonomous_brain/navigation.py", ROOT / "autonomous_brain/run.py",
        ROOT / "autonomous_brain/actions.py")}
    memory, old = RoadMemory(), baseline.RoadMemory()
    by_before = {m["before_observation"]: m for m in data["motions"]}
    by_after = {m["after_observation"]: m for m in data["motions"]}
    assert len(by_after) == len(data["motions"])
    first = {}
    for o in data["observations"]:
        first.setdefault(o["round"], o["observation_index"])
    round_at = {first[r["round"]]: r for r in data["rounds"]}
    events, queries, unchanged = [], {}, 0

    def geometry(nodes):
        return [(n["id"], n["position_m"], [e["heading_deg"] for e in n["exits"]]) for n in nodes]

    for o in data["observations"]:
        i = o["observation_index"]
        old.update(o["odometry"], o["road"])
        memory.update(o["odometry"], o["road"], observation_index=i)
        events.extend(memory.observe_traversal(o, by_after.get(i)))
        if i in round_at:
            state = round_at[i]["state"]
            # Missing action callbacks are not guessed: restore only original
            # flags at each logged decision, after checking identical geometry.
            for store in (old, memory):
                assert geometry(store.summary()) == geometry(state["junction_history"])
                for node, saved in zip(store.nodes, state["junction_history"]):
                    for e, se in zip(node["exits"], saved["exits"]):
                        for field in ("visits", "completed", "blocked"):
                            e[field] = se[field]
                assert store.unexplored() == state["unexplored_exit_count"]
            stable = (memory.summary(), memory.unexplored(), memory.traversal_records())
            hints = memory.frontier_hints(o["odometry"], o["road"], observation_index=i)
            assert stable == (memory.summary(), memory.unexplored(), memory.traversal_records())
            assert all(h["next_exit_angle_deg"] in [e["angleDeg"] for e in o["road"]["exits"]]
                       for h in hints)
            queries[round_at[i]["round"]] = hints
        if i in by_before and by_before[i]["method"] == "take_exit":
            angle = by_before[i]["params"]["angleDeg"]
            old.chosen(o["odometry"], angle)
            memory.chosen(o["odometry"], angle, observation_index=i)
        assert old.__dict__ == {key: getattr(memory, key) for key in old.__dict__}
        unchanged += 1
    trips = memory.traversal_records()
    compact = [{"trip_id": t["trip_id"], "from": t["departure"]["node_id"],
        "to": t["arrival"]["node_id"],
        "window": [t["departure"]["observation_index"], t["arrival"]["observation_index"]],
        "travelled_cm": t["travelled_cm"], "motion_count": len(t["motions"]),
        "observation_count": len(t["observed_path"])} for t in trips]
    assert compact == expected["completed_trips"]
    checked = expected["eligible_queries"] + expected["requested_rounds_155_156"]
    for q in checked:
        assert queries[q["round"]] == q["hints"]
    assert [r for r, hints in queries.items() if hints] == expected["all_query_rounds_with_hints"]
    assert all(sha(ROOT / p) == digest for p, digest in before.items())
    pending = memory._pending_traversal  # Diagnostic only, never a brain input.
    print(json.dumps({"version": "production-observed-route-replay/v1", "pass": True,
        "scope": "saved public sensors and motions only; no simulator, truth, model or network",
        "observations": len(data["observations"]), "motions": len(data["motions"]),
        "rounds": len(queries), "legacy_state_equal_observations": unchanged,
        "legacy_geometry_and_logged_flags_checked_rounds": len(queries),
        "completed_trips": compact, "completed_trip_count": len(trips),
        "candidate_queries_exactly_equal": [q["round"] for q in checked],
        "all_nonempty_query_rounds": [r for r, hints in queries.items() if hints],
        "collector_events": events,
        "unfinished_window": ({"before_observation": pending["observations"][0]["observation_index"],
            "after_observation": pending["observations"][-1]["observation_index"]} if pending else None),
        "inputs_and_sources_sha256": before, "inputs_and_sources_unchanged": True,
        "formal_success_claim": False}, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
