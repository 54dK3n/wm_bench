"""Create-only helper audit of the unchanged historical public gripper chain.

No evaluator invocation, truth/record/capture access, model or simulator.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

from tools.brain_evidence_audit import audit_observed_ledger


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brain-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    names = ("summary.json", "observations.jsonl", "rounds.jsonl", "bridge-calls.jsonl", "motions.jsonl")
    paths = [args.brain_dir / name for name in names]
    before = {str(path): digest(path) for path in paths}
    data = [json.loads(paths[0].read_text())]
    for path in paths[1:]:
        with path.open() as source:
            data.append([json.loads(line) for line in source if line.strip()])
    original_source = subprocess.check_output([
        "git", "show", "10e3c879d2499d6f893151f24857c315f12fe2e7:tools/brain_evidence_audit.py"])
    namespace = {"__name__": "historical_capability_baseline"}
    exec(compile(original_source, "baseline-brain-evidence-audit.py", "exec"), namespace)
    old = namespace["audit_observed_ledger"](*data)
    current = audit_observed_ledger(*data)
    picks = []
    for event in data[0]["action_evidence"]:
        if event["action"] != "pick":
            continue
        proof = event["evidence"].get("grasp_chain", {})
        grab = proof.get("grab", {})
        source = next(o for o in data[1] if o["observation_index"] == grab.get("before_observation"))
        obj = next(o for o in source["objects"] if o["id"] == event["object_id"])
        picks.append({"object_id": event["object_id"], "grab_round": grab.get("round"),
                      "grab_before_observation": source["observation_index"],
                      "original_state": obj["state"], "bridge_request_id": grab.get("bridge_request_id")})
    after = {str(path): digest(path) for path in paths}
    assert before == after
    assert "pick_command_identity_confirmation_chain_invalid" in old["failures"]
    assert "pick_command_identity_confirmation_chain_invalid" in current["failures"]
    result = {"scope": "unchanged historical public logs; audit_observed_ledger only",
              "declared_runtime_version": data[0].get("runtime_version"), "input_sha256": before,
              "inputs_unchanged": before == after, "original_grab_states": picks,
              "baseline_helper_sha256": hashlib.sha256(original_source).hexdigest(),
              "current_helper_sha256": digest(Path("tools/brain_evidence_audit.py")),
              "baseline_audit": old, "current_audit": current}
    with args.output.open("x") as target:
        json.dump(result, target, indent=2)
        target.write("\n")
    print(json.dumps({"output": str(args.output), "inputs_unchanged": True,
                      "original_grab_states": picks, "failures": current["failures"]}))


if __name__ == "__main__":
    main()
