"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {VERSION, parseLocalLLMConfig, loadLocalLLMConfig, validateFormalLLMConfig, validateStageGate, worldModelProvenance, parseArgs} = require("../autonomous_brain_driver.js");

test("local config accepts literal values, comments and only the allowed LLM keys", () => {
  const parsed = parseLocalLLMConfig([
    "# Machine-local settings", "",
    "LLM_BASE_URL=https://example.invalid/v1 # endpoint",
    'LLM_API_KEY="test#literal" # comment',
    "LLM_MODEL='$(do-not-execute) ${NO_EXPANSION}'",
    "LLM_TEMPERATURE=0", "LLM_THINKING=disabled",
    "UNRELATED_KEY=ignored", "__proto__=ignored", "",
  ].join("\r\n"));
  assert.deepEqual({...parsed}, {
    LLM_BASE_URL: "https://example.invalid/v1",
    LLM_API_KEY: "test#literal",
    LLM_MODEL: "$(do-not-execute) ${NO_EXPANSION}",
    LLM_TEMPERATURE: "0", LLM_THINKING: "disabled",
  });
  assert.equal(VERSION, "wm-autonomous-brain-driver/v8");
});

test("existing environment wins and missing files are optional", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "brain-config-test-"));
  try {
    const file = path.join(directory, "test-config");
    const env = {LLM_API_KEY: "process-test-value", LLM_MODEL: ""};
    loadLocalLLMConfig(file, env);
    fs.writeFileSync(file, "LLM_API_KEY=file-test-value\nLLM_MODEL=file-model\nLLM_BASE_URL=https://example.invalid/v1\n");
    loadLocalLLMConfig(file, env);
    assert.deepEqual(env, {
      LLM_API_KEY: "process-test-value", LLM_MODEL: "", LLM_BASE_URL: "https://example.invalid/v1",
    });
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test("invalid config cannot expose values or partly mutate the environment", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "brain-config-test-"));
  try {
    const file = path.join(directory, "test-config");
    fs.writeFileSync(file, 'LLM_MODEL=valid\nLLM_API_KEY="synthetic-sensitive-marker\n');
    const env = {};
    assert.throws(() => loadLocalLLMConfig(file, env), error => {
      assert.equal(error.message, "Invalid LLM_API_KEY quoting at line 2");
      assert.ok(!error.stack.includes("synthetic-sensitive-marker"));
      return true;
    });
    assert.deepEqual(env, {});
    assert.throws(() => parseLocalLLMConfig("synthetic-sensitive-marker"), {
      message: "Invalid local LLM config assignment at line 1",
    });
    assert.throws(() => loadLocalLLMConfig(directory, env), {
      message: "Unable to read local LLM config file",
    });
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});


test("formal configuration fails closed without changing requested settings", () => {
  const valid = {LLM_API_KEY: 'synthetic-key', LLM_BASE_URL: 'https://example.invalid/v1',
    LLM_MODEL: 'deepseek-flash', LLM_TEMPERATURE: '0', LLM_THINKING: 'disabled'};
  assert.equal(validateFormalLLMConfig(valid).formal_run, true);
  for (const overrides of [{LLM_MODEL: 'deepseek-chat'}, {LLM_TEMPERATURE: '1'},
    {LLM_TEMPERATURE: 'false'}, {LLM_THINKING: 'enabled'}, {LLM_THINKING: undefined}]) {
    const configured = {...valid, ...overrides}, original = {...configured};
    assert.throws(() => validateFormalLLMConfig(configured));
    assert.deepEqual(configured, original);
  }
  assert.ok(!JSON.stringify(validateFormalLLMConfig(valid)).includes('synthetic-key'));
});

test("default stage-1 instruction and limits are explicit; stage-1 cannot unlock other layouts", () => {
  const options = parseArgs(['--out', '/tmp/formal-config-test']);
  assert.equal(options.task, '把两个红球送到绿色存放区');
  assert.equal(options.maxRounds, 200);
  assert.equal(options.maxSimulationSeconds, 1200);
  validateStageGate(options);
  assert.throws(() => validateStageGate({...options, maps: ['map-05', 'map-01']}), /Stage-2/);
  assert.throws(() => validateStageGate({...options, stage2Success: '/tmp/stage1-success.json'}), /Stage-2/);
});


test("driver provenance follows WORLD_MODEL_ROOT and detects changed dependency contents", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-worldmodel-test-'));
  try {
    const alternate = path.join(directory, 'alternate');
    fs.mkdirSync(alternate);
    const source = path.resolve(__dirname, '../../vendor/wm_kit_opt2/world_model');
    fs.cpSync(source, path.join(alternate, 'world_model'), {recursive: true,
      filter: file => !file.includes('__pycache__')});
    const env = {...process.env, WORLD_MODEL_ROOT: alternate};
    const before = worldModelProvenance(process.env.BRAIN_PYTHON || 'python3', env);
    assert.equal(before.configured_root, fs.realpathSync(alternate));
    assert.equal(before.selection, 'WORLD_MODEL_ROOT');
    fs.appendFileSync(path.join(alternate, 'world_model/providers/guangyang.py'), '\n# synthetic source variation\n');
    const after = worldModelProvenance(process.env.BRAIN_PYTHON || 'python3', env);
    assert.notEqual(before.source_tree_sha256, after.source_tree_sha256);
    assert.notEqual(before.files['world_model/providers/guangyang.py'], after.files['world_model/providers/guangyang.py']);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
