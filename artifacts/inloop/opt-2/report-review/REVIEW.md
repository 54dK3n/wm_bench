# Stage2 offline evaluator review

The reviewed revisions have no remaining blocking finding from this review. This is a code/integrity review and offline validation, not a stage2 performance result. File hashes and details are in `review.json`; the actual round manifest remains authoritative.

Four issues found during review were resolved before the round:

- P3 now binds the selection's odometry and road state to exact-tick native queries and its complete edge dictionary to a native public graph query. Every public road has native geometry with the fixed unit conversion and public length rounding checked.
- The new independent native audit verifies the complete archive and loaded source, exact sample arrays, every query, every frame's metadata and actual decoded native PNG bytes, and exact frame/render tick and revision. It does not substitute self-reported export flags for file comparisons.
- The actual grab angle now uses the accepted-grab tick's native full-precision pose and the right-positive WM convention. The earlier approach angle remains a separate diagnostic. Missing or conflicting exact poses remain unknown.
- Two-ball attribution again requires a verified memory/new-observations source for each distinct selected track, while retaining the intended relaxation for post-delivery departure failure and the absence of a stage2 600-second hard gate.

The P3 oracle uses both real target packages, all nearest-road projection ties, directed graph paths and current/target road partials. Its shortest-path implementation is independent Floyd–Warshall; turn cost is the initial shortest angle, not accumulated route turns. Selection truth association requires exactly one package within30cm at selection time. All10 layouts remain the denominator, including missing or unmatched choices. Both ball slots participate in independent scenario grouping.

The physical two-ball result requires confirmed WM-to-package association followed by the same package's accepted grab and a delivery that has not been revoked. Existing confirmation, WM sample separation, window, memory movement, approach, on-road, observation, code identity and image-budget checks remain present. Package identity is not inferred merely from holding class.

Validation: the native-evidence module passed20 positive/negative tests and all13 existing archived opt1r2/demo runs. That covered272 native PNGs and63,689,599 bytes, with no original file changes or new simulation. Choice/report tests are recorded in `choice_reporting_tests.txt`; full evidence regression details are in `native_evidence_regression.json`.

The calibration's external-validity limits remain applicable. No outcome, time improvement or new generalization result is asserted here; WM test precision remains limited to E/G.
