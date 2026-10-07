"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {VERSION, parseLocalLLMConfig, loadLocalLLMConfig, validateFormalLLMConfig, validateStageGate, worldModelProvenance, orchestratorProvenance, parseArgs} = require("../autonomous_brain_driver.js");

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
  assert.equal(VERSION, "wm-autonomous-brain-driver/v13");
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

test("malformed endpoint and wrong model settings never echo configuration in errors", () => {
  const marker = 'endpoint-sensitive-synthetic-marker';
  const valid = {LLM_API_KEY: 'synthetic-key', LLM_BASE_URL: 'https://example.invalid/v1',
    LLM_MODEL: 'deepseek-flash', LLM_TEMPERATURE: '0', LLM_THINKING: 'disabled'};
  for (const endpoint of [marker, `file:///${marker}`, `https://${marker}@example.invalid`,
    `https://example.invalid/?token=${marker}`, `https://example.invalid/#${marker}`,
    `https://[${marker}`, `https://example.invalid:${marker}`, `https:///missing/${marker}`,
    ` https://example.invalid/${marker}`, `https://example.invalid/\n${marker}`]) {
    assert.throws(() => validateFormalLLMConfig({...valid, LLM_BASE_URL: endpoint}), error => {
      assert.equal(error.message, 'invalid_configuration:LLM_BASE_URL');
      assert.ok(!error.stack.includes(marker));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  for (const name of ['LLM_MODEL', 'LLM_TEMPERATURE', 'LLM_THINKING']) {
    assert.throws(() => validateFormalLLMConfig({...valid, [name]: marker}), error => {
      assert.ok(!error.stack.includes(marker));
      return true;
    });
  }
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

test("live tasks select the existing Executor while historical replay retains direct dispatch", () => {
  const live = parseArgs(['--out', '/tmp/octos-wiring-test', '--task', '把一个红球送到绿色存放区']);
  assert.ok(path.isAbsolute(live.orchestratorRoot));
  assert.equal(live.task, '把一个红球送到绿色存放区');
  const replay = parseArgs(['--out', '/tmp/octos-wiring-test', '--replay', '/tmp/historical.jsonl']);
  assert.equal(replay.orchestratorRoot, null);
  const explicit = parseArgs(['--out', '/tmp/octos-wiring-test', '--replay', '/tmp/historical.jsonl',
    '--orchestrator-root', '/tmp/explicit-octos']);
  assert.equal(explicit.orchestratorRoot, '/tmp/explicit-octos');
});

test("orchestration freeze records actual Executor and registry bytes, and observes source edits", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-orchestration-freeze-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const root = path.resolve(__dirname, '../..');
  const gitDir = require('node:child_process').spawnSync('git', ['rev-parse', '--absolute-git-dir'],
    {cwd: root, encoding: 'utf8'}).stdout.trim();
  fs.writeFileSync(path.join(directory, '.git'), 'gitdir: ' + gitDir + '\n');
  fs.mkdirSync(path.join(directory, 'orchestrator'));
  fs.mkdirSync(path.join(directory, 'skills'));
  const executor = path.join(directory, 'orchestrator/executor.py');
  fs.writeFileSync(executor, '# synthetic first source\n');
  fs.writeFileSync(path.join(directory, 'skills/registry.json'), '{"skills":[]}\n');
  const before = orchestratorProvenance(directory);
  assert.equal(before.kind, 'octos_robots.Executor');
  assert.equal(before.maxRetries, 0);
  assert.equal(before.externalOctosRuntime, false);
  assert.match(before.revision, /^[0-9a-f]{40}$/);
  fs.appendFileSync(executor, '# changed source\n');
  assert.notDeepEqual(orchestratorProvenance(directory), before);
  fs.unlinkSync(executor);
  assert.throws(() => orchestratorProvenance(directory), /no existing Executor/);
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

test('explicit Kimi profile uses official endpoint and fixed nonthinking temperature', () => {
  const config={LLM_BASE_URL:'https://api.moonshot.cn/v1',LLM_API_KEY:'unit-test-secret',
    LLM_MODEL:'kimi-k2.6',LLM_TEMPERATURE:'0.6',LLM_THINKING:'disabled'};
  assert.equal(validateFormalLLMConfig(config).model,'kimi-k2.6');
  for (const overrides of [{LLM_TEMPERATURE:'0'}, {LLM_THINKING:'enabled'},
    {LLM_MODEL:'kimi-k3'}, {LLM_BASE_URL:'https://example.invalid/v1'}]) {
    assert.throws(()=>validateFormalLLMConfig({...config,...overrides}));
  }
  assert.ok(!JSON.stringify(validateFormalLLMConfig(config)).includes(config.LLM_API_KEY));
});

test('ChatGPT account transport freezes the official client and explicit profile', () => {
  const env={LLM_TRANSPORT:'codex-app-server', LLM_MODEL:'gpt-6.1-sol', LLM_CODEX_BINARY:process.execPath};
  const value=validateFormalLLMConfig(env);
  assert.equal(value.transport,'codex-app-server');
  assert.equal(value.temperature,null);
  assert.equal(value.thinking,'low');
  assert.equal(value.client.sha256.length,64);
  assert.throws(()=>validateFormalLLMConfig({...env,LLM_MODEL:'other'}));
  assert.throws(()=>validateFormalLLMConfig({...env,LLM_CODEX_BINARY:'relative'}));
});
