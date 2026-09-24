"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  GUANGYANG_ISLAND_CONFIG,
  PackageStateEngine,
  geometry,
  normalizeInteractionDefinition
} = require("../competition-core.js");
const {
  PRIVATE_LAYOUT_CATALOG_SCHEMA_VERSION,
  PRIVATE_LAYOUT_SCHEMA_VERSION,
  PRIVATE_ANCHOR_SCHEMA_VERSION,
  PRIVATE_LAYOUT_SELECTION_SCHEMA_VERSION,
  PUBLIC_LAYOUT_PROJECTION_SCHEMA_VERSION,
  GUANGYANG_LAYOUT_SELECTION_POLICY_VERSION,
  GUANGYANG_RANKED_LAYOUT_FORM_VERSION,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_REGISTRY,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_VERSION,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1_VERSION,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION,
  GUANGYANG_RANKED_LAYOUT_FORM_V2,
  GUANGYANG_PRACTICE_LAYOUT_POOL_V2,
  createGuangyangInteractionDefinition,
  getGuangyangPrivateLayoutCatalog,
  privateLayoutCatalogSummary,
  projectPublicLayoutSelection,
  selectPracticeGuangyangLayoutSequence,
  selectRankedGuangyangLayoutSequence,
  selectGuangyangLayoutSequence,
  validateGuangyangLayoutCatalog
} = require("../backend/guangyang-private-layout-catalog.js");

const ROOT = path.resolve(__dirname, "..");
const SECRET = Buffer.from("98b2c627705bf4e66d9bf738aeed4a643903f0cd50a7ca2229699f7e9d32f20a", "hex");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function grabPoseCandidates(item) {
  const match = geometry.nearestRoad([item.x, item.z], GUANGYANG_ISLAND_CONFIG.roads, item.radius);
  const length = Math.hypot(match.tangent[0], match.tangent[1]);
  const tangent = [match.tangent[0] / length, match.tangent[1] / length];
  return [-1, 1].map(sign => {
    const direction = [tangent[0] * sign, tangent[1] * sign];
    return {
      x: item.x - direction[0],
      z: item.z - direction[1],
      heading: Math.atan2(-direction[0], -direction[1])
    };
  }).filter(pose => geometry.nearestRoad(
    [pose.x, pose.z],
    GUANGYANG_ISLAND_CONFIG.roads,
    GUANGYANG_ISLAND_CONFIG.rules.vehicleRadius + 0.005
  ).onRoad);
}

test("private Guangyang catalog validates every finite same-map three-role layout", () => {
  const catalog = validateGuangyangLayoutCatalog(GUANGYANG_PRIVATE_LAYOUT_CATALOG);
  assert.equal(catalog.schemaVersion, PRIVATE_LAYOUT_CATALOG_SCHEMA_VERSION);
  assert.equal(catalog.catalogVersion, GUANGYANG_PRIVATE_LAYOUT_CATALOG_VERSION);
  assert.equal(catalog.layoutSchemaVersion, PRIVATE_LAYOUT_SCHEMA_VERSION);
  assert.equal(catalog.anchorSchemaVersion, PRIVATE_ANCHOR_SCHEMA_VERSION);
  assert.equal(catalog.mapId, GUANGYANG_ISLAND_CONFIG.mapId);
  assert.equal(catalog.mapVersion, GUANGYANG_ISLAND_CONFIG.mapVersion);
  assert.ok(catalog.layouts.length >= 3);
  assert.deepEqual(privateLayoutCatalogSummary(catalog).anchorsByRole, {
    target: 6,
    distractor: 6,
    obstacle: 6
  });

  for (const layout of catalog.layouts) {
    const interaction = createGuangyangInteractionDefinition(layout.id, { catalog });
    assert.deepEqual(interaction, normalizeInteractionDefinition(interaction));
    assert.deepEqual(interaction.packages.map(item => item.role), ["target", "distractor", "obstacle"]);
    assert.deepEqual(interaction.packages.map(item => item.id), [
      "guangyang-target-1", "guangyang-distractor-1", "guangyang-obstacle-1"
    ]);

    for (const role of ["target", "distractor"]) {
      const item = interaction.packages.find(candidate => candidate.role === role);
      const grabbable = grabPoseCandidates(item).some(pose => {
        const engine = new PackageStateEngine(interaction);
        return engine.applyGrab({ packageId: item.id }, pose).accepted;
      });
      assert.equal(grabbable, true, `${layout.id} ${role} remains grabbable from a legal road pose`);
    }
    const obstacle = interaction.packages.find(item => item.role === "obstacle");
    const obstaclePose = grabPoseCandidates(obstacle)[0];
    assert.equal(new PackageStateEngine(interaction)
      .applyGrab({ packageId: obstacle.id }, obstaclePose).reason, "not_grabbable");
  }
});

test("legacy v1 aliases and keyed sequence remain byte-for-byte compatible", () => {
  assert.equal(GUANGYANG_PRIVATE_LAYOUT_CATALOG, GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1);
  assert.equal(GUANGYANG_PRIVATE_LAYOUT_CATALOG_VERSION,
    GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1_VERSION);
  assert.equal(getGuangyangPrivateLayoutCatalog(GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1_VERSION),
    GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1);
  assert.equal(GUANGYANG_PRIVATE_LAYOUT_CATALOG_REGISTRY[GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1_VERSION],
    GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1);

  const sequence = selectGuangyangLayoutSequence({
    secret: SECRET,
    seed: "team-zxh:heat-4",
    count: 5
  });
  assert.deepEqual(sequence.map(item => ({
    layoutId: item.layoutId,
    layoutCommitment: item.layoutCommitment
  })), [
    { layoutId: "gyi-layout-f6", layoutCommitment: "0e49418c066def69a53c04b4a9ffc77761c73a8d12e90a609c2a83c1c8ed31ad" },
    { layoutId: "gyi-layout-d4", layoutCommitment: "ff3cb107da71ae1498a868421c99f9dfc0d234e9ee590203461b0a3b947e1f7c" },
    { layoutId: "gyi-layout-c3", layoutCommitment: "97de07a1029f373360ba83fecb41b17bf5906ed59d1f0b589117548eef37395b" },
    { layoutId: "gyi-layout-a1", layoutCommitment: "c09b5e6637bf915293d785f3c9f12b79d860348293b8c7d691f907998f8f85ec" },
    { layoutId: "gyi-layout-e5", layoutCommitment: "34b0025c399953e1166cc0dbeb46119d5c6adc732d813d1cfc715cbcc43e61d3" }
  ]);
});

test("v2 freezes all 198 strictly legal anchor assignments and partitions ranked from practice", () => {
  const catalog = GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2;
  assert.deepEqual(validateGuangyangLayoutCatalog(catalog), catalog);
  assert.equal(catalog.catalogVersion, GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION);
  assert.equal(catalog.layouts.length, 198);
  assert.equal(getGuangyangPrivateLayoutCatalog(GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION), catalog);
  assert.equal(GUANGYANG_PRIVATE_LAYOUT_CATALOG_REGISTRY[GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION],
    catalog);

  const ids = new Set(catalog.layouts.map(layout => layout.id));
  const expectedIds = new Set();
  const excludedIds = new Set();
  for (let target = 1; target <= 6; target += 1) {
    for (let distractor = 1; distractor <= 6; distractor += 1) {
      for (let obstacle = 1; obstacle <= 6; obstacle += 1) {
        const id = `gyi-v2-t${target}d${distractor}o${obstacle}`;
        if ((distractor === 3 && obstacle === 4)
          || (distractor === 4 && obstacle === 5)
          || (distractor === 6 && obstacle === 6)) excludedIds.add(id);
        else expectedIds.add(id);
      }
    }
  }
  assert.equal(excludedIds.size, 18);
  assert.deepEqual(ids, expectedIds);

  assert.equal(GUANGYANG_RANKED_LAYOUT_FORM_V2.length, 5);
  assert.equal(new Set(GUANGYANG_RANKED_LAYOUT_FORM_V2).size, 5);
  assert.equal(GUANGYANG_PRACTICE_LAYOUT_POOL_V2.length, 193);
  assert.ok(GUANGYANG_RANKED_LAYOUT_FORM_V2.every(id => ids.has(id)));
  assert.ok(GUANGYANG_PRACTICE_LAYOUT_POOL_V2.every(id => (
    ids.has(id) && !GUANGYANG_RANKED_LAYOUT_FORM_V2.includes(id)
  )));
  assert.equal(new Set([
    ...GUANGYANG_RANKED_LAYOUT_FORM_V2,
    ...GUANGYANG_PRACTICE_LAYOUT_POOL_V2
  ]).size, 198);

  const layoutById = new Map(catalog.layouts.map(layout => [layout.id, layout]));
  for (const field of ["targetAnchorId", "distractorAnchorId", "obstacleAnchorId"]) {
    assert.equal(new Set(GUANGYANG_RANKED_LAYOUT_FORM_V2
      .map(id => layoutById.get(id)[field])).size, 5,
    `ranked form uses five distinct ${field} values`);
  }
});

test("v2 purpose selectors are deterministic, domain-separated, and keep ranked out of practice", () => {
  assert.equal(GUANGYANG_LAYOUT_SELECTION_POLICY_VERSION, "2026.08-purpose-selection.1");
  assert.equal(GUANGYANG_RANKED_LAYOUT_FORM_VERSION, "2026.08-ranked-form.1");
  const options = { secret: SECRET, seed: "purpose-domain-check", count: 5 };
  const ranked = selectRankedGuangyangLayoutSequence(options);
  const rankedAgain = selectRankedGuangyangLayoutSequence(options);
  const practice = selectPracticeGuangyangLayoutSequence(options);
  assert.deepEqual(rankedAgain, ranked);
  assert.deepEqual(new Set(ranked.map(item => item.layoutId)),
    new Set(GUANGYANG_RANKED_LAYOUT_FORM_V2));
  assert.ok(practice.every(item => GUANGYANG_PRACTICE_LAYOUT_POOL_V2.includes(item.layoutId)));
  assert.ok(practice.every(item => !GUANGYANG_RANKED_LAYOUT_FORM_V2.includes(item.layoutId)));
  assert.ok(ranked.every(item => (
    item.catalogVersion === GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION
    && item.selectionPurpose === "ranked"
    && item.selectionPolicyVersion === GUANGYANG_LAYOUT_SELECTION_POLICY_VERSION
    && item.rankedFormVersion === GUANGYANG_RANKED_LAYOUT_FORM_VERSION
  )));
  assert.ok(practice.every(item => (
    item.selectionPurpose === "practice"
    && item.selectionPolicyVersion === GUANGYANG_LAYOUT_SELECTION_POLICY_VERSION
    && item.rankedFormVersion === null
  )));
  assert.deepEqual(createGuangyangInteractionDefinition(ranked[0]), ranked[0].interactionDefinition,
    "a v2 selection resolves its catalog through the registry");
  assert.throws(() => selectRankedGuangyangLayoutSequence({ ...options, count: 4 }), /exactly 5/);
  assert.throws(() => getGuangyangPrivateLayoutCatalog("2026.08-private-layouts.404"), /unknown/);
});

test("HMAC and seed produce a stable no-repeat layout sequence", () => {
  const options = { secret: SECRET, seed: "team-zxh:heat-4", count: 5 };
  const first = selectGuangyangLayoutSequence(options);
  const second = selectGuangyangLayoutSequence(options);
  assert.deepEqual(second, first);
  assert.equal(first[0].schemaVersion, PRIVATE_LAYOUT_SELECTION_SCHEMA_VERSION);
  assert.equal(new Set(first.map(item => item.layoutId)).size, first.length);
  assert.ok(first.every((item, index) => item.slotIndex === index + 1 && item.sequenceLength === 5));

  const permutations = new Set();
  for (let seed = 0; seed < 12; seed += 1) {
    permutations.add(selectGuangyangLayoutSequence({ secret: SECRET, seed, count: 5 })
      .map(item => item.layoutId).join(","));
  }
  assert.ok(permutations.size > 1, "different seeds vary the stable order");
  const anotherSecret = Buffer.alloc(32, 0x5a);
  assert.notEqual(
    selectGuangyangLayoutSequence({ secret: anotherSecret, seed: options.seed, count: 5 })[0].layoutCommitment,
    first[0].layoutCommitment,
    "the keyed commitment changes with the HMAC secret"
  );
  assert.throws(() => selectGuangyangLayoutSequence({ secret: "too-short", seed: 1 }), /32/);
  assert.throws(() => selectGuangyangLayoutSequence({ secret: SECRET, seed: "bad\nseed" }), /control/);
});

test("public slot projection has an exact allowlist and exposes no layout, anchor, seed, or coordinates", () => {
  const selection = selectGuangyangLayoutSequence({ secret: SECRET, seed: "projection-check", count: 3 })[0];
  const projection = projectPublicLayoutSelection(selection);
  assert.equal(projection.schemaVersion, PUBLIC_LAYOUT_PROJECTION_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(projection), [
    "schemaVersion", "catalogVersion", "mapId", "mapVersion",
    "slotIndex", "sequenceLength", "layoutCommitment"
  ]);
  assert.match(projection.layoutCommitment, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes(selection.layoutId), false);
  Object.values(selection.anchorIds).forEach(anchorId => assert.equal(serialized.includes(anchorId), false));
  for (const forbidden of ["layoutId", "anchorIds", "seedDigest", "interactionDefinition", "packages", "sourcePosition", "\"x\"", "\"z\""]) {
    assert.equal(serialized.includes(forbidden), false, `public projection omits ${forbidden}`);
  }
  assert.throws(() => projectPublicLayoutSelection({ ...selection, layoutCommitment: "bad" }), /commitment/);
});

test("catalog schema is strict and rejects duplicate ids, role mismatch, spacing, road errors, and bridge obstacles", () => {
  const extra = clone(GUANGYANG_PRIVATE_LAYOUT_CATALOG);
  extra.layouts[0].debug = true;
  assert.throws(() => validateGuangyangLayoutCatalog(extra), /unsupported: debug/);

  const duplicate = clone(GUANGYANG_PRIVATE_LAYOUT_CATALOG);
  duplicate.anchors[1].id = duplicate.anchors[0].id;
  assert.throws(() => validateGuangyangLayoutCatalog(duplicate), /unique/);

  const wrongRole = clone(GUANGYANG_PRIVATE_LAYOUT_CATALOG);
  wrongRole.layouts[0].targetAnchorId = wrongRole.layouts[0].obstacleAnchorId;
  assert.throws(() => validateGuangyangLayoutCatalog(wrongRole), /references a obstacle anchor/);

  const tooClose = clone(GUANGYANG_PRIVATE_LAYOUT_CATALOG);
  const target = tooClose.anchors.find(anchor => anchor.id === "t-northwest-lane");
  target.roadId = "east-inner-south";
  target.sourcePosition = [894, 564];
  assert.throws(() => validateGuangyangLayoutCatalog(tooClose), /spacing/);

  const offRoad = clone(GUANGYANG_PRIVATE_LAYOUT_CATALOG);
  offRoad.anchors.find(anchor => anchor.id === "t-northwest-lane").sourcePosition = [470, 300];
  assert.throws(() => validateGuangyangLayoutCatalog(offRoad), /not fully on its declared road/);

  const bridge = clone(GUANGYANG_PRIVATE_LAYOUT_CATALOG);
  const obstacle = bridge.anchors.find(anchor => anchor.id === "o-north-east-block");
  obstacle.roadId = "west-middle";
  obstacle.sourcePosition = [210, 388];
  assert.throws(() => validateGuangyangLayoutCatalog(bridge), /no legal alternative route/);
});

test("private anchor and layout identifiers do not ship in browser static modules", () => {
  const browserStaticFiles = [
    "index.html", "styles.css", "app.js", "competition-core.js", "python-worker.js",
    "vision.js", "vision-pixel-core.js", "auth.js", "auth-guard.js", "records.js", "admin.js"
  ];
  const staticSource = browserStaticFiles.map(file => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");
  const sensitiveIds = [
    ...GUANGYANG_PRIVATE_LAYOUT_CATALOG.anchors.map(anchor => anchor.id),
    ...GUANGYANG_PRIVATE_LAYOUT_CATALOG.layouts.map(layout => layout.id),
    ...GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2.layouts.map(layout => layout.id)
  ];
  sensitiveIds.forEach(id => assert.equal(staticSource.includes(id), false, `${id} stays backend-only`));
});

test("standalone catalog validator reports only counts, safe fields, and the local-browser boundary", () => {
  const cli = spawnSync(process.execPath, [path.join(ROOT, "tools", "validate-guangyang-layout-catalog.js")], {
    cwd: ROOT,
    encoding: "utf8"
  });
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(cli.stdout);
  assert.equal(report.status, "ok");
  assert.equal(report.catalog.layoutCount, GUANGYANG_PRIVATE_LAYOUT_CATALOG.layouts.length);
  assert.equal(report.expandedCatalog.layoutCount, 198);
  assert.deepEqual(report.pools, { rankedFormLayoutCount: 5, practiceLayoutCount: 193 });
  assert.equal(report.checks.expandedLayoutCount, 198);
  assert.equal(report.checks.strictRejectedFromFullProduct, 18);
  assert.equal(report.checks.deterministicSequenceStable, true);
  assert.equal(report.checks.sequenceWithoutReplacement, true);
  assert.equal(report.checks.purposeSequenceStable, true);
  assert.equal(report.checks.purposeSelectionsInPool, true);
  assert.equal(report.checks.rankedPracticeDisjoint, true);
  assert.match(report.boundary, /local browser is inspectable/i);
  const serialized = JSON.stringify(report);
  GUANGYANG_PRIVATE_LAYOUT_CATALOG.layouts.forEach(layout => {
    assert.equal(serialized.includes(layout.id), false);
  });
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2.layouts.forEach(layout => {
    assert.equal(serialized.includes(layout.id), false);
  });
});
