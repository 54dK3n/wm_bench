# Opt-1 detection evaluator: development baseline

No stage-1 round-3 test records have been opened for this development evaluation. Inputs are only original `calib_runs*` and `v28r1_batch` records listed in `dev_inventory.json`; previously selected calibration tables are excluded.

## Reproduce

```sh
python3 -m unittest discover -s tools -p test_detection_evaluation.py -v
python3 tools/detection_evaluation.py --dataset dev
python3 tools/detection_evaluation.py --dataset dev --filter-file programs/detection_filter.py
```

The third command applies only once the runtime filter exists. The default output directory is this directory. The candidate report contains standalone filtering and filtering composed with the old confidence cutoff; the composed result is primary. Development unknown labels remain visible and do not prevent rate exploration. Development results never claim held-out test PASS.

## Label contract

Compare raw bearing to the true bearing from the camera origin (camera forward offset 5.375cm for legacy records). M5 gives robot-centre range: `rho=1.6239+1.0187*raw/cos(beta)`, `d=hypot(5.1557+rho*cos(beta),rho*sin(beta))`. A same-colour ball must satisfy bearing error ≤3° and **one-dimensional centre-range difference ≤30cm**. This is not a 2D projected-position error. Two or more matching same-colour balls are ambiguity and excluded. No matching same-colour ball is false; a matching opposite colour additionally records wrong_class. Held objects are excluded.

Raw values ≥100cm are mechanically evaluated for labels and marked capped. This does not authorize using capped readings as precise runtime positions. Missing exact driver pose produces unknown, never false. Test acceptance requires exact native frame/query/render evidence and complete ten-layout coverage; only ambiguity may leave its performance denominators.

## Old filter and coverage

The old independent fake-detection filter does not exist. Actual old behaviour is requested-confidence filtering: calibration confidence 0.3; v28r1 206 observe frames at 0.4 and four at 0.45. Category selection is task routing. WM eligibility `40<=raw<90` is downstream and is not a fake-detection rejection.

| Colour | Raw | True | False | Ambiguity | Unknown | True filtered | False filtered | False-kill | Precision | Residual false share (labeled kept) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| red | 306 | 121 | 33 | 0 | 152 | 0 | 0 | 0.0% | undefined (0 rejections) | 21.43% |
| blue | 847 | 111 | 491 | 0 | 245 | 0 | 0 | 0.0% | undefined (0 rejections) | 81.56% |
| all | 1153 | 232 | 524 | 0 | 397 | 0 | 0 | 0.0% | undefined (0 rejections) | 69.31% |

711 observe frames; 1,153 raw detections; label coverage 65.57%. Legacy same-tick driver samples support 464 frames/756 detections, but contain no PNG/frameId/matrixWorld and retain the recorder's rounded position/heading precision. The other 247 frames/397 detections are unknown: 195 detections lack driver samples entirely, 202 lack an exact sample tick. No nearest-tick pose is substituted. The unchanged calibration bracketing option is explicitly labeled, but no current development rows use it.

Separate WM-window counts: 410 inside / 743 outside. They do not affect filter metrics. Nine labeled false blue detections match an opposite-colour ball. All-retained false-kill=0 and all-rejected precision=false-prevalence self-checks pass separately for red/blue/all.

## Development source inventory

| Raw source (under artifacts/inloop) | Layout | Frames | Raw detections | True | False | Unknown |
|---|---|---:|---:|---:|---:|---:|
| calib_runs/try-1.json | map-09 | 25 | 33 | 12 | 15 | 6 |
| calib_runs_v2/attempt-01.json | map-01 | 35 | 56 | 13 | 43 | 0 |
| calib_runs_v2/attempt-02.json | map-02 | 1 | 2 | 0 | 2 | 0 |
| calib_runs_v4/a1.json | map-07 | 14 | 21 | 5 | 16 | 0 |
| calib_runs_v5/attempt-01.json | map-09 | 32 | 66 | 0 | 0 | 66 |
| calib_runs_v6/attempt-02.json | map-05 | 66 | 101 | 18 | 83 | 0 |
| calib_runs_v6/attempt-03.json | map-06 | 85 | 144 | 43 | 101 | 0 |
| calib_runs_v6/attempt-05.json | map-08 | 85 | 104 | 42 | 62 | 0 |
| calib_runs_v6/attempt-06.json | map-01 | 73 | 129 | 0 | 0 | 129 |
| calib_runs_v6/attempt-08.json | map-04 | 85 | 164 | 53 | 111 | 0 |
| v28r1_batch/map-01.json | map-01 | 10 | 16 | 4 | 7 | 5 |
| v28r1_batch/map-02.json | map-02 | 9 | 14 | 3 | 5 | 6 |
| v28r1_batch/map-03.json | map-03 | 8 | 12 | 3 | 5 | 4 |
| v28r1_batch/map-04.json | map-04 | 10 | 11 | 2 | 3 | 6 |
| v28r1_batch/map-05.json | map-05 | 10 | 8 | 1 | 5 | 2 |
| v28r1_batch/map-06.json | map-06 | 30 | 63 | 20 | 33 | 10 |
| v28r1_batch/map-07.json | map-07 | 61 | 87 | 9 | 21 | 57 |
| v28r1_batch/map-08.json | map-08 | 10 | 6 | 1 | 3 | 2 |
| v28r1_batch/map-09.json | map-09 | 37 | 41 | 1 | 8 | 32 |
| v28r1_batch/map-10.json | map-10 | 25 | 75 | 2 | 1 | 72 |

## Runtime separation and replay API

`dev_runtime_frames.json` has original raw observation dictionaries, available public logged odometry (or null), road_state=null, tick, and offline run/frame identifiers. The replay adapter resets a filter instance per run and passes **only** observations, odometry, road_state, tick. It never fills missing odometry from truth samples. Truth, world coordinates, package IDs and associations exist only in `dev_labels.json` and are never sent to the runtime filter.

Runtime API: `DetectionFilter.update(observations, odometry=None, road_state=None, tick=None)` returns `kept_indices`, `rejected_indices`, `diagnostics`. Indices must partition the original frame exactly once; mutation of raw observations is rejected. Row IDs are assigned by the evaluator and are not passed to the filter.

## Held-out test lock

The evaluator opens the test directory only with explicit `--dataset test --filter-file ... --freeze-manifest ...`. The manifest is an absolute-path→SHA256 map (or `{ "files": ... }`) containing the current evaluator and runtime filter; all entries must match before any test directory discovery. This is a technical safeguard; only the parent task authorizes opening the held-out data after freezing rules.

Top-level `all_gates_pass` can be true only for test data with all ten distinct layouts, complete exact native frame/query/run/tick/revision/PNG/hash bindings, no unknown detection labels, and nonzero denominators for both colours with false-kill ≤2% and filtering precision ≥95%. Precision with no rejected labeled detections stays undefined and cannot PASS.
