# Coordinate convention, storage guidance, and action evidence

Scope: `autonomous_brain/run.py`, `autonomous_brain/llm.py`, and their two test files. Runtime is v3; LLM client is v9. No action gates or platform code were changed by this work.

- New model state explicitly describes the initial odometry frame, object bearings positive to the right, and heading/exit angles positive to the left. Observed values are not converted or replaced.
- The prompt prefers the closest currently CONFIRMED storage candidate using its own remembered distance and recent failure evidence. It discourages retrying an exhausted route without changed position or new road/visual evidence. The model still selects the action and object; a valid farther-object choice is not silently rewritten.
- Compact action evidence now retains the requested road-clearance whitelist and recovery return error/reversed distance. Unknown fields, nonfinite values and oversized strings remain filtered.
- Replay continues to restore the recorded system prompt, state and request settings. It does not inject the new convention into old requests.

## Validation

Before the prompt change, the new prompt contract test failed while all eight legacy repair-replay cases passed: `coordinate-tests-before.log` (1 failed, 8 passed; exit 1).

Before the evidence whitelist change, both new road-clearance/recovery tests failed because `road_clearance` was omitted: `road-evidence-tests-before.log` (2 failed; exit 1).

Final command: `python3 -m pytest -q tests/test_brain_llm.py tests/test_brain_state_evidence.py`

Result: **177 passed in 0.21s, exit 0**, saved in `coordinate-and-road-evidence-tests-final.log` and its command JSON. Tests cover unchanged signed geometry, detached convention metadata, model-owned storage selection, finite whitelisted sensor evidence, and exact v1–v8 replay including the single JSON repair without network/environment access or sleep.

The original run07 v8 transcript was replayed with the v9 client: **54 rounds, 57 calls, all consumed, all records equal except mode, zero network calls and zero environment reads**. See `v8-llm-replay/replay-checks.json` and `coordinate-v8-replay-command.json`. Original evidence hashes remained unchanged. This checks only offline model transcript replay; it neither repeats the simulator nor changes the original run result.

## Source hashes

`coordinate-source-before.json` records the four original file hashes. `coordinate-source-final.json` records the final hashes including the added road evidence whitelist. `coordinate-source-after.json` and `coordinate-tests-after.*` retain the intermediate convention-only validation before the additional evidence requirement.
