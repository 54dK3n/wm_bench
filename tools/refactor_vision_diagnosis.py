#!/usr/bin/env python3
"""Offline first-camera-frame/environment diagnosis; never starts a simulator.

Reads preserved task-2 records/PNGs and the configured platform's pure PNG/pixel
modules. Writes one diagnostic JSON only; does not change a comparison gate.
"""
import argparse
import base64
import difflib
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

from platform_paths import ROOT, file_reference, platform_root, recorded_repository_path, repository_path


NODE_AUDIT = r'''
const fs = require("node:fs"), path = require("node:path"), util = require("node:util");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const core = require(path.join(input.platform, "vision-pixel-core.js"));
const {decodeStrictVisionPng} = require(path.join(input.platform, "backend/strict-png.js"));
function pixelDifference(a, b) {
  const mask = new Uint8Array(640 * 480), byBand = Array(6).fill(0);
  let changed=0, maximum=0, absolute=0, xmin=640, ymin=480, xmax=-1, ymax=-1;
  for(let p=0; p<mask.length; p++) {
    let different=false;
    for(let c=0;c<4;c++){ const d=Math.abs(a[p*4+c]-b[p*4+c]); absolute+=d;maximum=Math.max(maximum,d);different ||= d>0; }
    if(different){mask[p]=1;changed++;const x=p%640,y=Math.floor(p/640);byBand[Math.floor(y/80)]++;xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);}
  }
  const regions=[];
  for(let start=0;start<mask.length;start++) {
    if(mask[start]!==1)continue;
    const stack=[start]; mask[start]=2;let count=0,x0=640,y0=480,x1=-1,y1=-1;
    while(stack.length){const p=stack.pop(),x=p%640,y=Math.floor(p/640);count++;x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);
      for(const q of [x>0?p-1:-1,x<639?p+1:-1,y>0?p-640:-1,y<479?p+640:-1])if(q>=0&&mask[q]===1){mask[q]=2;stack.push(q);}}
    regions.push({pixels:count,box:{x:x0,y:y0,width:x1-x0+1,height:y1-y0+1}});
  }
  return {changed_pixels:changed,total_pixels:mask.length,changed_fraction:changed/mask.length,
    max_channel_difference:maximum,absolute_channel_difference:absolute,
    bbox:changed?{x:xmin,y:ymin,width:xmax-xmin+1,height:ymax-ymin+1}:null,
    changed_pixels_by_80px_y_band:byBand,connected_regions:regions.sort((a,b)=>b.pixels-a.pixels).slice(0,20)};
}
const rows=input.rows.map(row=>{
  const images=[], frames={};
  for(const side of ["baseline","candidate"]){
    const frame=row[side]; const decoded=decodeStrictVisionPng(fs.readFileSync(frame.image_path));
    images.push(decoded.rgba);
    const prepared=core.prepareVirtualFrame(decoded.rgba,{frameId:frame.frameId});
    const detections=core.detectVirtualPixels(prepared);
    const projected=JSON.parse(JSON.stringify(core.projectQuery("observe",frame.args,detections)));
    frames[side]={recomputed_raw:projected,matches_recorded:util.isDeepStrictEqual(projected,frame.result),
      detections:detections.map(item=>({category:item.category,bearingDeg:item.bearingDeg,confidence:item.confidence,
        distance:item.distance,sourceImageBox:{...item.box,y:item.box.y-80}}))};
  }
  return {map:row.map,...frames,pixels:pixelDifference(...images)};
});
console.log(JSON.stringify({camera_definition_hash:core.CAMERA_DEFINITION_HASH,
  detector_definition_hash:core.DETECTOR_DEFINITION_HASH,rows}));
'''


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


class Inputs:
    def __init__(self):
        self.used = {}

    def read(self, path):
        path = Path(path).resolve()
        data = path.read_bytes()
        self.used[file_reference(path)] = {"bytes": len(data), "sha256": sha_bytes(data)}
        return data

    def json(self, path):
        return json.loads(self.read(path))


def canonical_manifest(raw):
    output = {}
    for key, digest in raw.items():
        path = Path(key)
        if not path.is_absolute():
            reference = key
        elif "car-python" in path.parts:
            reference = "@platform/" + Path(*path.parts[path.parts.index("car-python") + 1:]).as_posix()
        elif path.is_relative_to(ROOT):
            reference = path.relative_to(ROOT).as_posix()
        elif "wm_bench" in path.parts:
            reference = Path(*path.parts[path.parts.index("wm_bench") + 1:]).as_posix()
        else:
            reference = key
        output[reference] = digest
    return output


def read_first_frame(inputs, folder, name):
    raw_path = folder / (name + ".json")
    raw = inputs.json(raw_path)
    if raw["taskId"] != "R2-GYI-MVP-02":
        raise ValueError("Only task 2 evidence is accepted")
    record_path = recorded_repository_path(raw["fullRecordFile"])
    record = inputs.json(record_path)
    vision_path = recorded_repository_path(raw["visionEvidenceFile"])
    vision = inputs.json(vision_path)
    index, query = next((index, query) for index, query in enumerate(record["inputs"])
                        if query.get("type") == "vision_query" and query.get("method") == "observe")
    frame = next(frame for frame in vision["frames"] if frame["evidenceId"] == query["evidenceId"])
    native = next(frame for frame in record["visionFrames"] if frame["evidenceId"] == query["evidenceId"])
    truth = next(frame for frame in vision["renderTruth"]["frames"] if frame["evidenceId"] == query["evidenceId"])
    image_path = vision_path.parent / frame["image"]
    picture = inputs.read(image_path)
    checks = {
        "native_png_bytes_exact": picture == base64.b64decode(native["pngBase64"], validate=True),
        "image_hash_exact": sha_bytes(picture) == frame["sha256"] == native["sha256"] == truth["imageSha256"],
        "run_id_exact": raw["record"]["top"]["runId"] == record["runId"] == vision["runId"] == truth["runId"],
        "frame_id_exact": query["frameId"] == frame["frameId"] == native["frameId"] == truth["frameId"],
        "tick_exact": query["tick"] == frame["tick"] == native["tick"] == truth["captureTick"] == truth["evidenceTick"],
        "revision_exact": frame["stateRevision"] == native["stateRevision"] == truth["captureStateRevision"] == truth["evidenceStateRevision"],
        "exact_render_truth": truth["sameTickAndRevision"] is True and truth["exactRenderState"] is True,
        "query_export_exact": query in vision["queries"],
    }
    return {"input_index": index, "query": query, "frame": {key: value for key, value in frame.items() if key != "image"},
            "image": file_reference(image_path), "capture_truth": truth, "binding_checks": checks,
            "record_definitions": {key: value for key, value in record.items() if key.endswith("Definition") or key == "randomSeed"}}, {
        "image_path": str(image_path), "frameId": frame["frameId"], "args": query.get("args"), "result": query["result"]}


def diagnose(baseline, candidate, node):
    inputs = Inputs()
    platform = platform_root()
    old_manifest = canonical_manifest(inputs.json(baseline / "code_manifest.json"))
    new_manifest = canonical_manifest(inputs.json(candidate / "code_manifest.json"))
    shared = {key: {"baseline_sha256": old_manifest[key], "candidate_sha256": new_manifest[key],
                    "same": old_manifest[key] == new_manifest[key]}
              for key in sorted(set(old_manifest) & set(new_manifest))
              if key.startswith("@platform/") or key in {"tools/inloop_driver.js", "tools/vision_truth_hook.js", "tools/demo_keyframes_hook.js"}}
    old_index = inputs.json(baseline / "frozen_sources/INDEX.json")
    old_driver_entry = next(entry for name, entry in old_index.items() if name.endswith("/tools/inloop_driver.js"))
    old_driver = inputs.read(baseline / old_driver_entry["archive"]).decode()
    new_driver = inputs.read(ROOT / "tools/inloop_driver.js").decode()
    for reference, entry in shared.items():
        path = platform / reference[len("@platform/"):] if reference.startswith("@platform/") else ROOT / reference
        entry["current_sha256"] = sha_bytes(inputs.read(path))
        entry["current_matches_candidate_freeze"] = entry["current_sha256"] == entry["candidate_sha256"]
    driver_archive_valid = sha_bytes(old_driver.encode()) == old_manifest["tools/inloop_driver.js"] == old_driver_entry["sha256"]
    resources = []
    resource_names = {"app.js", "vision.js", "vision-pixel-core.js", "backend/strict-png.js", "server.js"}
    for file in platform.rglob("*"):
        rel = file.relative_to(platform)
        if any(part in {".git", "node_modules", "data"} for part in rel.parts):
            continue
        if file.is_file() and (rel.as_posix() in resource_names or file.suffix in {".wasm", ".onnx", ".png", ".jpg", ".glb", ".gltf"}):
            content = inputs.read(file)
            key = "@platform/" + rel.as_posix()
            resources.append({"path": key, "bytes": len(content), "current_sha256": sha_bytes(content),
                              "baseline_locked_sha256": old_manifest.get(key), "candidate_locked_sha256": new_manifest.get(key),
                              "candidate_frozen_match": sha_bytes(content) == new_manifest[key] if key in new_manifest else None})
    comparisons, node_rows = [], []
    for number in range(1, 11):
        name = f"map-{number:02d}"
        old, old_node = read_first_frame(inputs, baseline, name)
        new, new_node = read_first_frame(inputs, candidate, name)
        comparisons.append({"map": name, "baseline": old, "candidate": new,
                            "same_vehicle": old["capture_truth"]["vehicle"] == new["capture_truth"]["vehicle"],
                            "same_camera_matrix_and_basis": old["capture_truth"]["camera"] == new["capture_truth"]["camera"],
                            "same_package_state": old["capture_truth"]["objectState"] == new["capture_truth"]["objectState"],
                            "same_run_definitions": old["record_definitions"] == new["record_definitions"],
                            "same_png": old["frame"]["sha256"] == new["frame"]["sha256"],
                            "same_raw_detection_result": old["query"]["result"] == new["query"]["result"]})
        node_rows.append({"map": name, "baseline": old_node, "candidate": new_node})
    pixel_process = subprocess.run([node, "-e", NODE_AUDIT], input=json.dumps({"platform": str(platform), "rows": node_rows}),
                                   text=True, capture_output=True, check=True)
    pixels = json.loads(pixel_process.stdout)
    for row, pixel in zip(comparisons, pixels["rows"]):
        if row["map"] != pixel["map"]:
            raise ValueError("Pixel comparison order differs")
        row["pixel_replay"] = pixel
    current_checks = {key: (platform / key[len("@platform/"):]).is_file()
                      and sha_bytes((platform / key[len("@platform/"):]).read_bytes()) == value
                      for key, value in new_manifest.items() if key.startswith("@platform/")}
    unchanged = {reference: sha_bytes((platform / reference[len("@platform/"):] if reference.startswith("@platform/") else ROOT / reference).read_bytes()) == entry["sha256"]
                 for reference, entry in inputs.used.items()}
    return {"schema": "refactor-vision-diagnosis/v1", "offline_only": True,
            "baseline": file_reference(baseline), "candidate": file_reference(candidate),
            "summary": {"maps": len(comparisons), "first_frame_png_equal_maps": sum(row["same_png"] for row in comparisons),
                        "first_raw_results_equal_maps": sum(row["same_raw_detection_result"] for row in comparisons),
                        "equal_pose_camera_objects_maps": sum(row["same_vehicle"] and row["same_camera_matrix_and_basis"] and row["same_package_state"] for row in comparisons),
                        "first_frames_exact_bound": sum(all(row[side]["binding_checks"].values()) for row in comparisons for side in ("baseline", "candidate")),
                        "current_pixel_detector_exact_replays": sum(row["pixel_replay"][side]["matches_recorded"] for row in comparisons for side in ("baseline", "candidate"))},
            "shared_frozen_environment": shared, "current_platform_frozen_checks": current_checks,
            "baseline_driver_archive_hash_valid": driver_archive_valid,
            "current_pixel_definition_matches_all_native_frames": all(
                row[side]["frame"]["cameraDefinitionHash"] == pixels["camera_definition_hash"]
                and row[side]["frame"]["detectorDefinitionHash"] == pixels["detector_definition_hash"]
                for row in comparisons for side in ("baseline", "candidate")),
            "driver_diff": list(difflib.unified_diff(old_driver.splitlines(), new_driver.splitlines(), fromfile="r3 frozen driver", tofile="refactor r1 frozen driver", lineterm="")),
            "resources": resources, "first_frames": comparisons,
            "source_mechanism": {
                "app.js:14311": "animate(timestamp) passes requestAnimationFrame wall-time seconds to animateSceneEffects.",
                "app.js:14337-14343": "mazeSignal ring/beam opacity and core vertical position/rotation depend on that time.",
                "app.js:10399-10440": "Guangyang mission checkpoints create those scene meshes; they are not marked hideFromVirtualCamera.",
                "app.js:7984-7990": "capture updates the virtual camera pose and renders existing scene; it does not reset animated scene effects to simulation tick.",
                "vision.js:692-719": "Virtual mode uses pure pixel detector; no local teaching templates or YOLO model inference.",
                "tools/vision_truth_hook.js:25-35": "Exact driver truth snapshots pose/camera/package state, not animation phase, light state or complete scene graph."},
            "visual_inspection": {
                "map-05": "Viewed both native first PNGs: central orange checkpoint diamond differs in vertical extent/shape and beam appearance; background road shading also differs.",
                "map-01": "Viewed both native first PNGs: cyan checkpoint diamond width/shape and transparent beam differ, although vehicle/camera/packages match.",
                "map-09": "Viewed both native first PNGs: purple checkpoint diamond position/shape and beam differ, although vehicle/camera/packages match."},
            "conclusions": [
                "Recorded camera inputs differ before the first robot motion, with identical captured vehicle/camera/package state.",
                "Saved PNGs reproduce their own recorded detector outputs using the same current pure pixel implementation; first-frame detection differences are image-content differences, not inference randomness on identical images.",
                "Wall-clock checkpoint animation is an identified non-deterministic camera-input mechanism consistent with visible differences. Its exact wall-time phase was not recorded, so it is not a complete reconstruction or exclusive attribution of every changed pixel.",
                "The historical r3 manifest locked only competition-core.js and python-worker.js externally. Other historical renderer/vision/resource bytes cannot be proven equal from that manifest; missing provenance is not evidence of an actual source change.",
                "A simulator-timed animation or hidden checkpoint overlay would change platform rendering behavior, not merely refactor runtime source. No such change or gate relaxation is performed here."],
            "inputs_unchanged": all(unchanged.values()), "input_hash_checks": unchanged, "inputs": inputs.used}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", default="artifacts/inloop/opt-2/round-3")
    parser.add_argument("--candidate", default="artifacts/inloop/refactor/round-1")
    parser.add_argument("--out", default="artifacts/inloop/refactor/round-1/vision-diagnosis.json")
    parser.add_argument("--node", default=shutil.which("node"))
    args = parser.parse_args()
    report = diagnose(repository_path(args.baseline), repository_path(args.candidate), args.node)
    output = repository_path(args.out)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": file_reference(output), **report["summary"], "inputs_unchanged": report["inputs_unchanged"]}))


if __name__ == "__main__":
    main()
