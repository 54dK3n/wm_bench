"""Capture selected public brain evidence and frozen source, without actions."""
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
COMMIT = "6ee4abf464504eb297242df98dc9fadaaf7debfa"


def write(name, data):
    with (OUT / name).open("x", encoding="utf-8") as stream:
        stream.write(data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def main():
    prefixes = []

    def read_prefix(run, filename, key, end):
        path = Path("artifacts/autonomous-brain") / run / "map-05-run-1/brain" / filename
        rows, digest, count = [], hashlib.sha256(), 0
        with (ROOT / path).open("rb") as stream:
            for raw in stream:
                row = json.loads(raw)
                rows.append(row)
                digest.update(raw)
                count += len(raw)
                if row[key] == end:
                    break
            else:
                raise AssertionError(f"missing bounded prefix endpoint: {path}")
        prefixes.append({"path": str(path), "bytes": count, "records": len(rows),
                         "inclusive_end": {key: end}, "sha256": digest.hexdigest(),
                         "scope": "raw completed prefix, not whole file"})
        return rows

    def observation(row):
        return {key: row[key] for key in ("observation_index", "round", "simulation_seconds", "odometry", "road")}

    def round_state(row):
        keys = ("round", "simulation_seconds", "robot", "junction_history", "unexplored_exit_count", "observed_junction_count")
        return {"round": row["round"], "state": {key: row["state"][key] for key in keys},
                "action": row["action"], "result": row["result"]}

    r18obs = read_prefix("map05-run-18", "observations.jsonl", "observation_index", 851)
    r18rounds = read_prefix("map05-run-18", "rounds.jsonl", "round", 126)
    r18motions = read_prefix("map05-run-18", "motions.jsonl", "after_observation", 738)
    r19obs = read_prefix("map05-run-19", "observations.jsonl", "observation_index", 684)
    r19rounds = read_prefix("map05-run-19", "rounds.jsonl", "round", 163)
    r19motions = read_prefix("map05-run-19", "motions.jsonl", "after_observation", 684)
    data = {
        "schema": "observed-route-link-public-inputs/v1",
        "scope": "Only public road/odometry observations, selected model action states/results, and selected motion responses; no camera objects, LLM requests, truth, layout or hidden record.",
        "run18": {
            "road_observations_through_851": [observation(row) for row in r18obs],
            "rounds": [round_state(row) for row in r18rounds if row["round"] in (1, 109, 126)],
            "motions": [row for row in r18motions if row["after_observation"] in (2, 738)],
            "why_prefix_observations_are_needed": "Recompute the exact recorded graph at r126 without assuming or copying hidden connectivity; chosen() is unnecessary for graph geometry.",
        },
        "run19": {
            "observations": [observation(row) for row in r19obs if row["observation_index"] in
                             (1, 2, 332, 523, 556, 681, 682, 683, 684)],
            "rounds": [round_state(row) for row in r19rounds if row["round"] in
                       (51, 52, 81, 82, 86, 87, 104, 105, 163)],
            "motions": [row for row in r19motions if row["after_observation"] in
                        (2, 332, 523, 556, 681, 684)],
        },
    }
    sources = []
    snippets = []
    ranges = {"navigation.py": [(1, 176)], "actions.py": [(453, 537), (597, 702), (1318, 1326)],
              "run.py": [(182, 225)], "llm.py": [(23, 39), (181, 190)]}
    for filename, intervals in ranges.items():
        path = "autonomous_brain/" + filename
        frozen = subprocess.check_output(["git", "show", COMMIT + ":" + path], cwd=ROOT)
        current = (ROOT / path).read_bytes()
        assert frozen == current, "production source differs from declared frozen commit"
        version = next(line.strip() for line in frozen.decode().splitlines()
                       if line.startswith("VERSION =") or line.startswith("RUNTIME_VERSION ="))
        sources.append({"path": path, "version_assignment": version,
                        "sha256": hashlib.sha256(frozen).hexdigest(), "current_equals_frozen_commit": True})
        lines = frozen.decode().splitlines()
        for start, end in intervals:
            snippets.append(path + f":{start}-{end}\n" + "\n".join(
                f"{i}: {lines[i-1]}" for i in range(start, min(end, len(lines)) + 1)))
        if filename == "navigation.py":
            write("frozen_navigation.py", frozen.decode())
    write("public-inputs.json", data)
    write("capture-manifest.json", {"frozen_commit": COMMIT, "sources": sources,
                                   "public_input_prefixes": prefixes,
                                   "snapshot_sha256": hashlib.sha256((OUT / "public-inputs.json").read_bytes()).hexdigest()})
    write("source-references.txt", "\n\n".join(snippets) + "\n")
    print("Captured public Run18/19 snapshots; four relevant source files equal frozen 6ee4abf.")


if __name__ == "__main__":
    main()
