# Fresh observed reverse-exit completion: NAV v3 shadow

Run11 contains a reproducible road-memory error independent of its failed platform export. Replaying `artifacts/autonomous-brain/map05-run-11/map-05-run-1/brain/rounds.jsonl:76` with observations 409 and 410 exactly reproduces the logged round77 junction history under frozen Navigation v2. At destination `junction-19`, the historical absolute exit −90° becomes completed even though current observation410 exposes only −149.5°, +90°, and −11.3°.

The old rule chooses among all remembered exits using the final motion's endpoint chord. Observation409 is at (−89.4,86.5)cm and heading169.2°; observation410 is at (−116.9,65.4)cm and heading135°. Its reverse chord is −52.5019568°, making the absent historical −90° appear closer than the fresh −11.3° exit. The observed incoming tangent is different: local heading error is0°, so its reverse is −45°. These are brain odometry and local-road observations, not layout coordinates.

## Isolated change

`navigation.patch` changes Navigation v2 to v3. It records the last translating observation's local road tangent, using public `headingErrorDeg = road heading − robot heading` from `workspaces/guangyang-platform/projects/car-python/competition-core.js:889`. An actual displacement must agree with one direction of this tangent within the existing strict 45° angular range. Stationary observations and turns do not overwrite that arrival evidence.

Reverse completion then requires exactly one **current observed** exit within the same strict 45° range and exactly one remembered counterpart under the existing strict 15° exit identity range. Missing or invalid tangent values, incompatible lateral displacement, multiple current candidates, and ambiguous remembered identity leave reverse completion unsupported. Historical bearings absent from the current sensor cannot win merely by being geometrically closest. The originating selected exit still completes under the prior arrival rule.

For the exact r76 replay, the candidate leaves historical −90° uncompleted and completes current −11.3°. Both versions retain the same 25 unexplored-exit count for this isolated step: this corrects which edge has evidence, without manufacturing overall exploration completion.

## Validation and scope

- Frozen v2 plus final narrow regressions: **11 failed, 8 passed**; raw output in `baseline-tests.txt`.
- Isolated v3: **19 passed**; raw output in `shadow-tests.txt`.
- `run11-r76-replay.json` includes the exact relevant logged inputs and old/new outputs. Baseline summary equals logged round77 exactly.
- Existing four navigation-test assertions remain unchanged. Their fake local-road observations now include the public tangent-error field; the curved cases supply the local tangent consistent with the already-stated measured road direction.
- New tests cover the actual r76 mismatch, curved arrival versus chord, retained evidence across a stationary turn, ambiguous fresh and remembered exits, missing/null/nonfinite/bool tangent, incompatible lateral displacement, strict 45° boundary, heading-error sign, backward arrival, and the unchanged node identity radius.
- `git apply --check` passed for both patches; the main source was not modified by this work. The candidate resides only in a temporary complete package. `run_scoped_tests.py` accepts the baseline/candidate source directory and selected test paths. Raw test logs retain interpreter paths as original evidence; they are not portable report links.

The r75 two-node ambiguity remains deliberately unresolved. The observed node positions are 177.5528 mm apart, beyond the existing 150 mm radius, despite similar observed exits and an actual return path. This patch neither expands that threshold nor merges those nodes. It also does not rewrite historical completion state in already-finished runs.

This is a bounded sensor-only correction. Ambiguous curvature or junction geometry may leave an incoming exit uncompleted. It does not establish a globally correct graph, explain every revisit, prove physical delivery, or replace the missing native Run11 export. No simulator, model API, credentials, layout, or truth was accessed.

The copied package already contained the separately integrated Actions v14 scan change; its before hashes are recorded. Navigation itself was byte-identical to the Run11 frozen commit, and these patches contain no Actions changes.
