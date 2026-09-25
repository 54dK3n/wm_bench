#!/usr/bin/env python3
"""Independently verify saved PNG evidence against captured RGBA8 hashes offline."""

import argparse
import base64
from collections import defaultdict
import hashlib
import io
import json
import os
from pathlib import Path
import sys

import PIL
from PIL import Image


VERSION = "wm-v4-stage1-verify-pixels/v1"
ROOT = Path(__file__).resolve().parent.parent


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def relative(path):
    return Path(os.path.relpath(Path(path).resolve(), ROOT)).as_posix()


def load_json(path, inputs):
    data = path.read_bytes()
    inputs.append({"file": relative(path), "byteLength": len(data), "sha256": sha256(data)})
    return json.loads(data)


def indexed(rows, name, failures):
    result = defaultdict(list)
    for index, row in enumerate(rows):
        value = row.get("frameId") if isinstance(row, dict) else None
        if type(value) is not int or value < 1:
            failures.append({"code": "INVALID_FRAME_ID", "origin": name, "index": index})
        else:
            result[value].append(index)
    duplicates = [{"frameId": key, "indices": indices} for key, indices in result.items() if len(indices) > 1]
    if duplicates:
        failures.append({"code": "DUPLICATE_FRAME_IDS", "origin": name, "duplicates": duplicates})
    return result, duplicates


def verify_run(directory, trial, inputs):
    failures = []
    result = {"map": trial.get("map"), "run": trial.get("run"), "directory": relative(directory),
              "failures": failures, "frames": []}
    try:
        record = load_json(directory / "record.json", inputs)
        captures = load_json(directory / "captures.json", inputs)
        frames = record["native"]["visionFrames"]
        if not isinstance(frames, list) or not isinstance(captures, list):
            raise ValueError("Frame collections must be arrays")
    except (OSError, ValueError, KeyError, TypeError) as error:
        failures.append({"code": "INPUT_UNREADABLE_OR_INVALID", "errorType": type(error).__name__})
        result["allPass"] = False
        return result

    result.update({"pngFrameCount": len(frames), "captureFrameCount": len(captures)})
    frame_index, duplicate_frames = indexed(frames, "record.native.visionFrames", failures)
    capture_index, duplicate_captures = indexed(captures, "captures", failures)
    missing_png = sorted(set(capture_index) - set(frame_index))
    missing_capture = sorted(set(frame_index) - set(capture_index))
    result.update({"duplicatePngFrames": duplicate_frames, "duplicateCaptureFrames": duplicate_captures,
                   "missingPngFrameIds": missing_png, "missingCaptureFrameIds": missing_capture})
    if missing_png:
        failures.append({"code": "MISSING_PNG_FRAMES", "frameIds": missing_png})
    if missing_capture:
        failures.append({"code": "MISSING_CAPTURE_FRAMES", "frameIds": missing_capture})
    if len(frames) != len(captures):
        failures.append({"code": "FRAME_COUNT_MISMATCH", "png": len(frames), "captures": len(captures)})
    if not frames or not captures:
        failures.append({"code": "NO_FRAMES_TO_VERIFY"})

    for index, frame in enumerate(frames):
        if not isinstance(frame, dict):
            continue  # indexed() has already reported this malformed entry.
        frame_id = frame.get("frameId")
        row = {"index": index, "frameId": frame_id, "tick": frame.get("tick"), "failures": []}
        result["frames"].append(row)
        problems = row["failures"]
        capture_rows = capture_index.get(frame_id, []) if type(frame_id) is int else []
        capture = captures[capture_rows[0]] if len(capture_rows) == 1 else None
        if capture is None:
            problems.append({"code": "NO_UNIQUE_CAPTURE"})
        else:
            row["captureTick"] = capture.get("tick")
            row["captureRgbaSha256"] = capture.get("rgbaSha256")
            if type(frame.get("tick")) is not int or type(capture.get("tick")) is not int:
                problems.append({"code": "INVALID_TICK"})
            elif frame["tick"] != capture["tick"]:
                problems.append({"code": "TICK_MISMATCH"})
        try:
            png = base64.b64decode(frame["pngBase64"], validate=True)
            row.update({"pngByteLength": len(png), "pngSha256": sha256(png),
                        "recordPngByteLength": frame.get("byteLength"), "recordPngSha256": frame.get("sha256")})
            if len(png) != frame.get("byteLength"):
                problems.append({"code": "PNG_BYTE_LENGTH_MISMATCH"})
            if row["pngSha256"] != frame.get("sha256"):
                problems.append({"code": "PNG_SHA256_MISMATCH"})
            with Image.open(io.BytesIO(png)) as picture:
                picture.load()
                row.update({"decodedFormat": picture.format, "decodedMode": picture.mode,
                            "width": picture.width, "height": picture.height})
                if picture.format != "PNG" or frame.get("mimeType") != "image/png":
                    problems.append({"code": "NOT_PNG"})
                if picture.width != frame.get("width") or picture.height != frame.get("height"):
                    problems.append({"code": "PNG_DIMENSIONS_MISMATCH"})
                rgba = picture.convert("RGBA").tobytes("raw", "RGBA")
            row["rgbaByteLength"] = len(rgba)
            row["rgbaSha256"] = sha256(rgba)
            if capture is not None and row["rgbaSha256"] != capture.get("rgbaSha256"):
                problems.append({"code": "RGBA_SHA256_MISMATCH"})
        except (KeyError, ValueError, TypeError, OSError) as error:
            problems.append({"code": "PNG_DECODE_ERROR", "errorType": type(error).__name__})
        row["allPass"] = not problems

    bad_frames = [row["frameId"] for row in result["frames"] if not row["allPass"]]
    result.update({"verifiedFrameCount": sum(row["allPass"] for row in result["frames"]),
                   "mismatchedFrameCount": len(bad_frames), "mismatchedFrameIds": bad_frames,
                   "allPass": not failures and not bad_frames})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Saved acceptance directory")
    parser.add_argument("--out", required=True, help="New JSON report; never overwritten")
    args = parser.parse_args()
    directory = Path(args.input).resolve()
    output = Path(args.out).resolve()
    if output.exists():
        raise SystemExit("Refusing to overwrite an existing report")
    inputs = []
    report = {"version": VERSION, "pillowVersion": PIL.__version__, "pythonVersion": sys.version.split()[0],
              "input": relative(directory), "script": {"file": relative(__file__), "sha256": sha256(Path(__file__).read_bytes())},
              "hashDefinition": "SHA256 of top-to-bottom, row-major RGBA8 bytes decoded from the original PNG",
              "inputs": inputs, "runs": [], "failures": []}
    try:
        acceptance = load_json(directory / "acceptance.json", inputs)
        trials = acceptance["trials"]
        if not isinstance(trials, list) or not trials:
            raise ValueError("No saved trials")
        report["savedAcceptanceStatus"] = acceptance.get("status")
        report["savedAcceptancePass"] = acceptance.get("allPass")
        listed = []
        for trial in trials:
            trial_directory = (directory / trial["directory"]).resolve()
            if not trial_directory.is_relative_to(directory):
                raise ValueError("Trial directory is outside the acceptance directory")
            listed.append(trial_directory)
            report["runs"].append(verify_run(trial_directory, trial, inputs))
        if len(set(listed)) != len(listed):
            report["failures"].append({"code": "DUPLICATE_TRIAL_DIRECTORIES"})
        discovered = {p.parent.resolve() for name in ("record.json", "captures.json") for p in directory.glob("*/" + name)}
        unlisted = sorted(relative(p) for p in discovered - set(listed))
        if unlisted:
            report["failures"].append({"code": "UNLISTED_RUN_DIRECTORIES", "directories": unlisted})
    except (OSError, ValueError, KeyError, TypeError) as error:
        report["failures"].append({"code": "ACCEPTANCE_INPUT_UNREADABLE_OR_INVALID", "errorType": type(error).__name__})
    report["runCount"] = len(report["runs"])
    report["pngFrameCount"] = sum(run.get("pngFrameCount", 0) for run in report["runs"])
    report["captureFrameCount"] = sum(run.get("captureFrameCount", 0) for run in report["runs"])
    report["verifiedFrameCount"] = sum(run.get("verifiedFrameCount", 0) for run in report["runs"])
    report["mismatchedFrameCount"] = sum(run.get("mismatchedFrameCount", 0) for run in report["runs"])
    report["allPass"] = bool(report["runs"]) and not report["failures"] and all(run["allPass"] for run in report["runs"])
    with output.open("x", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
    print(json.dumps({"report": relative(output), **{key: report[key] for key in ("version", "runCount", "pngFrameCount", "captureFrameCount", "verifiedFrameCount", "mismatchedFrameCount", "allPass")}}, ensure_ascii=False))
    return 0 if report["allPass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
