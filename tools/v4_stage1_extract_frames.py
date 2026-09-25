#!/usr/bin/env python3
"""Restore original PNG evidence embedded in a saved v4 robot record."""
import argparse
import base64
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--record", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    output = Path(args.out)
    if output.exists():
        raise SystemExit("Refusing to overwrite an evidence directory")
    record = json.loads(Path(args.record).read_text())
    frames = record["native"]["visionFrames"]
    verified = []
    for frame in frames:
        data = base64.b64decode(frame["pngBase64"], validate=True)
        if len(data) != frame["byteLength"] or hashlib.sha256(data).hexdigest() != frame["sha256"]:
            raise SystemExit("Original frame digest or byte count mismatch")
        verified.append((f"frame-{frame['frameId']:06d}.png", data))
    if len({name for name, _ in verified}) != len(verified):
        raise SystemExit("Duplicate frame id")
    output.mkdir(parents=True)
    for name, data in verified:
        (output / name).write_bytes(data)
    print(json.dumps({"version": "wm-v4-stage1-frame-extract/v1", "restored": len(verified), "all_sha256_verified": True}))


if __name__ == "__main__":
    main()
