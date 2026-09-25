"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {VERSION, parseLocalLLMConfig, loadLocalLLMConfig} = require("../autonomous_brain_driver.js");

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
  assert.equal(VERSION, "wm-autonomous-brain-driver/v5");
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
