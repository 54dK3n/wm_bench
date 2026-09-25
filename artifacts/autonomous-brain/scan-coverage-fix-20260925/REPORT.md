# Stationary scan angular coverage: offline candidate

The isolated Actions v14 candidate changes `look_around` from four 90-degree turns to eight 45-degree turns and renames its result to `full_circle_views_observed`. It preserves the initial heading after a complete scan and retains all four previous cardinal viewing directions. Existing candidate selection and optional return to the selected observed heading are unchanged.

The baseline is frozen commit `913474816dbd6271d223cf0cf79366ff668b1e42`. Development and tests used an isolated package copy (`wm-scan-coverage-shadow-wn7ze5bs`). No main source or running trial artifact was changed. No simulator, model API, environment file, layout or truth was accessed by this candidate work. This does not attribute any current physical failure to the scan gap and is not a successful full simulation.

## Source-grounded coverage

The public camera contract at `workspaces/guangyang-platform/projects/car-python/robot-bridge-contract.js:18` gives a 640×480 image with `fx = 240 / tan(30°) = 415.6921938`. Its nominal horizontal field of view is `2 atan(320 / fx) = 75.17817894°`. `autonomous_brain/perception.py:175` retains the stricter admission condition `abs(raw_bearing_deg) <= 35` and raw range 40 ≤ distance < 90 cm. The resulting 70-degree admitted angular sector leaves a 20-degree nominal gap between 90-degree endpoint observations.

Only endpoint observations update perception: `Actions.move` waits for a turn to finish before observing. The original initial and final observations and optional return view do not fill the intermediate sectors. Eight 45-degree endpoints bound the maximum circular gap by 45 degrees, below both the horizontal FOV and 70-degree admission width. They include the former 0/90/180/270-degree headings and add overlap without changing road-heading criteria or the candidate selector.

This is angular sampling coverage, not a guarantee that every object is detectable. Occlusion, vertical view, clipping, finite object size, camera mounting geometry and the unchanged distance/confirmation gates still apply. Synthetic bbox/odometry fixtures establish the controller/perception behavior without scene truth.

## Validation

| Source | Scoped result | Exit |
|---|---|---:|
| Frozen baseline + new regression | 7 failed, 45 passed in 0.22s | 1 |
| Isolated candidate + adapted existing fixtures | 52 passed in 0.15s | 0 |

Raw combined stdout/stderr is preserved unchanged in `baseline-tests.txt` and `shadow-tests.txt`; the exact result timing and equivalent relative command arguments are recorded in `validation.json`. The baseline failures are four arbitrary-start-heading coverage cases and three public-detection cases at 35.1°, 45° and 54.9°. The maximum circular-gap assertion proves all bearing directions are within an admitted endpoint sector, rather than checking only a finite angle grid.

The same scoped run includes existing action and perception tests. Existing exact four-view fixtures were expanded to eight endpoints; their semantic assertions still require the same chosen object and final viewing direction, unchanged task relevance and road filtering, unchanged storage preference while holding, and no extra confirmation hit from a return observation. The new stationary fixture executes three complete scans with real Perception and keeps one tentative hit at the same odometry position. Existing tests continue to require three positions separated by at least 15 cm for confirmation. Range/M5, independent-position gates, turn threshold, turn speed and road criteria are untouched.

`git apply --check` passed for `actions.patch` and `tests.patch` against the current frozen working tree; no patches were applied. The source patch contains only the Actions version, scan count/angle, and result reason changes. The tests patch contains the narrow scan regression and updates only the prior candidate-reobservation scan fixtures and corresponding counts.

Before/after source, test, patch and raw-log SHA256 values are in `manifest-before.json` and `manifest-after.json`. Main-package SHA256 equality is checked at handoff. Any integration or real-run validation remains a separate later action after the current freeze is released.
