# Independent release-aim regression evidence

Only `tests/test_brain_release_aim.py` and this new evidence were added by the test author. No runtime source, existing tests, trial logs, truth, layout, or credentials were modified or used.

The 36 sensor-scripted tests use public pixel boxes, odometry, a calibration projection stub, and the existing fake place runtime. They cover mirrored free quarter selection; deterministic ties; red/blue/obstacle occupancy and expanded boundaries; complete unique largest green component; invalid projection; heading sign conversion; detached evidence; no-old behavior; fixed aim despite later green-box drift; the original 19 cm/3 degree release gate; finite approach budget with partial measured movement; holding on failure; and unchanged postrelease witness requirement. These are offline controller regressions, not a physical-run success claim.

The baseline imports only `baseline_source/autonomous_brain/actions.py` (v16) in place of the current actions module. Other modules and the same new test file remain unchanged. Missing-helper and missing-behavior failures are expected feature contrasts, not separate claims of distinct defects. Exact command arguments, exit codes, complete outputs, test snapshot, and before/after source hashes are adjacent `independent-release-aim-*-v1` files.

Baseline: 34 failed, 2 passed in 0.13s; exit 1.

Candidate: 36 passed in 0.04s; exit 0.

Source files were unchanged across both test executions: True.
