"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const scoring = require("../guangyang-scoring.js");
const navigation = require("../blockly-navigation-core.js");

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "x", "z", "point", "points", "position", "nearestPoint", "segmentIndex",
  "tangent", "tangentX", "tangentZ", "worldX", "worldZ"
].map(value => value.toLowerCase()));

function assertNoCoordinates(value, location = "result") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCoordinates(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.entries(value).forEach(([key, item]) => {
    assert.equal(FORBIDDEN_PUBLIC_KEYS.has(key.toLowerCase()), false, `${location}.${key} 泄露了坐标或折线几何`);
    assertNoCoordinates(item, `${location}.${key}`);
  });
}

test("Guangyang roads build a stable coordinate-free graph in centimeters", () => {
  const network = navigation.createNetwork(scoring.ROADS, {
    worldUnitsPerMeter: 8,
    vehicleRadiusWorld: scoring.VEHICLE_RADIUS
  });
  const graph = network.mapGraph();

  assert.equal(network.schemaVersion, "chenlong.blockly-navigation-core/v1");
  assert.equal(network.centimetersPerWorldUnit, 12.5);
  assert.equal(graph.schemaVersion, navigation.ROAD_GRAPH_SCHEMA_VERSION);
  assert.equal(graph.edges.length, 26);
  assert.equal(graph.nodes.length, 20);
  assert.deepEqual(graph.edges.map(edge => edge.roadId), [...graph.edges.map(edge => edge.roadId)].sort());
  const parking = graph.edges.find(edge => edge.roadId === "parking-connector");
  assert.deepEqual(parking, {
    roadId: "parking-connector",
    fromNodeId: "node:parking-connector:start",
    toNodeId: "node:central-north:start",
    lengthCm: 27.4,
    oneWay: false
  });
  assertNoCoordinates(graph);
  assert.ok(Object.isFrozen(graph));
  assert.ok(Object.isFrozen(graph.nodes));
  assert.ok(Object.isFrozen(graph.nodes[0]));
  assert.throws(() => { graph.edges[0].lengthCm = 999; }, TypeError);
});

test("anchorAt projects map points to road anchors without exposing coordinates", () => {
  const network = navigation.createNetwork(scoring.ROADS);
  const start = network.anchorAt(-2.4865, -7.6757, "start");
  assert.deepEqual(start, {
    id: "start",
    roadId: "parking-connector",
    progressCm: 0
  });
  assertNoCoordinates(start);
  assert.ok(Object.isFrozen(start));

  const anonymous = network.anchorAt(7.1815, -3.2587);
  assert.deepEqual(Object.keys(anonymous), ["roadId", "progressCm"]);
  assertNoCoordinates(anonymous);
  assert.throws(() => network.anchorAt(0, 0, ""), /锚点编号/);
});

test("project, pointAt and pathAlong provide frozen internal helpers for road controls", () => {
  const network = navigation.createNetwork(scoring.ROADS);
  const point = network.pointAt("central-north", 20);
  assert.equal(point.roadId, "central-north");
  assert.equal(point.progressCm, 20);
  assert.ok(Number.isFinite(point.x));
  assert.ok(Number.isFinite(point.z));
  assert.ok(Number.isFinite(point.tangentX));
  assert.ok(Number.isFinite(point.tangentZ));
  assert.ok(Object.isFrozen(point));

  const projected = network.project(point.x, point.z, "central-north");
  assert.equal(projected.roadId, "central-north");
  assert.equal(projected.progressCm, 20);
  assert.equal(projected.distanceCm, 0);
  assert.equal(projected.onRoad, true);

  const path = network.pathAlong("central-north", 5, 45);
  assert.ok(path.length >= 2);
  assert.ok(Object.isFrozen(path));
  assert.ok(path.every(Object.isFrozen));
  const reversed = network.pathAlong("central-north", 45, 5);
  assert.deepEqual(reversed[0], path.at(-1));
  assert.deepEqual(reversed.at(-1), path[0]);
});

test("roadState reports local road geometry and node exits without coordinates", () => {
  const network = navigation.createNetwork(scoring.ROADS);
  const start = network.roadState({ x: -2.4865, z: -7.6757, heading: Math.PI }, 100);
  assert.deepEqual(start, {
    onRoad: true,
    roadId: "parking-connector",
    roadIds: ["parking-connector"],
    lateralOffsetCm: 0,
    headingErrorDeg: 0,
    leftClearanceCm: 7.3,
    rightClearanceCm: 7.3,
    frontClearanceCm: 100,
    atJunction: false,
    junctionId: null,
    exits: [{ roadId: "parking-connector", direction: "straight", turnDeg: 0 }],
    roadProgressCm: 0,
    fromNodeId: "node:parking-connector:start",
    toNodeId: "node:central-north:start",
    atNode: true,
    nodeId: "node:parking-connector:start"
  });
  assertNoCoordinates(start);

  const junction = network.roadState({ x: -2.4865, z: -5.4826, heading: 0 }, Infinity);
  assert.equal(junction.onRoad, true);
  assert.equal(junction.atNode, true);
  assert.equal(junction.atJunction, true);
  assert.equal(junction.nodeId, "node:central-north:start");
  assert.equal(junction.junctionId, junction.nodeId);
  assert.equal(junction.frontClearanceCm, null);
  assert.deepEqual(new Set(junction.exits.map(exit => exit.roadId)), new Set([
    "central-north", "north-east-main", "north-west-main", "parking-connector"
  ]));
  assertNoCoordinates(junction);
});

test("roadState orients lateral clearance to the vehicle heading and keeps off-road selection local", () => {
  const network = navigation.createNetwork([
    { id: "vertical", width: 2, points: [[0, 2], [0, -2]] },
    { id: "far-aligned", width: 2, points: [[5, 2], [5, -2]] }
  ], { worldUnitsPerMeter: 1, vehicleRadiusWorld: 0.2, nodeRadiusCm: 10 });
  const state = network.roadState({ x: 0.25, z: 0, heading: 0 }, 150);
  assert.equal(state.roadId, "vertical");
  assert.equal(state.lateralOffsetCm, 25);
  assert.equal(state.leftClearanceCm, 105);
  assert.equal(state.rightClearanceCm, 55);

  const reverse = network.roadState({ x: 0.25, z: 0, heading: Math.PI }, 150);
  assert.equal(reverse.lateralOffsetCm, -25);
  assert.equal(reverse.leftClearanceCm, 55);
  assert.equal(reverse.rightClearanceCm, 105);

  const offRoad = network.roadState({ x: 2, z: 0, heading: 0 }, null);
  assert.equal(offRoad.onRoad, false);
  assert.equal(offRoad.roadId, "vertical", "离线时必须选择最近道路，而不是按朝向选择远路");
  assert.deepEqual(offRoad.roadIds, []);
  assert.equal(offRoad.atNode, false);
});

test("topology exits reject a one-way road entering the node", () => {
  const roads = [
    { id: "south", width: 2, points: [[0, 2], [0, 0]] },
    { id: "north", width: 2, points: [[0, 0], [0, -2]] },
    { id: "west", width: 2, points: [[0, 0], [-2, 0]] },
    { id: "east", width: 2, points: [[0, 0], [2, 0]] },
    { id: "inbound", width: 2, oneWay: true, points: [[2, 2], [0, 0]] }
  ];
  const network = navigation.createNetwork(roads, {
    worldUnitsPerMeter: 1,
    vehicleRadiusWorld: 0.2,
    nodeRadiusCm: 20
  });
  const state = network.roadState({ x: 0, z: 0, heading: 0 }, 200);
  assert.equal(state.atJunction, true);
  assert.equal(state.exits.some(exit => exit.roadId === "inbound"), false);
  assert.deepEqual(state.exits, [
    { roadId: "west", direction: "left", turnDeg: 90 },
    { roadId: "north", direction: "straight", turnDeg: 0 },
    { roadId: "east", direction: "right", turnDeg: -90 },
    { roadId: "south", direction: "back", turnDeg: -180 }
  ]);
});

test("network validation rejects malformed geometry and unsafe identifiers", () => {
  assert.throws(() => navigation.createNetwork([]), /道路数量/);
  assert.throws(() => navigation.createNetwork([
    { id: "same", width: 1, points: [[0, 0], [1, 0]] },
    { id: "same", width: 1, points: [[1, 0], [2, 0]] }
  ]), /道路编号不能重复/);
  assert.throws(() => navigation.createNetwork([
    { id: "bad", width: 0, points: [[0, 0], [1, 0]] }
  ]), /宽度必须大于/);
  assert.throws(() => navigation.createNetwork([
    { id: "loop", width: 1, points: [[0, 0], [1, 0], [0, 0]] }
  ]), /端点自环/);
  assert.throws(() => navigation.createNetwork([
    { id: "bad\nroad", width: 1, points: [[0, 0], [1, 0]] }
  ]), /可打印字符/);
  const network = navigation.createNetwork([{ id: "road", width: 1, points: [[0, 0], [1, 0]] }]);
  assert.throws(() => network.pointAt("missing", 0), /道路不存在/);
  assert.throws(() => network.roadState({ x: 0, z: 0, heading: 0 }, -1), /前方净空/);
});
