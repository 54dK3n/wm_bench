'use strict';
// Diagnostic only: use the driver's real loader, Python selection and child env.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const ROOT = path.resolve(__dirname, '../../../..');
const driver = require(path.join(ROOT, 'tools/autonomous_brain_driver.js'));
const [mode, output] = process.argv.slice(2);
if (!['network', 'smoke'].includes(mode) || !output) throw new Error('network|smoke and new output directory required');
const out = path.resolve(output);
const options = driver.parseArgs(['--out', out]);
const keys = ['LLM_BASE_URL','LLM_API_KEY','LLM_MODEL','LLM_TEMPERATURE','LLM_THINKING'];
const inherited = Object.fromEntries(keys.map(key => [key, Object.hasOwn(process.env, key)]));
driver.loadLocalLLMConfig();
driver.validateFormalLLMConfig();
fs.mkdirSync(out, {recursive: false});
fs.writeFileSync(path.join(out, 'launcher.json'), JSON.stringify({python_selection: options.python,
  cwd: ROOT, configuration_source: Object.fromEntries(keys.map(key => [key, inherited[key] ? 'inherited_environment' : 'driver_env_local_or_default'])),
  child_environment: 'same as runBrain: inherited loaded environment plus PYTHONUNBUFFERED=1',
  environment_overrides: {PYTHONUNBUFFERED: '1'}, mode}, null, 2) + '\n');
const result = spawnSync(options.python, [path.join(__dirname, 'check_model.py'), mode, out],
  {cwd: ROOT, env: {...process.env, PYTHONUNBUFFERED: '1'}, encoding: 'utf8', timeout: mode === 'network' ? 45000 : 150000});
fs.writeFileSync(path.join(out, 'stdout.txt'), result.stdout || '');
fs.writeFileSync(path.join(out, 'stderr.txt'), result.stderr || '');
fs.writeFileSync(path.join(out, 'exit.json'), JSON.stringify({exit_code: result.status, signal: result.signal,
  spawn_error_code: result.error?.code || null}, null, 2) + '\n');
process.stdout.write(result.stdout || '');
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status === null ? 1 : result.status;
