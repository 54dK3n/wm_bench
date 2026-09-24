const test = require("node:test");
const assert = require("node:assert/strict");

const { createRealActionPlan, queueRealPlanAction } = require("../python-worker.js");

test("real Python actions are fully validated into a plan before dispatch", () => {
  const plan = createRealActionPlan();
  queueRealPlanAction(plan, "forward", [25]);
  queueRealPlanAction(plan, "left_angle", [90]);
  queueRealPlanAction(plan, "grab", []);
  queueRealPlanAction(plan, "release", []);

  assert.deepEqual(plan.actions, [
    { method: "forward", args: [25] },
    { method: "left_angle", args: [90] },
    { method: "grab", args: [] },
    { method: "release", args: [] }
  ]);
  assert.equal(plan.totalSeconds, 10.1);
  assert.equal(plan.error, null);
});

test("real Python planning rejects perception and invalid motion without dispatchable output", () => {
  const unsupported = createRealActionPlan();
  assert.throws(() => queueRealPlanAction(unsupported, "observe", ["target", 0.6]), /没有感知/);
  assert.deepEqual(unsupported.actions, []);

  const invalid = createRealActionPlan();
  assert.throws(() => queueRealPlanAction(invalid, "left", [31]), /转向时间/);
  assert.deepEqual(invalid.actions, []);
});
