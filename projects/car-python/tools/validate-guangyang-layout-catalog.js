#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const {
  GUANGYANG_PRIVATE_LAYOUT_CATALOG,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2,
  GUANGYANG_PRACTICE_LAYOUT_POOL_V2,
  GUANGYANG_RANKED_LAYOUT_FORM_V2,
  privateLayoutCatalogSummary,
  projectPublicLayoutSelection,
  selectPracticeGuangyangLayoutSequence,
  selectRankedGuangyangLayoutSequence,
  selectGuangyangLayoutSequence,
  validateGuangyangLayoutCatalog
} = require("../backend/guangyang-private-layout-catalog.js");

const REPORT_SCHEMA_VERSION = "chenlong.guangyang-layout-catalog-validation/v1";

function main() {
  const catalog = validateGuangyangLayoutCatalog(GUANGYANG_PRIVATE_LAYOUT_CATALOG);
  const summary = privateLayoutCatalogSummary(catalog);
  const expandedCatalog = validateGuangyangLayoutCatalog(GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2);
  const expandedSummary = privateLayoutCatalogSummary(expandedCatalog);
  const validationKey = crypto.createHash("sha256")
    .update("Guangyang private layout catalog deterministic self-check", "utf8")
    .digest();
  const options = {
    secret: validationKey,
    seed: "catalog-self-check",
    count: catalog.layouts.length,
    catalog
  };
  const first = selectGuangyangLayoutSequence(options);
  const second = selectGuangyangLayoutSequence(options);
  const stable = first.every((selection, index) => (
    selection.layoutId === second[index].layoutId
    && selection.layoutCommitment === second[index].layoutCommitment
  ));
  const withoutReplacement = new Set(first.map(selection => selection.layoutId)).size === first.length;
  const projections = first.map(projectPublicLayoutSelection);
  const purposeOptions = { secret: validationKey, seed: "catalog-purpose-self-check", count: 5 };
  const ranked = selectRankedGuangyangLayoutSequence(purposeOptions);
  const rankedRepeated = selectRankedGuangyangLayoutSequence(purposeOptions);
  const practice = selectPracticeGuangyangLayoutSequence(purposeOptions);
  const purposeStable = JSON.stringify(ranked) === JSON.stringify(rankedRepeated);
  const rankedSet = new Set(GUANGYANG_RANKED_LAYOUT_FORM_V2);
  const poolsDisjoint = GUANGYANG_PRACTICE_LAYOUT_POOL_V2.every(id => !rankedSet.has(id));
  const purposeSelectionsInPool = ranked.every(item => rankedSet.has(item.layoutId))
    && practice.every(item => GUANGYANG_PRACTICE_LAYOUT_POOL_V2.includes(item.layoutId));
  const publicProjectionFields = Object.keys(projections[0] || {});
  if (!stable || !withoutReplacement || !purposeStable || !poolsDisjoint
    || !purposeSelectionsInPool || expandedCatalog.layouts.length !== 198) {
    throw new Error("private layout deterministic self-check failed");
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "ok",
    catalog: summary,
    expandedCatalog: expandedSummary,
    pools: {
      rankedFormLayoutCount: GUANGYANG_RANKED_LAYOUT_FORM_V2.length,
      practiceLayoutCount: GUANGYANG_PRACTICE_LAYOUT_POOL_V2.length
    },
    checks: {
      everyLayoutValidated: true,
      expandedLayoutCount: expandedCatalog.layouts.length,
      strictRejectedFromFullProduct: 216 - expandedCatalog.layouts.length,
      deterministicSequenceStable: stable,
      sequenceWithoutReplacement: withoutReplacement,
      purposeSequenceStable: purposeStable,
      purposeSelectionsInPool,
      rankedPracticeDisjoint: poolsDisjoint,
      publicProjectionCount: projections.length,
      publicProjectionFields
    },
    boundary: "Server-private catalog only; a layout injected into the current local browser is inspectable there."
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}
