"""Capture only completed public records and source evidence; no robot calls."""
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
BASE = Path("artifacts/autonomous-brain/map05-run-19/map-05-run-1/brain")
FROZEN_REF = "6097720"


def write(name, value):
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        stream.write(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def capture_prefix(name, key, limit, selected):
    digest = hashlib.sha256()
    byte_count = line_count = 0
    found = []
    path = BASE / (name + ".jsonl")
    with (ROOT / path).open("rb") as stream:
        for raw in stream:
            row = json.loads(raw)
            if row[key] > limit:
                raise RuntimeError("required prefix end was not encountered")
            digest.update(raw)
            byte_count += len(raw)
            line_count += 1
            if selected(row):
                found.append(row)
            if row[key] == limit:
                break
        else:
            raise RuntimeError("required completed prefix is unavailable")
    return found, {"path": str(path), "prefix_bytes": byte_count,
                   "prefix_lines": line_count, "inclusive_end": {key: limit},
                   "prefix_sha256": digest.hexdigest(),
                   "scope": "raw bytes from file start through the stated completed record; not a whole-file hash"}


def source_manifest():
    paths = ["autonomous_brain/__init__.py", "autonomous_brain/actions.py",
             "autonomous_brain/navigation.py", "autonomous_brain/bridge.py",
             "workspaces/guangyang-platform/projects/car-python/competition-core.js",
             "workspaces/guangyang-platform/projects/car-python/robot-backend-runtime.js",
             "workspaces/guangyang-platform/projects/car-python/robot-bridge-contract.js"]
    result = []
    for name in paths:
        raw = (ROOT / name).read_bytes()
        row = {"path": name, "sha256": hashlib.sha256(raw).hexdigest()}
        if name.startswith("autonomous_brain/"):
            expected = subprocess.check_output(["git", "show", FROZEN_REF + ":" + name], cwd=ROOT)
            row.update(frozen_git_sha256=hashlib.sha256(expected).hexdigest(),
                       matches_frozen_git=raw == expected)
        else:
            row["provenance"] = "Current platform source; external to the root Git tree. No root-commit equality claim."
        result.append(row)
    return {"frozen_run_commit": subprocess.check_output(
                ["git", "rev-parse", FROZEN_REF], cwd=ROOT, text=True).strip(),
            "current_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "sources": result}


def main():
    rounds, rm = capture_prefix("rounds", "round", 146, lambda r: r["round"] in (140, 145, 146))
    observations, om = capture_prefix("observations", "observation_index", 956,
        lambda r: r["observation_index"] in (925, 926, 952, 953, 955, 956))
    motions, mm = capture_prefix("motions", "after_observation", 956,
        lambda r: (r["before_observation"], r["after_observation"]) in ((925, 926), (952, 953), (955, 956)))
    assert len(rounds) == 3 and len(observations) == 6 and len(motions) == 3
    manifest = source_manifest()
    assert all(item.get("matches_frozen_git", True) for item in manifest["sources"])
    write("source-before.json", manifest)
    write("input-prefix-sha256.json", {"scope": "Live files may grow. Only these immutable completed prefixes are hashed.",
                                       "prefixes": [rm, om, mm]})
    write("public-excerpts.json", {
        "rounds": [{key: r[key] for key in ("round", "action", "result", "simulation_seconds")} for r in rounds],
        "observations": observations, "motions": motions})
    for name in ("__init__.py", "actions.py", "navigation.py", "bridge.py"):
        write("baseline_source/autonomous_brain/" + name,
              (ROOT / "autonomous_brain" / name).read_text())
    ranges = {
        "autonomous_brain/actions.py": [(155, 180), (307, 333), (349, 421)],
        "autonomous_brain/navigation.py": [(77, 108), (129, 144)],
        "workspaces/guangyang-platform/projects/car-python/competition-core.js":
            [(759, 785), (807, 830), (3677, 3693), (3704, 3718), (3811, 3869)],
        "workspaces/guangyang-platform/projects/car-python/robot-backend-runtime.js": [(55, 86)],
        "workspaces/guangyang-platform/projects/car-python/robot-bridge-contract.js": [(61, 72)],
    }
    sections = []
    for name, intervals in ranges.items():
        lines = (ROOT / name).read_text().splitlines()
        for start, end in intervals:
            sections.append(f"{name}:{start}-{end}\n" + "\n".join(
                f"{i}: {lines[i - 1]}" for i in range(start, end + 1)))
    write("source-excerpts.txt", "\n\n".join(sections) + "\n")
    print("Captured 3 rounds, 6 public observations, 3 motions; 3 bounded input prefixes.")
    print("All 4 brain source files match frozen Run19 commit " + manifest["frozen_run_commit"] + ".")
    print("Three external platform sources are hashed separately, without a root-Git equality claim.")


if __name__ == "__main__":
    main()
