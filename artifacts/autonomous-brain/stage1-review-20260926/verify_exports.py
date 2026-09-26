#!/usr/bin/env python3
"""Read-only verification of this run's five original export datasets."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path


def digest(stream):
    result, size = hashlib.sha256(), 0
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        result.update(chunk)
        size += len(chunk)
    return result.hexdigest(), size


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    directory = Path(args.input)
    evidence = json.loads((directory / "evidence.json").read_text())
    status = json.loads((directory / "export-status.json").read_text())
    rows = []
    for name in ("record", "samples", "sensorAudit", "captures", "envelope"):
        recorded = evidence[name]
        path = directory / recorded["file"]
        with path.open("rb") as source:
            packed, size = digest(source)
        opener = gzip.open if recorded["compression"] == "gzip" else open
        with opener(path, "rb") as source:
            expanded, expanded_size = digest(source)
        rows.append({"dataset": name, "file": path.as_posix(),
                     "sha256": packed, "bytes": size, "expanded_sha256": expanded,
                     "expanded_bytes": expanded_size,
                     "verified": packed == recorded["sha256"] and size == recorded["bytes"]
                         and expanded == recorded["expandedSha256"]
                         and expanded_size == recorded["expandedBytes"]})
    result = {"scope": "original_exports_bytes_and_gzip_crc", "datasets": rows,
              "all_pass": status.get("complete") is True and not status.get("failures")
                  and all(row["verified"] for row in rows)}
    with Path(args.out).open("x") as target:
        json.dump(result, target, indent=2)
        target.write("\n")
    print(json.dumps({"all_pass": result["all_pass"], "datasets": len(rows)}))
    return 0 if result["all_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
