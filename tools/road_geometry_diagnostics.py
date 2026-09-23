#!/usr/bin/env python3
"""Offline, driver-only road corridor geometry. No simulator or task is run."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess


def read(path):
    return json.loads(Path(path).read_text())


def projections(point, roads, radius, cm):
    result = []
    for road in roads:
        progress = 0.0
        for index, (a, b) in enumerate(zip(road["points"], road["points"][1:])):
            delta = (b[0] - a[0], b[1] - a[1])
            length = math.hypot(*delta)
            t = max(0.0, min(1.0, sum((point[i] - a[i]) * delta[i] for i in (0, 1)) / length**2))
            projected = [a[i] + t * delta[i] for i in (0, 1)]
            distance = math.dist(point, projected)
            clearance = road["width"] / 2 - radius
            result.append({"roadId": road["id"], "segmentIndex": index,
                           "world": projected, "tangent": [v / length for v in delta],
                           "progressCm": (progress + t * length) * cm,
                           "centerlineDistanceCm": distance * cm,
                           "roadWidthCm": road["width"] * cm,
                           "vehicleCenterHalfWidthCm": clearance * cm,
                           "remainingLateralMarginCm": (clearance - distance) * cm,
                           "erodedRoadDistanceCm": max(0.0, distance - clearance) * cm})
            progress += length
    return sorted(result, key=lambda value: value["centerlineDistanceCm"])


def centreline_intervals(point, roads, within_cm, cm):
    intervals = []
    radius = within_cm / cm
    for road in roads:
        progress = 0.0
        for index, (a, b) in enumerate(zip(road["points"], road["points"][1:])):
            dx, dz = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dz)
            along = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / length
            perpendicular_sq = math.dist(point, a)**2 - along**2
            if perpendicular_sq <= radius**2:
                span = math.sqrt(max(0, radius**2 - perpendicular_sq))
                low, high = max(0, along - span), min(length, along + span)
                if high >= low:
                    intervals.append({"roadId": road["id"], "segmentIndex": index,
                                      "fromProgressCm": (progress + low) * cm,
                                      "toProgressCm": (progress + high) * cm})
            progress += length
    return intervals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("round", type=Path)
    parser.add_argument("--map", default="map-09")
    args = parser.parse_args()
    platform = Path(os.environ.get("GUANGYANG_PLATFORM_ROOT", "/Users/ken/Desktop/robot_competition-main/projects/car-python"))
    core = platform / "competition-core.js"
    script = "const c=require(process.argv[1]).GUANGYANG_CHALLENGE_CONFIGS.find(x=>x.taskId==='R2-GYI-MVP-02'); console.log(JSON.stringify({rules:c.rules,roads:c.roads,objects:c.objectTaskOverlay.objects}));"
    config = json.loads(subprocess.check_output(["node", "-e", script, str(core)], text=True))
    record = read(args.round / f"{args.map}.json")
    assert record["taskId"] == "R2-GYI-MVP-02"
    archive = read(record["visionEvidenceFile"])
    initial = next(t for t in archive["renderTruth"]["frames"] if t["captureTick"] == 0)
    batch = next(r for r in read(args.round / "batch_report.json") if r["map"] == args.map)
    association = batch["wm_final_association"]
    assert association["matched"], "An unmatched pseudo-track has no target reachability claim"
    target = next(o for o in initial["objectState"]["packages"] if o["id"] == association["truth_id"])
    track = next(t for t in batch["wm_final_tracks"] if t["id"] == batch["wm_final_track_id"])
    start = initial["vehicle"]
    h = start["heading"]
    units = config["rules"]["unitsPerMeter"]
    cm = 100 / units
    radius = config["rules"]["vehicleRadius"]
    wm_world = [start["x"] + units * (track["x"] * math.cos(h) - track["z"] * math.sin(h)),
                start["z"] + units * (-track["x"] * math.sin(h) - track["z"] * math.cos(h))]
    target_world = [target["x"], target["z"]]
    points = {"target": target_world, "wm": wm_world}
    geometry = {}
    for name, point in points.items():
        nearest = projections(point, config["roads"], radius, cm)
        geometry[name] = {"world": point, "nearestCenterline": nearest[0],
                          "minimumDistanceToErodedRoadCm": min(x["erodedRoadDistanceCm"] for x in nearest),
                          "centerlineWithin30cm": centreline_intervals(point, config["roads"], 30, cm)}
    nearest = geometry["target"]["nearestCenterline"]
    radii = {o["id"]: o["radius"] for o in config["objects"]}
    staging = []
    for distance_cm in (20, 14):
        for side in (-1, 1):
            point = [target_world[i] + side * distance_cm / cm * nearest["tangent"][i] for i in (0, 1)]
            road = projections(point, config["roads"], radius, cm)[0]
            gaps = [{"id": o["id"], "surfaceGapCm": (math.hypot(o["x"] - point[0], o["z"] - point[1])
                     - radius - radii[o["id"]]) * cm} for o in initial["objectState"]["packages"]]
            staging.append({"targetDistanceCm": distance_cm, "sideAlongTargetRoad": side,
                            "world": point, "onRoad": road["remainingLateralMarginCm"] >= 0,
                            "road": road, "knownObjectSurfaceGaps": gaps,
                            "allKnownObjectDiscsClear": all(g["surfaceGapCm"] >= 0 for g in gaps)})
    lower_events = [e for e in record["lines"] if e.get("event") in ("approach_graph_selected", "viewpoint_unreachable")
                    and e.get("key", "").startswith(nearest["roadId"] + "@")]
    out = {"schema": "wm-offline-road-geometry/v1", "taskId": record["taskId"], "map": args.map,
           "source": str(core), "sourceSha256": hashlib.sha256(core.read_bytes()).hexdigest(),
           "unitsPerMeter": units, "vehicleRadiusCm": radius * cm,
           "meaning": "exact piecewise-segment road corridor, eroded by vehicle radius; no simulation; object-disc checks listed separately",
           "limitations": "local geometry proves nonempty legal staging positions; it does not prove a collision-free connecting path from the actual final pose. WM input is the logged millimetre-rounded coordinate.",
           "targetAssociation": association, "geometry": geometry, "localStagingPositions": staging,
           "targetRoadApproachEvents": lower_events}
    path = args.round / f"{args.map}.road_geometry.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(path.resolve()), "geometry": geometry, "stagingAllOnRoadAndKnownObjectsClear": all(s["onRoad"] and s["allKnownObjectDiscsClear"] for s in staging)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
