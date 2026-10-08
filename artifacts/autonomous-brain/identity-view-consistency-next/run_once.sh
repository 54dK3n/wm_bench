#!/bin/bash
set -u
cd /Users/ken/Desktop/wm_bench
export LLM_TRANSPORT=codex-app-server
export LLM_MODEL=gpt-6.1-sol
export LLM_CODEX_BINARY=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
export WM_RUN_OUT="artifacts/autonomous-brain/identity-view-consistency-next/run-$STAMP"
if [ -e "$WM_RUN_OUT" ] || [ -e "${WM_RUN_OUT}-evaluation" ] || [ -e "${WM_RUN_OUT}.source.json" ]; then
  echo 'Refusing to reuse evidence directory' >&2
  exit 2
fi
node - <<'JS'
const fs=require('node:fs'),path=require('node:path');
const d=require('./tools/autonomous_brain_driver');d.loadLocalLLMConfig();
const python=process.env.BRAIN_PYTHON||'python3';
const options={python,orchestratorRoot:path.resolve('workspaces/octos_robots'),task:'把两个红球送到绿色存放区',maxRounds:200,maxSimulationSeconds:1200,wallTimeoutSeconds:0};
const manifest=d.sourceManifest(path.resolve('workspaces/guangyang-platform/projects/car-python'),options);
fs.writeFileSync(process.env.WM_RUN_OUT+'.source.json',JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
fs.writeFileSync('artifacts/autonomous-brain/identity-view-consistency-next/ACTIVE_RUN.txt',process.env.WM_RUN_OUT+'\n',{flag:'wx'});
console.log('Frozen source: '+manifest.brainRevision+'; output: '+process.env.WM_RUN_OUT);
JS
FREEZE_RC=$?
if [ "$FREEZE_RC" -ne 0 ]; then exit "$FREEZE_RC"; fi
set +e
PYTHONDONTWRITEBYTECODE=1 node tools/autonomous_brain_driver.js \
  --maps map-05 --runs 1 \
  --platform-root workspaces/guangyang-platform/projects/car-python \
  --orchestrator-root workspaces/octos_robots \
  --task '把两个红球送到绿色存放区' \
  --out "$WM_RUN_OUT" > "${WM_RUN_OUT}.driver.stdout.txt" 2> "${WM_RUN_OUT}.driver.stderr.txt"
DRIVER_RC=$?
printf 'driver_exit=%s\n' "$DRIVER_RC" > "${WM_RUN_OUT}.exits.txt"
PYTHONPATH=vendor/wm_kit_opt2:. PYTHONDONTWRITEBYTECODE=1 \
"${BRAIN_PYTHON:-python3}" tools/evaluate_autonomous_brain.py \
  --input "$WM_RUN_OUT/map-05-run-1" \
  --out "${WM_RUN_OUT}-evaluation" > "${WM_RUN_OUT}.evaluator.stdout.txt" 2> "${WM_RUN_OUT}.evaluator.stderr.txt"
EVALUATOR_RC=$?
printf 'evaluator_exit=%s\n' "$EVALUATOR_RC" >> "${WM_RUN_OUT}.exits.txt"
printf '{"driver_exit":%s,"evaluator_exit":%s}\n' "$DRIVER_RC" "$EVALUATOR_RC" > "${WM_RUN_OUT}-exit-codes.json"
printf 'output=%s\ndriver_exit=%s\nevaluator_exit=%s\n' "$WM_RUN_OUT" "$DRIVER_RC" "$EVALUATOR_RC"
