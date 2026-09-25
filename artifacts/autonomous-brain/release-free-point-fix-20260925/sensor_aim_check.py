"""Run from the repository root; reads only source and two brain sensor logs.

python3 artifacts/autonomous-brain/release-free-point-fix-20260925/sensor_aim_check.py
The JSON on stdout deliberately omits world target and robot coordinates.
"""
import hashlib
import json
import math
from pathlib import Path
import sys
from types import SimpleNamespace

sys.dont_write_bytecode = True
ROOT = Path.cwd()
sys.path[:0] = [str(ROOT), str(ROOT / "vendor/wm_kit_opt2")]

from autonomous_brain.actions import Actions, VERSION as ACTIONS_VERSION
from autonomous_brain.perception import Perception, VERSION as PERCEPTION_VERSION

BASE = Path("artifacts/autonomous-brain/map05-run-14/map-05-run-1/brain")
SCRIPT = Path("artifacts/autonomous-brain/release-free-point-fix-20260925/sensor_aim_check.py")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_selected(path, predicate):
    raw = path.read_bytes()
    rows = [(line, json.loads(line)) for line in raw.splitlines() if line.strip()]
    selected = [(line, row) for line, row in rows if predicate(row)]
    assert len(selected) == 1, f"Expected one matching sensor record in {path}"
    line, row = selected[0]
    return row, {"path": path.as_posix(), "sha256": sha256(raw),
                 "selected_record_sha256": sha256(line)}


def main():
    assert ACTIONS_VERSION == "autonomous-brain-actions/v17"
    observation, observation_input = read_selected(BASE / "observations.jsonl",
        lambda row: row.get("observation_index") == 545)
    camera_call, camera_input = read_selected(BASE / "bridge-calls.jsonl",
        lambda row: row.get("request", {}).get("method") == "camera_parameters")
    assert camera_call["terminal"]["status"] == "completed"
    camera = camera_call["terminal"]["result"]
    perception = Perception(camera)
    actions = Actions(SimpleNamespace(snapshot=observation, perception=perception))
    aim = actions.choose_release_aim()
    assert aim is not None and not aim.get("error"), aim and aim.get("error")
    distance_cm, bearing_deg = actions.object_geometry(aim)
    x, z = perception.ground_camera.project_pixel_to_ground(aim["pixel"]["u"], aim["pixel"]["v"])
    direct_distance = math.hypot(x, z) * 100
    direct_bearing = math.degrees(math.atan2(x, z))
    assert math.isclose(distance_cm, direct_distance, abs_tol=1e-10)
    assert math.isclose(bearing_deg, direct_bearing, abs_tol=1e-10)
    # Hash the project source modules actually imported, including calibration.
    paths = {SCRIPT}
    for module in tuple(sys.modules.values()):
        file = getattr(module, "__file__", None)
        if file:
            try:
                path = Path(file).resolve().relative_to(ROOT.resolve())
            except ValueError:
                continue
            if path.suffix == ".py" and path.parts[0] in {"autonomous_brain", "vendor"}:
                paths.add(path)
    result = {
        "schema": "sensor-release-aim-check/v1",
        "command": f"python3 {SCRIPT.as_posix()}",
        "scope": "offline sensor-only computation; no simulator, network, evaluation, sample or layout reads",
        "versions": {"actions": ACTIONS_VERSION, "perception": PERCEPTION_VERSION},
        "source_sha256": {p.as_posix(): sha256(p.read_bytes()) for p in sorted(paths)},
        "inputs": [observation_input, camera_input],
        "source_observation": observation["observation_index"],
        "source_frame": aim["source_frame"],
        "camera_parameters": camera,
        "mode": aim["mode"], "error": aim.get("error"),
        "selected_pixel": aim["pixel"],
        "source_region_bbox": aim["source_region"]["bbox"],
        "occupied_box_count": len(aim["occupied_boxes"]),
        "relative_distance_cm": distance_cm, "relative_bearing_deg": bearing_deg,
        "direct_camera_distance_cm": direct_distance, "direct_camera_bearing_deg": direct_bearing,
        "projection_agrees": True,
        "limitation": "Demonstrates sensor provenance and coordinate conversion, not successful placement or guaranteed free ground."
    }
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
