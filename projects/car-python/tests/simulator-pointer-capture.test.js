const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");

function functionSource(name) {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(`).exec(appSource);
  assert.ok(declaration, `missing function ${name}`);
  const start = declaration.index;
  const openingBrace = appSource.indexOf("{", start + declaration[0].length);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openingBrace; index < appSource.length; index += 1) {
    const character = appSource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return appSource.slice(start, index + 1);
  }
  assert.fail(`unterminated function ${name}`);
}

function makeContext() {
  const captures = [];
  const releases = [];
  const context = vm.createContext({
    cameraMode: "follow",
    camera: { position: { x: 7, y: 8, z: 9 } },
    document: { querySelectorAll: () => [] },
    isOrbitDragging: false,
    lastPointer: null,
    orbitDistance: 0,
    orbitFollowsRobotTarget: false,
    orbitPitch: 0,
    orbitPointerId: null,
    orbitTarget: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    orbitYaw: 0,
    placeMode: null,
    robotPose: { x: 1, z: 2 },
    simulator: {
      setPointerCapture(pointerId) { captures.push(pointerId); },
      hasPointerCapture(pointerId) { return captures.includes(pointerId) && !releases.includes(pointerId); },
      releasePointerCapture(pointerId) { releases.push(pointerId); }
    },
    setTimeout(callback) { callback(); },
    updateGuangyangReliefVisibility() {}
  });
  vm.runInContext([
    functionSource("isSimulatorUiTarget"),
    functionSource("startOrbitDrag"),
    functionSource("endOrbitDrag")
  ].join("\n"), context);
  return { captures, context, releases };
}

test("HUD pointer sequence reaches its button without simulator pointer capture", () => {
  const { captures, context, releases } = makeContext();
  let buttonClicks = 0;
  const hudButton = {
    closest(selector) {
      assert.match(selector, /\.competition-hud/);
      return this;
    }
  };
  const pointer = { target: hudButton, pointerId: 41, pointerType: "mouse", buttons: 1, clientX: 100, clientY: 100 };

  context.startOrbitDrag(pointer);
  context.endOrbitDrag(pointer);
  buttonClicks += 1;

  assert.equal(buttonClicks, 1);
  assert.deepEqual(captures, [], "the simulator must not steal a HUD button's pointer");
  assert.deepEqual(releases, []);
  assert.equal(context.cameraMode, "follow", "a HUD click must not switch the camera to free orbit");
  assert.equal(context.orbitPointerId, null);
});

test("canvas pointerdown still enters free orbit and captures its pointer", () => {
  const { captures, context } = makeContext();
  const canvas = { closest() { return null; } };

  context.startOrbitDrag({
    target: canvas,
    pointerId: 42,
    pointerType: "mouse",
    buttons: 1,
    clientX: 120,
    clientY: 140
  });

  assert.deepEqual(captures, [42]);
  assert.equal(context.cameraMode, "free");
  assert.equal(context.orbitPointerId, 42);
  assert.equal(context.lastPointer.x, 120);
  assert.equal(context.lastPointer.y, 140);
});

test("map placement ignores clicks bubbling from simulator overlays", () => {
  const context = vm.createContext({
    placeMode: "block",
    raycastCount: 0,
    isOrbitDragging: false,
    isCompetitionMission: () => false,
    running: false,
    simulator: { getBoundingClientRect() { throw new Error("overlay click reached map placement"); } }
  });
  vm.runInContext([
    functionSource("isSimulatorUiTarget"),
    functionSource("placeObjectFromClick")
  ].join("\n"), context);
  const overlay = { closest() { return this; } };

  assert.doesNotThrow(() => context.placeObjectFromClick({ target: overlay, clientX: 0, clientY: 0 }));
});
