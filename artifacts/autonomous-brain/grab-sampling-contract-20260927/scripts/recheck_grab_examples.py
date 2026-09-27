"""Re-audit exported synthetic public examples without running their producer."""
import argparse
import hashlib
import json
from pathlib import Path

from tools.brain_evidence_audit import audit_observed_ledger


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    source_bytes = args.input.read_bytes()
    data = json.loads(source_bytes)
    rows = []
    for example in data["examples"]:
        result = audit_observed_ledger(example["summary"], example["observations"], example["rounds"],
                                       example["bridge"], example["motions"])
        rows.append({"name": example["name"], "runtime_version": example["summary"]["runtime_version"],
                     "checks": example["checks"], "audit": result})
    assert args.input.read_bytes() == source_bytes
    report = {"scope": "synthetic public producer output; function audit only, not task completion",
        "input": str(args.input), "input_sha256": hashlib.sha256(source_bytes).hexdigest(),
        "inputs_unchanged": True, "example_count": len(rows),
        "helper_sha256": hashlib.sha256(Path("tools/brain_evidence_audit.py").read_bytes()).hexdigest(),
        "examples": rows}
    with args.output.open("x") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    print(json.dumps({"output": str(args.output), "examples": len(rows),
                      "failure_counts": {row["name"]: len(row["audit"]["failures"]) for row in rows}}))
    return int(any(row["audit"]["failures"] for row in rows))


if __name__ == "__main__":
    raise SystemExit(main())
