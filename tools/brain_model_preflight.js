#!/usr/bin/env node
'use strict';
// Reuse the production configuration parser; never print the environment.
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {loadLocalLLMConfig, validateFormalLLMConfig} = require('./autonomous_brain_driver');
try {
  loadLocalLLMConfig();
  validateFormalLLMConfig();
  const result = spawnSync(process.env.BRAIN_PYTHON || 'python3', [path.join(__dirname, 'brain_model_preflight.py'), ...process.argv.slice(2)],
    {stdio: 'inherit', env: process.env});
  process.exit(result.status === null ? 1 : result.status);
} catch (_) {
  console.error('Model preflight configuration rejected; no request made.');
  process.exit(1);
}
