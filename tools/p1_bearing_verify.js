"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const core = require(path.join(process.env.GUANGYANG_PLATFORM_ROOT
  || "/Users/ken/Desktop/robot_competition-main/projects/car-python", "vision-pixel-core.js"));

const CAMERA = core.CAMERA_DEFINITION;
const FOCAL = (CAMERA.source.height / 2) / Math.tan(CAMERA.verticalFovDegrees * Math.PI / 360);
const OPTICAL_CENTER_X = CAMERA.letterbox.padX
  + CAMERA.source.width * CAMERA.letterbox.scale / 2;

function boxForAngle(deg, width = 12) {
  const center = OPTICAL_CENTER_X + FOCAL * Math.tan(deg * Math.PI / 180);
  return { x: center - width / 2, y: 200, width, height: 24 };
}

const samples = [-30, -20, -10, -6, -2, 0, 2, 6, 10, 20, 30];
const correctnessRows = samples.slice(0, 10).map(expected => {
  const measured = core.bearingDegForBox(boxForAngle(expected));
  return {
    expectedDeg: expected,
    measuredDeg: Number(measured.toFixed(4)),
    errorDeg: Number((measured - expected).toFixed(4))
  };
});
const maxError = Math.max(...correctnessRows.map(row => Math.abs(row.errorDeg)));
assert.ok(maxError <= 1.5, `max error ${maxError}`);

const consistencyRows = [-6.8, -7, 0, 7, 6.8, -3, 3, -6, 6, 0.5].map(angle => {
  const box = boxForAngle(angle);
  const measured = core.bearingDegForBox(box);
  return {
    angleDeg: angle,
    measuredDeg: Number(measured.toFixed(4)),
    direction: core.directionForBox(box),
    signMatches: angle < 0 ? measured < 0 : angle > 0 ? measured > 0 : measured === 0
  };
});
for (const row of consistencyRows) {
  if (Math.abs(row.angleDeg) < 7) assert.equal(row.direction, "中间", JSON.stringify(row));
  if (row.angleDeg < -7) assert.equal(row.direction, "左", JSON.stringify(row));
  if (row.angleDeg > 7) assert.equal(row.direction, "右", JSON.stringify(row));
  assert.equal(row.signMatches, true, JSON.stringify(row));
}

const rangeRows = [0, 1, 319, 320, 321, 639].map(x => {
  const measured = core.bearingDegForBox({ x, y: 200, width: 1, height: 1 });
  return { x, measuredDeg: Number(measured.toFixed(4)) };
});
for (const row of rangeRows) assert.ok(Math.abs(row.measuredDeg) <= 37.6, JSON.stringify(row));

const report = {
  focalPixels: Number(FOCAL.toFixed(4)),
  opticalCenterX: OPTICAL_CENTER_X,
  maxErrorDeg: Number(maxError.toFixed(4)),
  correctnessRows,
  consistencyRows,
  rangeRows,
  pass: true
};
console.log(JSON.stringify(report, null, 2));
