"""Archive only a finished run. No simulator, model, or source modifications.

Run after tools/evaluate_autonomous_brain.py and tools/replay_brain_llm.py.
Every output is new; all raw inputs must remain unchanged.
"""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
METHODS = {"observe", "camera_parameters", "odometry", "local_road", "holding",
           "grab", "release", "forward", "backward", "turn", "follow_road", "take_exit"}


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return {"bytes": path.stat().st_size, "sha256": result.hexdigest()}


def relative(path):
    return path.resolve().relative_to(ROOT).as_posix()


def load(path):
    return json.loads(path.read_text())


def lines(path):
    with path.open() as stream:
        return [json.loads(line) for line in stream if line.strip()]


def write(path, value):
    with path.open("x") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, type=Path)
    parser.add_argument("--source-commit", required=True)
    args = parser.parse_args()
    run = args.run.resolve()
    relative(run)
    trial, brain = run / "map-05-run-1", run / "map-05-run-1/brain"
    driver, summary = load(run / "summary.json"), load(brain / "summary.json")
    assert driver["status"] == "complete", "Refuse an active/incomplete driver"
    assert summary["status"] in {"failed", "done"}
    manifest, evidence = load(run / "manifest.json"), load(trial / "evidence.json")
    exported = load(trial / "export-status.json")
    evaluation, replay = load(run / "report/evaluation.json"), load(run / "llm-replay/replay-checks.json")
    assert exported["complete"] and not exported["failures"] and not exported["partial"]
    assert evaluation["version"] == "autonomous-brain-offline-evaluation/v4"
    assert replay["allPass"] and replay["all_records_consumed"]
    original_paths = [run / p for p in ("manifest.json", "progress.json", "summary.json")]
    original_paths += sorted(p for p in trial.rglob("*") if p.is_file())
    originals = {relative(p): digest(p) for p in original_paths}
    proof = {"commit": args.source_commit, "scope": "Frozen Git blobs compared with pre/post-run and child hashes.", "files": {}}
    after = driver["sourceManifestAfterRun"]
    assert manifest == after and driver["sourcesUnchanged"]
    for name, expected in {**manifest["brain"], manifest["driver"]["file"]: manifest["driver"]["sha256"]}.items():
        raw = subprocess.check_output(["git", "show", f"{args.source_commit}:{name}"], cwd=ROOT)
        actual = hashlib.sha256(raw).hexdigest()
        end = after["brain"].get(name, after["driver"]["sha256"])
        child = summary["source_sha256"].get(Path(name).name) if name.startswith("autonomous_brain/") else None
        version = re.search(rb'(?:VERSION|version)\s*=\s*[\"\x27]([^\"\x27]+)', raw)
        matched = actual == expected == end and (child is None or child == actual)
        assert matched, name
        proof["files"][name] = {"git_sha256": actual, "manifest_sha256": expected,
            "after_sha256": end, "child_sha256": child, "source_version": version[1].decode() if version else None,
            "match": matched}
    assert len(proof["files"]) == 8
    proof.update(all_brain_and_driver_bytes_match=True, recorded_before_after_sources_equal=True,
                 platform_recorded_before_after_equal=manifest["platform"] == after["platform"],
                 capture_function_recorded_before_after_equal=manifest["evaluatorCaptureSha256"] == after["evaluatorCaptureSha256"])
    integrity = {"schema": "completed-run-export-integrity/v1", "datasets": [], "export_status": exported}
    for kind, meta in evidence.items():
        path = trial / meta["file"]
        stored = digest(path)
        expanded, count = hashlib.sha256(), 0
        opener = gzip.open if meta["compression"] == "gzip" else open
        with opener(path, "rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                expanded.update(block)
                count += len(block)
        matched = (stored["bytes"] == meta["bytes"] and stored["sha256"] == meta["sha256"]
                   and count == meta["expandedBytes"] and expanded.hexdigest() == meta["expandedSha256"])
        assert matched, kind
        integrity["datasets"].append({"dataset": kind, "file": relative(path), **stored,
            "expanded_bytes": count, "expanded_sha256": expanded.hexdigest(), "metadata_match": matched,
            "gzip_crc_eof_verified": meta["compression"] == "gzip"})
    assert len(integrity["datasets"]) == 5
    integrity["allPass"] = True
    rounds, obs, llm, motions, bridge = [lines(brain / f"{name}.jsonl") for name in (
        "rounds", "observations", "llm", "motions", "bridge-calls")]
    assert [r["round"] for r in rounds] == list(range(1, len(rounds) + 1))
    assert [o["observation_index"] for o in obs] == list(range(1, len(obs) + 1))
    assert [c["call_index"] for c in llm] == list(range(1, len(llm) + 1))
    assert len(rounds) == summary["rounds"] and len(obs) == summary["observations"] and len(llm) == summary["llm_calls"]
    elapsed = math.fsum(c["elapsed_s"] for c in llm)
    assert math.isclose(elapsed, summary["llm_total_elapsed_s"], abs_tol=1e-8)
    assert obs[-1]["simulation_seconds"] == summary["simulation_seconds"]
    failure_rounds = defaultdict(list)
    for row in rounds:
        if not row["result"]["success"]:
            failure_rounds[row["result"].get("reason")].append(row["round"])
    manipulated = {r["action"]["params"]["object_id"] for r in rounds
                   if r["action"] and r["action"]["action"] == "pick"}
    hints = []
    for row in rounds:
        state, action = row["state"], row["action"] or {}
        suggestions = state.get("exploration_hints", [])
        hints.append({"round": row["round"], "U": state["unexplored_exit_count"],
            "node_count": state["observed_junction_count"], "hint_kinds": [h["kind"] for h in suggestions],
            "hint_angles": [h["next_exit_angle_deg"] for h in suggestions], "action": action,
            "selected_suggested_angle": action.get("action") == "explore" and action.get("params", {}).get("exit_angle")
                in [h["next_exit_angle_deg"] for h in suggestions], "result": row["result"].get("reason")})
    metrics = {"schema": "completed-run-metrics/v1", "source_commit": args.source_commit,
        "task_success": evaluation["success"], "brain_status": summary["status"], "brain_reason": summary["reason"],
        "formal_limits": summary["limits"], "metrics": evaluation["metrics"],
        "recomputed": {"rounds": len(rounds), "llm_calls": len(llm), "observations": len(obs),
            "motions": len(motions), "bridge_calls": len(bridge), "llm_elapsed_s_fsum": elapsed,
            "retry_wait_s_fsum": math.fsum(c.get("transport_retry_delay_s", 0) for c in llm),
            "simulation_seconds": obs[-1]["simulation_seconds"], "final_tick": obs[-1]["odometry"]["tick"]},
        "driver_process": driver["trials"][0]["process"], "brain_wall_elapsed_s": summary["wall_elapsed_s"],
        "action_counts": dict(Counter((r["action"] or {}).get("action") for r in rounds)),
        "motion_counts": dict(Counter(m["method"] for m in motions)),
        "failed_rounds_by_reason": dict(failure_rounds), "failures": evaluation["failures"],
        "bridge_terminal_status_counts": dict(Counter(c["terminal"]["status"] for c in bridge)),
        "nonwhitelist_brain_requests": sum(c["request"]["method"] not in METHODS for c in bridge),
        "transport_errors": [{k: c.get(k) for k in ("call_index", "decision_index", "transport_error", "elapsed_s", "transport_retry_index", "transport_retry_delay_s")} for c in llm if c.get("transport_error")],
        "validation_errors": [{k: c.get(k) for k in ("call_index", "decision_index", "validation_error", "raw_output")} for c in llm if c.get("validation_error")],
        "public_timelines": [t for t in summary["timeline"] if t["object_id"] in manipulated],
        "grab_attempts": summary["grab_attempts"], "delivery": evaluation["delivery"],
        "physical_target_timelines": evaluation["perception"]["timeline"],
        "wm_position_error": evaluation["perception"]["position_error"],
        "wm_unmatched_confirmed_count": evaluation["perception"]["unmatched_confirmed_count"],
        "ambiguous_track_ids": evaluation["perception"]["ambiguous_track_ids"], "judge_counts": evaluation["judge"]["counts"],
        "done_action_count": sum(r["action"] is not None and r["action"]["action"] == "done" for r in rounds),
        "final_U": sum(not e["completed"] and not e["blocked"] for n in summary["junction_history"] for e in n["exits"]),
        "final_node_count": len(summary["junction_history"]), "final_holding": obs[-1]["holding"],
        "final_road": obs[-1]["road"], "exploration_decisions": hints,
        "replay": {k: replay[k] for k in ("allPass", "replayed_rounds", "replayed_calls", "all_records_consumed", "full_records_equal_except_mode", "network_calls", "environment_access_attempts")},
        "inputs": {relative(p): digest(p) for p in (run / "report/evaluation.json", run / "llm-replay/replay-checks.json", Path(__file__))}}
    assert all(digest(ROOT / p) == value for p, value in originals.items())
    write(run / "original-input-hashes.json", {"schema": "original-run-inputs/v1", "files": originals, "unchanged_after_checks": True})
    write(run / "source-commit.json", proof)
    write(run / "archive-integrity.json", integrity)
    write(run / "run-metrics.json", metrics)
    print(json.dumps({"archive_metrics_complete": True, "task_success": evaluation["success"],
        "rounds": len(rounds), "calls": len(llm), "valid_deliveries": len(evaluation["delivery"]["delivered_target_ids"]),
        "source_files": len(proof["files"]), "exports": len(integrity["datasets"]), "original_files": len(originals)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
