"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {evaluatorDependencies} = require("../autonomous_brain_driver.js");

test("audit source inventory uses actual bytes and detects changed or missing helpers", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-audit-source-test-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, "tools"));
  const helper = "tools/brain_evidence_audit.py";
  const replay = "tools/replay_brain_llm.py";
  fs.writeFileSync(path.join(root, helper), "# synthetic audit A\n");
  fs.writeFileSync(path.join(root, replay), "# synthetic replay\n");
  fs.writeFileSync(path.join(root, "tools/brain_topology_audit.py"), "# synthetic topology audit\n");
  const before = evaluatorDependencies(root);
  assert.equal(before[helper], crypto.createHash("sha256").update("# synthetic audit A\n").digest("hex"));
  fs.writeFileSync(path.join(root, helper), "# synthetic audit B\n");
  const after = evaluatorDependencies(root);
  assert.notEqual(before[helper], after[helper]);
  assert.equal(before[replay], after[replay]);
  fs.unlinkSync(path.join(root, replay));
  assert.throws(() => evaluatorDependencies(root), {code: "ENOENT"});
});
