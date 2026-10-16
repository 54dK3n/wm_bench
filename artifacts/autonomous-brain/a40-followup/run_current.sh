#!/bin/bash
set -u
# Preserve the selected real model; the existing driver still loads private
# configuration without exposing it. These are the prior live-run overrides.
export LLM_TRANSPORT=codex-app-server
export LLM_MODEL=gpt-6.1-sol
export LLM_CODEX_BINARY=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
export BRAIN_PLATFORM_GATE=artifacts/autonomous-brain/pixel-quality-next/preflight-gate.json
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="artifacts/autonomous-brain/a40-followup/run-$STAMP"
mkdir -p "$(dirname "$OUT")"
test ! -e "$OUT" && test ! -e "${OUT}-evaluation" || exit 2
printf 'output=%s\n' "$OUT"
set +e
PYTHONDONTWRITEBYTECODE=1 node tools/autonomous_brain_driver.js \
  --maps map-05 --runs 1 \
  --platform-root "${GUANGYANG_PLATFORM_ROOT:-workspaces/guangyang-platform/projects/car-python}" \
  --platform-gate "$BRAIN_PLATFORM_GATE" \
  --orchestrator-root "${OCTOS_ROBOTS_ROOT:-workspaces/octos_robots}" \
  --task '把两个红球送到绿色存放区' \
  --max-rounds 200 --max-simulation-seconds 1200 \
  --out "$OUT" > "${OUT}.driver.stdout.txt" 2> "${OUT}.driver.stderr.txt"
DRIVER_RC=$?
PYTHONPATH=vendor/wm_kit_opt2:. PYTHONDONTWRITEBYTECODE=1 \
"${BRAIN_PYTHON:-python3}" tools/evaluate_autonomous_brain.py \
  --input "$OUT/map-05-run-1" --out "${OUT}-evaluation" \
  > "${OUT}.evaluator.stdout.txt" 2> "${OUT}.evaluator.stderr.txt"
EVALUATOR_RC=$?
printf '{"driver_exit":%s,"evaluator_exit":%s}\n' "$DRIVER_RC" "$EVALUATOR_RC" \
  > "${OUT}-exit-codes.json"
printf 'output=%s driver=%s evaluator=%s\n' "$OUT" "$DRIVER_RC" "$EVALUATOR_RC"
