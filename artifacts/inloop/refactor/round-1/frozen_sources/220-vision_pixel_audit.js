#!/usr/bin/env node
"use strict";
// Offline only: replay the frozen pixel detector on saved native PNGs. Expose its
// existing private region stages in an isolated VM for explanation; no platform
// file, controller, simulator state, or detector threshold is modified.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { isDeepStrictEqual } = require("node:util");

const platform = process.env.GUANGYANG_PLATFORM_ROOT || "/Users/ken/Desktop/robot_competition-main/projects/car-python";
const { decodeStrictVisionPng } = require(path.join(platform, "backend/strict-png.js"));
const sourcePath = path.join(platform, "vision-pixel-core.js");
const source = fs.readFileSync(sourcePath, "utf8");
const hook = "  const DETECTOR_VERSION =";
assert.equal(source.split(hook).length, 2, "Pixel core instrumentation anchor changed");
const instrumented = source.replace(hook,
  "  globalThis.WmPixelStages = { findPixelRegions, isCompactVirtualObjectRegion, virtualPointDetection, assertCameraCalibration };\n" + hook);
const context = { module: { exports: {} }, Uint8Array, Uint8ClampedArray, Int32Array, Float32Array, Buffer };
vm.createContext(context);
vm.runInContext(instrumented, context, { filename: sourcePath });
const core = context.module.exports;
const stages = context.WmPixelStages;
const folder = path.resolve(process.argv[2] || "artifacts/inloop/stage-1/round-1");
const results = [];
const normalized = value => JSON.parse(JSON.stringify(value));
const files = fs.readdirSync(folder).filter(name => /^map-\d\d\.json$/.test(name)).sort();
for (const file of files) {
  const result = JSON.parse(fs.readFileSync(path.join(folder, file), "utf8"));
  assert.equal(result.taskId, "R2-GYI-MVP-02", "Only task 2 evidence is allowed");
  const archivePath = result.visionEvidenceFile;
  const archive = JSON.parse(fs.readFileSync(archivePath, "utf8"));
  assert.equal(archive.cameraDefinitionHash, core.CAMERA_DEFINITION_HASH, "Camera definition changed since run");
  assert.equal(archive.detectorDefinitionHash, core.DETECTOR_DEFINITION_HASH, "Detector definition changed since run");
  const frames = new Map(archive.frames.map(frame => [frame.evidenceId, frame]));
  const queries = archive.queries.filter(query => query.method === "observe").sort((a, b) => a.seq - b.seq);
  for (const [index, query] of queries.entries()) {
    const evidence = frames.get(query.evidenceId);
    assert.ok(evidence, `Missing frame for ${file} query ${query.seq}`);
    assert.equal(evidence.frameId, query.frameId);
    const image = path.resolve(path.dirname(archivePath), evidence.image);
    const bytes = fs.readFileSync(image);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), evidence.sha256);
    const decoded = decodeStrictVisionPng(bytes);
    const prepared = core.prepareVirtualFrame(decoded.rgba, { frameId: evidence.frameId });
    const detections = core.detectVirtualPixels(prepared);
    const projected = normalized(core.projectQuery("observe", query.args, detections));
    const regions = stages.findPixelRegions(prepared.rgba,
      (r, g, b) => r >= 52 && g <= 86 && b <= 92 && r - g >= 30 && r - b >= 26 && r >= g * 1.5 && r >= b * 1.38,
      2, (r, g, b) => r >= 100 && g <= 92 && b <= 96 && r - g >= 55 && r - b >= 48 && r >= g * 1.55 && r >= b * 1.45);
    const calibration = stages.assertCameraCalibration({});
    const target = core.DETECTOR_DEFINITION.classes.find(item => item.category === "target");
    const zones = detections.filter(item => ["storage-zone", "cleanup-zone"].includes(item.category));
    let rank = 0;
    const explained = regions.map(region => {
      const compact = stages.isCompactVirtualObjectRegion(region);
      const seeds = region.seedCount >= Math.max(6, region.count * 0.015);
      const selected = compact && seeds && rank++ < target.maximumRegions;
      const detection = selected ? stages.virtualPointDetection(prepared, calibration, region, target) : null;
      const suppressedBy = detection ? zones.filter(zone => {
        const cx = detection.box.x + detection.box.width / 2, cy = detection.box.y + detection.box.height / 2;
        return core.boxesOverlap(detection.box, zone.box) >= 0.03
          || (cx >= zone.box.x - 8 && cx <= zone.box.x + zone.box.width + 8
            && cy >= zone.box.y - 8 && cy <= zone.box.y + zone.box.height + 8);
      }).map(zone => ({ category: zone.category, box: zone.box })) : [];
      return { ...region, sourceImageBox: { x: region.x, y: region.y - 80, width: region.w, height: region.h },
        compact, enoughBrightSeeds: seeds, selectedBeforeZoneSuppression: selected,
        predictedBearingDeg: detection?.bearingDeg ?? null,
        predictedRawCm: detection ? Math.round(detection.distance * 12.5) : null,
        suppressedBy, survives: selected && suppressedBy.length === 0 };
    });
    results.push({ map: result.assignedMap, observe: index + 1, tick: evidence.tick, querySeq: query.seq,
      evidenceId: evidence.evidenceId, frameId: evidence.frameId, image, imageSha256: evidence.sha256,
      recomputedQueryMatches: isDeepStrictEqual(projected, query.result),
      recordedRaw: query.result, recomputedRaw: projected, detections: normalized(detections),
      redRegionCount: regions.length, redRegions: normalized(explained) });
  }
}
const report = { schema: "wm-native-pixel-audit/v1", offlineOnly: true,
  pixelCoreSource: sourcePath, pixelCoreSourceSha256: crypto.createHash("sha256").update(source).digest("hex"),
  cameraDefinitionHash: core.CAMERA_DEFINITION_HASH, detectorDefinitionHash: core.DETECTOR_DEFINITION_HASH,
  observes: results.length, matchingQueries: results.filter(row => row.recomputedQueryMatches).length,
  rows: results };
const output = path.join(folder, "pixel_audit.json");
fs.writeFileSync(output, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ output, observes: report.observes, matchingQueries: report.matchingQueries }));
if (report.observes !== report.matchingQueries) process.exitCode = 1;
