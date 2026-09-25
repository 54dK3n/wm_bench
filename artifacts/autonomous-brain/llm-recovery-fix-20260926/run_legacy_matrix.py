"""Run existing strict, offline replay against one real trial per old version."""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import tempfile
import time

VERSION = "brain-legacy-compatibility-matrix/v1"
ROOT = Path(__file__).resolve().parents[3]
RUNS = [1, 2, 3, 4, 5, 6, 8, 11, 16]

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def sources():
    return {str(p.relative_to(ROOT)): sha(p) for p in sorted((ROOT / "autonomous_brain").glob("*.py"))}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    assert Path(args.out).name == args.out
    directory = Path(__file__).parent
    out = directory / args.out
    out.mkdir(exist_ok=False)
    before = sources()
    result = {"version": VERSION, "script_sha256": sha(Path(__file__)),
              "source_before": before, "runs": [], "scope": "offline model replay only"}
    with tempfile.TemporaryDirectory(prefix=".replay-work-", dir=directory) as work:
        for number in RUNS:
            name = f"map05-run-{number:02}"
            original = ROOT / "artifacts/autonomous-brain" / name / "map-05-run-1/brain"
            destination = Path(work) / name
            command = ["python3", "tools/replay_brain_llm.py", "--input",
                       str(original.relative_to(ROOT)), "--out", str(destination.relative_to(ROOT))]
            start = time.perf_counter()
            run = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
            stdout = run.stdout.replace(str(ROOT) + "/", "")
            stderr = run.stderr.replace(str(ROOT) + "/", "")
            (out / f"{name}.stdout.txt").write_text(stdout)
            (out / f"{name}.stderr.txt").write_text(stderr)
            checks_path = destination / "replay-checks.json"
            checks = json.loads(checks_path.read_text()) if checks_path.exists() else {}
            if checks:
                (out / f"{name}.checks.json").write_bytes(checks_path.read_bytes())
            first = json.loads((original / "llm.jsonl").read_text().splitlines()[0])
            row = {"run": name, "transcript_version": first["version"], "command": command,
                   "exit_code": run.returncode, "elapsed_s": time.perf_counter() - start,
                   "allPass": run.returncode == 0 and checks.get("allPass") is True,
                   "replayed_rounds": checks.get("replayed_rounds"),
                   "replayed_calls": checks.get("replayed_calls"),
                   "network_calls": checks.get("network_calls"),
                   "environment_access_attempts": checks.get("environment_access_attempts"),
                   "full_records_equal_except_mode": checks.get("full_records_equal_except_mode"),
                   "checks_sha256": sha(checks_path) if checks_path.exists() else None,
                   "transient_replayed_transcript_sha256": sha(destination / "replayed-llm.jsonl")
                       if (destination / "replayed-llm.jsonl").exists() else None}
            result["runs"].append(row)
            print(json.dumps({k: row[k] for k in ["run", "transcript_version", "allPass", "replayed_rounds", "replayed_calls"]}), flush=True)
    result["source_after"] = sources()
    result["source_unchanged"] = result["source_before"] == result["source_after"]
    result["allPass"] = result["source_unchanged"] and all(r["allPass"] for r in result["runs"])
    result["duplicate_transcripts"] = "Reconstructed in temporary repository-relative directories and removed; original immutable transcripts remain available. Checks retain full per-round comparisons and source hashes."
    (out / "matrix.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    return 0 if result["allPass"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
