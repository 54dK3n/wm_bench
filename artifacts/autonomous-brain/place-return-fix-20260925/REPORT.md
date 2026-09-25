# Isolated Actions v11 patch

Base: copied Actions v10 and its release identity evidence from the completed delivery shadow. Only `autonomous_brain/actions.py` changed in this copy. Main runtime/source files were not edited. The patch also adds `tests/test_brain_place_path_recovery.py`; the existing new dispatch regression file is already present in the main workspace and is not duplicated by this patch.

Apply `actions-v10-to-v11.patch` after the main Actions v10 delivery payload. Do not replace `perception.py` or `run.py` from this shadow: the parent task has newer independent changes in both.

Changes:

- Near-field dispatch uses a current-frame finite numeric distance in `(0, 65]`, independently of remembered range. Unsupported fresh ranges continue through the existing bounded road approach. Visual success remains fresh 25–40 cm / ±10°.
- Placement gets at most eight forward translations, each at most 7 cm, with at most three observed alignment turns before each translation. The observation after translation eight is checked once without adding another turn budget. The existing 19 cm / ±3° release gate and final pixel witness are unchanged.
- Every place primitive records its actual odometry endpoints and observation identifiers. When a failure or completed placement verification leaves the car off road, recovery reverses only this call's verified measured straight segments and rotations, in reverse order, stopping at the first observed road or the nearest recorded road entry. There is no guessed retreat from an off-road start lacking an observed entry.
- Inverse translations are at most 7 cm and observed individually. Partial forward motion is reversed by measured distance. Pose mismatch, sideways/unexpected displacement, zero progress, incomplete segment, or actuator blockage stops recovery. Forward inverses additionally require current finite front clearance to cover the planned step plus 0.1 cm; unknown or insufficient clearance stops before actuation. Backward inverses are restricted to the short path just recorded by this place call.
- Placement marking and its original `placement.frame_id` / `post_observation` are decided before return. A return failure cannot revoke an observed delivery or establish an unverified one. Return has separate `road_return.after_observation`; failed alignment also retains the actual pre-return region detection distance, bearing, and frame for the existing runtime compact evidence field.

Evidence:

- `before-hashes.json`, `after-hashes.json`: package hashes; only actions.py differs in the shadow.
- `test-evidence.json`, `regressions-before.txt`: final 27 new regression cases against unmodified v10: **23 failed, 4 passed** (0.14 s).
- `related-after.txt`: **101 passed** (0.14 s) across eight named action/route/road-clearance/visual/identity test files. The command uses the explicit public WM implementation root; no network/model call or credentials are required.
- New coverage includes the Run08 five-forward/three-turn sequence with explicitly synthetic later successful views, the final eighth-move check, eight-move and three-turn limits, failed multi-turn retracing, measured partial motion, blocked/no-progress return, nearest-entry stopping, rounded Run08 odometry with a synthetic inverse actuator, delivery remaining marked when return blocks, unavailable/insufficient forward clearance, and no invented return from an off-road entry.
- The sensor-only live record is saved separately as `artifacts/autonomous-brain/map05-run-08/place-regressions.json`: final distance 19.502173279657995 cm and bearing -4.68448440629353° did not meet the unchanged gates. The mixed eight-iteration budget was exhausted; the log does not prove additional moves would converge.

This isolated copy omits unrelated evaluator/vendor files. An initial broad test discovery encountered collection errors for those omitted dependencies; the final scoped run explicitly supplies the WM dependency and passes the eight listed relevant files. The parent task will run the merged full suite with its newer runtime/perception changes.

The independent reviewer checked the inverse geometry and identity integration at an earlier actions hash, reporting 36 combined tests passed and four extra boundary checks; this is supporting review only, not the final 101-test result. No live replay or live pass is claimed for this patch.
