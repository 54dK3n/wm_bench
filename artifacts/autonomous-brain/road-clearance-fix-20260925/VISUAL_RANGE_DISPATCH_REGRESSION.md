# Run08 near-memory / farther-camera dispatch regression

Frozen source tested: `fa5c0f18487171a5d294080500deccb54f718d4d` (`autonomous-brain-actions/v9`). Only the new test file and this report were written. No runtime source, live-run artifact, simulator state, credentials, layout, or truth data were changed or used.

## Sensor evidence

References are `artifacts/autonomous-brain/map05-run-08/map-05-run-1/brain/rounds.jsonl` and `observations.jsonl`.

| Round / observation | Remembered distance at dispatch (cm) | Fresh camera distance (cm) | Fresh bearing | Observed road geometry | Result |
| --- | ---: | ---: | ---: | --- | --- |
| 22 / 97 | 61.991369447611035 | 70.96864831142133 | -1.0201° | onRoad; heading error -44.4°; left/right clearance 9.8 cm; front 53.4 cm | `visual_standoff_range_not_supported` |
| 24 / 103 | 58.13136344830492 | 74.02842535359996 | -1.1536° | onRoad; heading error -36.4°; left/right clearance 9.8 cm; front 49.7 cm; atNode | `visual_standoff_range_not_supported` |

The remembered distances here are computed at the final observations, not copied from the earlier LLM state at the start of each round. Round 22 made navigation progress before reaching this branch; the defect is the premature termination at observation 97, not a claim that the entire live round had zero motion.

`Actions.go_to` currently dispatches to `visual_standoff` when remembered distance is at most 65 cm and a current-frame detection exists. It does not check whether the fresh detection is inside the servo's supported distance interval. `visual_standoff` correctly rejects distances above 65 cm, so this early return bypasses the remaining bounded road-approach logic. These road observations provide nonzero local clearance for a small approach; they do not prove an entire approach or live task will succeed.

This was not a permanent live-run deadlock. The model explored again: round 27 reached a verified standoff (observation 115, 28.1727 cm, bearing 0.335°), and round 28's second grab was observed holding at observation 119, followed by `old_position_matches=0` and `grasp_observed` at observation 120.

## Synthetic regression tests

New file: `tests/test_brain_visual_range_dispatch_regression.py`.

The two initial distance pairs above are used with a synthetic straight, clear road and an aligned target. Subsequent camera ranges respond to synthetic measured translations. This is a focused branch test, not a replay of live road geometry or any truth map.

Command:

```text
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider tests/test_brain_visual_range_dispatch_regression.py
```

Initial result on the frozen source: **4 failed, 4 passed in 0.13 s** (exit 1). After adding the independently requested reverse-error case below, the same command produced **5 failed, 4 passed in 0.16 s** (exit 1).

| Case | Frozen result | Expected behavior encoded by test |
| --- | --- | --- |
| Each of two near-memory / farther-camera pairs | FAIL: no motion before `visual_standoff_range_not_supported` | Begin a bounded road approach; observe after every movement; claim success only from fresh 25–40 cm / ±10° evidence |
| Same inputs, first road command reports front blockage | FAIL: premature visual range rejection | One command of at most 10 cm, then `route_blocked`, no success |
| Same inputs, road command makes no pose progress | FAIL: premature visual range rejection | One command of at most 10 cm, then `route_no_progress`, no success |
| Direct visual servo at each unsupported fresh range | PASS | Preserve the 65 cm servo limit and make no motion |
| Farther fresh range while off road | PASS | No motion and `not_on_observed_road` |
| Exactly 65 cm fresh range | PASS | Existing servo remains bounded and succeeds only after fresh evidence enters the original standoff window |
| Confirmed target remembered at 66 cm, same-identity current-frame view at 50 cm | FAIL: unnecessary road route and 20 cm `follow_road` step | Enter existing visual control directly; movements remain at most 10 cm and success requires fresh evidence inside the original window |

The failed blockage/no-progress cases verify the behavior needed after fixing dispatch; neither downstream behavior is exercised by the frozen implementation because it returns too early. The reverse-error case is wholly synthetic: the frozen code eventually succeeds after an unnecessary road step, so it demonstrates incorrect dispatch rather than a false success or an actual live failure. Tests are deliberately not marked expected-failure so they can guard the later fix.

## Minimal proposed change, not applied

Dispatch to the existing visual servo when the selected confirmed target has a same-identity current-frame detection with finite numeric distance in `0 < distance_cm <= 65` (excluding booleans), without additionally requiring remembered distance to be at most 65 cm. A farther valid observation should continue through existing known-road navigation and its clearance, motion, and no-progress bounds. Leave `visual_standoff`'s 65 cm support limit and the original 25–40 cm / ±10° success gate unchanged.

No proposed code was run or validated here. Passing these synthetic tests after a later change would establish this bounded behavior, not guarantee a live pass or relax confirmation, grasp, placement, or M5 thresholds.
