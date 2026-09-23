#!/usr/bin/env python3
"""Reproduce actual WM hit-increment evidence from completed raw trials only.

python3 tools/wm_hit_audit.py artifacts/inloop/stage-1/round-3
Add --check to verify the existing report byte for byte without writing it.
No simulator, robot program, raw trial, or other report tool is modified.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path


def audit_run(path):
    raw_bytes = path.read_bytes()
    raw = json.loads(raw_bytes)
    previous = {}
    hits = []
    observe = None
    associations = []
    confirmed = None
    for index, line in enumerate(raw["lines"]):
        event = line.get("event")
        if event == "observe":
            observe = (index, line)
            associations = []
        elif event == "wm_associations":
            associations = line.get("items", [])
        elif event == "memory_confirmed":
            confirmed = {"line_index": index, **line}
        elif event == "wm_targets":
            for track in line.get("tracks", []):
                prior_hits = previous.get(track["id"], 0)
                if track["hit"] > prior_hits:
                    readings = [item for item in associations if item["track_id"] == track["id"]]
                    if observe is None or not readings or track["hit"] != prior_hits + 1:
                        raise ValueError(f"{path.name} lines[{index}]: incomplete hit-increment evidence")
                    hits.append({
                        "wm_line_index": index, "observe_line_index": observe[0],
                        "hit": track["hit"], "track_id": track["id"],
                        "odo": observe[1]["odo"], "tick": observe[1]["tick"], "readings": readings,
                    })
                previous[track["id"]] = track["hit"]
    gaps = [
        {"pair": [left_index, right_index],
         "distance_cm": math.hypot(left["odo"][0] - right["odo"][0],
                                   left["odo"][1] - right["odo"][1])}
        for left_index, left in enumerate(hits)
        for right_index, right in enumerate(hits)
        if right_index > left_index and left["track_id"] == right["track_id"]
    ]
    return {
        "map": path.stem, "source_sha256": hashlib.sha256(raw_bytes).hexdigest(),
        "actual_wm_hit_increments": hits, "pair_gaps_cm": gaps, "confirmed_record": confirmed,
        "all_actual_ranges_40_90cm": (all(40 <= item["distanceCm"] <= 90
                                            for hit in hits for item in hit["readings"]) if hits else None),
        "all_actual_gaps_at_least_15cm": all(gap["distance_cm"] >= 15 for gap in gaps) if gaps else None,
    }


def generate(folder):
    paths = sorted(folder.glob("map-??.json"))
    if not paths:
        raise ValueError(f"No raw map-??.json trials found in {folder}")
    return {
        "line_index_convention": "zero-based raw lines array index",
        "scope": "offline report only; actual hit increments compared against latest observe and wm_associations; no simulator, code or raw mutation",
        "runs": [audit_run(path) for path in paths],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--check", action="store_true", help="compare to existing output without writing")
    args = parser.parse_args()
    folder = args.folder.resolve()
    report = generate(folder)
    output = folder / "wm_hit_audit.json"
    encoded = (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if args.check:
        if not output.is_file() or output.read_bytes() != encoded:
            parser.exit(1, f"Mismatch: {output}\n")
    else:
        output.write_bytes(encoded)
    print(json.dumps({"output": str(output), "mode": "verified_identical" if args.check else "generated",
                      "runs": len(report["runs"]), "sha256": hashlib.sha256(encoded).hexdigest()},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
