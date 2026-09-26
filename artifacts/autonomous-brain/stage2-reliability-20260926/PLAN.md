# Reliability fixes and stage-two acceptance protocol

Starting local and freshly queried remote development HEAD:
`037593820f9d7aea77b4bb57d4b63f589e1eed01` on
`54dK3n/wm_bench`, branch `codex/autonomous-brain`. The workspace was clean.
No external `review_probes.py` was found in the repository; regressions will
independently encode the reviewer-supplied counterexamples and positive controls.

Historical source `d1538f7570a42b760ad518f133eaefd7bcac83a8` and report
`4a48664eecd3f46984f9ca48674aefe53fd9518d` are immutable. Their task-level
stage-one PASS, global Judge 2 match / 2 unverifiable, prefix diagnostic 4 match,
and original bytes remain historical results, not results of this candidate.

Order:

1. Restore and hash-check the published evidence in an isolated, ignored directory.
2. Reproduce R1–R5 with negative and positive controls; implement reliability fixes.
3. After reliability regressions pass, implement and validate stage-two topology,
   exploration states and independent evaluation; record a complete road
   reposition diagnostic with its exact test/diagnostic classification.
4. Freeze one candidate source, unchanged platform, dependencies and configuration.
5. Run at most one formal known-two-ball stage-one regression (200 rounds,
   1200 simulated seconds).
6. Only after that passes, run at most one formal unknown-quantity stage-two
   task with exactly the same frozen source and configuration.
7. Preserve evidence, publish the report and archive, verify the remote, and stop.

Intentional red reproductions are development evidence. A failed completed
pre-acceptance gate or formal run is a STOP: preserve and diagnose the failure,
do not keep changing code and launching more formal runs. Stages three and four
are not authorized. Tests, fixed sensor replay, model replay and genuine live
closed-loop runs must be reported separately. No thresholds or budgets are
relaxed to manufacture success.

Formal model remains DeepSeek Flash, temperature 0, thinking disabled. Only
approved public sensors and whitelisted robot operations may enter the brain.
Map truth, evaluator identities and platform internal topology stay evaluator-side.

The completed reliability prerequisite gate will run all `tests/test_brain_*.py`
and all `tools/tests/test_autonomous_brain_*.js`, after the three repair owners
finish their development iterations. The Python transport tests require only
loopback HTTP servers; sandbox binding denials in development are recorded as
environment errors, not simulator runs. The gate will run with that local socket
capability. It does not start the simulator or contact a model provider. Platform,
WorldModel and the original evidence hashes must also remain unchanged.

The final completed offline gate runs the same full Python and Node suites on
the integrated stage-two candidate, rechecks all immutable inputs and source
stability, and reruns the complete synthetic curved-road reposition diagnostic.
Only a PASS permits a frozen source commit and the first formal run. Fixed-input
historical perception diagnostics may diverge under corrected rules; they report
that divergence rather than assert successful new closed-loop behavior. Their
interpretation never replaces the completed test gate or the historical result.
