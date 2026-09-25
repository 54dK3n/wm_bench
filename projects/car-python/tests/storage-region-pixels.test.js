const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { detectStorageRegions } = require("../storage-region-pixels.js");
const { sanitizeResponse } = require("../robot-bridge-contract.js");

function image() { return { width: 640, height: 480, data: new Uint8ClampedArray(640 * 480 * 4) }; }
function pixel(frame, x, y, color = [0, 255, 0, 255]) { frame.data.set(color, (y * frame.width + x) * 4); }
function rectangle(frame, x, y, w, h, color) {
  for (let row = y; row < y + h; row += 1) for (let column = x; column < x + w; column += 1) {
    pixel(frame, column, row, color);
  }
}

test("ground detection uses source pixels, preserves input, and produces bridge-safe bounds", () => {
  const frame = image();
  rectangle(frame, 100, 320, 101, 61);
  // Ball occlusion does not supply a location hint to the sensor.
  rectangle(frame, 130, 340, 20, 20, [255, 0, 0, 255]);
  const original = frame.data.slice();
  const result = detectStorageRegions(frame);
  assert.deepEqual(result, [{ category: "storage-zone", confidence: 1, source: "storage-ground-pixels",
    bbox: { x: 100, y: 320, w: 101, h: 61 }, pixelCount: 101 * 61 - 400 }]);
  assert.deepEqual(frame.data, original);
  assert.deepEqual(sanitizeResponse("observe", { frameId: 1, tick: 0, width: 640, height: 480, detections: result }).detections,
    [{ category: "storage-zone", confidence: 1, bbox: { x: 100, y: 320, w: 101, h: 61 }, source: "storage-ground-pixels" }]);
});

test("old upright green sign and all other chroma produce no ground detection", () => {
  const frame = image();
  for (const [index, color] of [[34,197,94,255], [0,254,0,255], [0,255,0,128], [0,0,255,255], [255,0,0,255]].entries()) {
    rectangle(frame, index * 30, 0, 20, 100, color);
  }
  assert.deepEqual(detectStorageRegions(frame), []);
});

test("clipped, disconnected and diagonal regions retain only visible inclusive bounds", () => {
  const frame = image();
  rectangle(frame, 620, 470, 20, 10);
  rectangle(frame, 0, 0, 3, 2);
  pixel(frame, 3, 2); // Diagonal contact is not 4-connected.
  assert.deepEqual(detectStorageRegions(frame).map(item => [item.bbox, item.pixelCount]), [
    [{ x: 620, y: 470, w: 20, h: 10 }, 200],
    [{ x: 0, y: 0, w: 3, h: 2 }, 6],
    [{ x: 3, y: 2, w: 1, h: 1 }, 1]
  ]);
});

test("invalid image shape and non-RGBA8 inputs fail explicitly", () => {
  for (const value of [null, { width: 10, height: 10, data: new Uint8Array(400) },
    { width: 640, height: 480, data: new Float32Array(640 * 480 * 4) },
    { width: 640, height: 480, data: new Uint8Array(3) }]) {
    assert.throws(() => detectStorageRegions(value), /640x480 RGBA8/);
  }
});

function marker(backend, role) {
  const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
  const start = source.indexOf("function addObjectTaskZoneMarker(");
  const end = source.indexOf("\n}", start) + 2;
  class Object3D {
    constructor() { this.children = []; this.userData = {}; this.rotation = {};
      this.position = { set: (x,y,z) => { this.position.x=x; this.position.y=y; this.position.z=z; } };
      this.scale = { set() {} }; }
    add(child) { this.children.push(child); }
  }
  class Mesh extends Object3D { constructor(geometry, material) { super(); this.geometry=geometry; this.material=material; } }
  class Geometry { constructor(...args) { this.args=args; } }
  class Material { constructor(options) { Object.assign(this, options); } }
  class Light extends Object3D {}
  const context = vm.createContext({
    robotBackendMode: backend, normalizeGuangyangObjectRole: value => value,
    GUANGYANG_OBJECT_ROLE_META: { storage: { color: "#22c55e", category: "storage-zone" }, cleanup: { color: "#f97316" } },
    THREE: { Group: Object3D, Mesh, CircleGeometry: Geometry, RingGeometry: Geometry, CylinderGeometry: Geometry,
      MeshBasicMaterial: Material, MeshStandardMaterial: Material, DoubleSide: 2, PointLight: Light },
    activeMission: { environment: "guangyang" }, goalPulseEffects: [], enableObjectShadows() {},
    scene: { add() {} }, markerMeshes: [], createTextLabel: () => new Object3D()
  });
  vm.runInContext(source.slice(start, end), context);
  return context.addObjectTaskZoneMarker({ role, position: [3, 4], radius: 1.2 });
}

test("only backend storage exposes an opaque unlit ground disk with unchanged zone anchor/radius", () => {
  const backend = marker(true, "storage");
  const legacy = marker(false, "storage");
  const cleanup = marker(true, "cleanup");
  assert.deepEqual([backend.position.x, backend.position.y, backend.position.z], [3, .09, 4]);
  const fill = backend.children[0];
  assert.equal(fill.geometry.args[0], 1.2);
  assert.equal(fill.position.y, .012);
  assert.equal(fill.material.color, "#00ff00");
  assert.equal(fill.material.opacity, 1);
  assert.equal(fill.material.transparent, false);
  assert.equal(fill.material.toneMapped, false);
  assert.equal(fill.material.fog, false);
  assert.equal(fill.userData.hideFromVirtualCamera, false);
  assert.equal(backend.children[1].userData.hideFromVirtualCamera, true);
  assert.equal(legacy.children[0].userData.hideFromVirtualCamera, true);
  assert.equal(cleanup.children[0].userData.hideFromVirtualCamera, true);
  assert.equal(legacy.children[0].geometry.args[0], 1.16);
});
