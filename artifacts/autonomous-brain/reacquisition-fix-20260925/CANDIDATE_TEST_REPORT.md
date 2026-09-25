# Reacquisition candidate: scoped offline verification

The same38 public-sensor regression cases that produced6 failures on the frozen baseline now pass on the candidate implementation. This verifies the scoped synthetic behavior; it does not claim Run13 succeeded or that a future physical run will succeed. No live API, simulator action, scene layout, evaluator truth, or credential file was accessed by this test task.

```text
python3 -B -m pytest -q tests/test_brain_reacquisition.py -p no:cacheprovider
......................................                                   [100%]
38 passed in 0.13s
```

Exit code:0. Working directory: repository root. `WORLD_MODEL_ROOT` explicitly resolves to `vendor/wm_kit_opt2`; bytecode and pytest cache writes were disabled. No full-suite rerun was performed by this task.

- Raw output: `artifacts/autonomous-brain/reacquisition-fix-20260925/candidate-tests-v1.txt`.
- Command, return code, and before/after SHA256 values: `artifacts/autonomous-brain/reacquisition-fix-20260925/candidate-validation-v1.json`.
- Frozen baseline result for the exact same test SHA: `artifacts/autonomous-brain/reacquisition-fix-20260925/baseline-tests-v3.txt` and `baseline-validation-v3.json`.
- Defect analysis, observation references, public-sensor reproduction, and earlier fixture corrections: `artifacts/autonomous-brain/reacquisition-fix-20260925/BASELINE_REPORT.md`.

| File | SHA256 during candidate verification |
|---|---|
| `autonomous_brain/perception.py` | `5c266e7cd9c87fbc322333691b28d0014cbd08553ed8046f2073b0be4802ba89` |
| `autonomous_brain/actions.py` | `497c669e85294a8683fb545d3ed0dd0661e5871892b0220fbc8260f6bdd75aa6` |
| `autonomous_brain/run.py` | `a6e37dee7cb7a9e77bc56e2e7bffe81304aa6c99aaca729753519ee72d69c30c` |
| `autonomous_brain/llm.py` | `ffac80ec63d8217622445b61c4a5f137380bec9662aebad13e087ce308d6b3e1` |
| `tests/test_brain_reacquisition.py` | `e6c5c1fe29bef5dcdc966c1f4f84ddb4798e6cbaf4b2b1e66729ce3c653942fb` |

All five hashes were identical immediately before and after the run. Runtime changes were implemented by the root/consumer tasks; this task only added the regression test and evidence files.

The tests verify normal independent three-position confirmation before binding, the existing inclusive30cm association boundary, no archived-state/position/hit-history rewriting, and no early completion credit. A successor's genuine synthetic pick and current unique pixel placement witness are required before the old pending obligation resolves. The valid A→B→C chain resolves only after C's delivery. Near-field-only observations, two hits, stationary views, other historical or active competitors, action lifecycle identities, delivery aliases, malformed evidence, missing/cyclic chains, and duplicate identities remain conservative.

Root's separate saved-sensor replay reports365 Run13 observations matching the original perception evidence except version, unchanged object rows, and zero reacquisition bindings. The scoped tests do not reinterpret any actual Run13 track as another physical ball.
