# Confirmed-history reacquisition: sensor-only baseline

This is an offline regression package, not a successful physical trial. No scene layout, evaluator truth, model credentials, live API, or simulation controller commands were used. The running package and original Run13 evidence were not edited by this test task. Runtime implementation belongs to the root task and is evaluated separately.

## Frozen source

- Baseline commit: `1651d313139e070ae1355045617336c6286a7c08`.
- Perception v6 SHA256: `2bedb2c8f839b8d954366d6070e131ee5ac149d7496608250ec805a8e5a19a17`.
- Actions v14 SHA256: `767f832f8af31ee290b559ed1409b09b04b1292ed0f9dbb52b47f3e2646bc655`.
- Full package hashes: `artifacts/autonomous-brain/reacquisition-fix-20260925/baseline-source-manifest.json`.
- Frozen execution copy: `artifacts/autonomous-brain/reacquisition-fix-20260925/baseline_source/`.

The test file uses a read-only `reacquisition_bindings()` query when present. The pre-fix baseline has no such facility; the test helper treats that absence as an empty binding list. Positive binding failures therefore show the absent behavior without hiding it behind an API exception. A separate positive regression reaches a real synthetic delivery before asserting the historical obligation has been resolved.

## Run13 observations that motivated the regression

All references below are observation indexes in `artifacts/autonomous-brain/map05-run-13/map-05-run-1/brain/observations.jsonl`; actions are corroborated by its `rounds.jsonl` and `motions.jsonl`. Analysis was bounded to round 51.

| Observation | Sensor and memory evidence |
|---|---|
| 263 / r43 / 179.66s | `target_047` receives its third independent-position hit, raw69cm / +1.10 degrees. It becomes CONFIRMED, confidence .79375. Accepted positions are frames163,222,263; no stationary rotation is counted as a new position. |
| 273 / r44 / 188.04s | After road travel, memory distance56.8824cm / bearing88.1551 degrees. No red detection. Confidence .7205098, still CONFIRMED. |
| 274 / r44 / 189.14s | Turn toward the remembered position; no red detection. Memory bearing−.04495 degrees, distance56.8824cm. Confidence `.7205097834 * 2^(-1.10/1.5) = .4333956541`, now STALE. |
| 275 / r44 / 190.06s | Forward8.503966cm, still no red detection. Confidence `.4333956541 * 2^(-.92/1.5) = .2833040750`. Road heading error88.2 degrees, right clearance.1cm, memory distance48.3771cm. Next permitted translation is zero, so go_to returns `final_approach_requires_road_reposition`. It is not an LLM rejection or initial CONFIRMED guard rejection. |
| 293 / r47 / 203.90s | After the r45 scan and r46 recovery, confidence is .1884286083. A1.16s turn leaves the remembered target inside the FOV but no red detection; `.1884286083 * 2^(-1.16/1.5) = .1102428192`, so the track becomes LOST and is archived. |
| 298/299 / r48; 308/309 / r49 | Fresh red detections have raw34cm/−19.84 degrees and raw31cm/+31.33 degrees. All are outside the raw confirmation window and have no track ID. Their converted positions are14.4155cm/14.2034cm from047's historical position. This is compatibility under the existing distance gate, not proof that they are the same physical ball. The old track remains LOST with last_seen179.66s. |

The r44 movement limit is reproducible from the public road sensors: `(8.6-.1) / max(abs(sin(88.2±.05 degrees))) = 8.50396632781958cm`. At the next observation the numerator is `.1-.1 = 0`. The failure respects that road-clearance bound. These observations cannot establish why no red pixels were returned before the later near-field sightings.

## Upstream behavior and the actual reachability defect

The vendored WorldModel's static provider sets same-class distance association to30cm, maximum speed0, maximum gate30cm, and independent-position gap15cm. It retains the original three-hit confirmation rule. `build_cost_matrix` gates by distance and category; `greedy_assign` itself selects a nearest compatible assignment and does not reject all ambiguity.

`WorldModel.update()` associates only its active `_objects`. Natural LOST tracks move to `_lost`; `get_object(include_lost=True)` is a read-only archive lookup, not a restoration operation. Perception's near-field refresh also uses only `get_scene()` and only tracks whose current state is CONFIRMED. It refreshes visibility timestamps without altering confidence, state, geometry, or hit counts. It cannot restore STALE or archived LOST identities.

Completion correctly keeps ever-confirmed LOST red identities pending. Combined with the absence of an archive-reacquisition path, this produces a permanent historical obligation: normal future observations can create and confirm a new ID but cannot make the old ID actionable. Moving away and confirming again therefore cannot, by itself, resolve the old obligation.

## Minimal public-sensor reproduction

Fixtures come from `tests/test_brain_perception.py`: calibrated camera intrinsics, a public virtual-CV bounding box, and explicit synthetic odometry. The tests never assign states, counts, positions, or DELIVERED directly.

1. Frames1–3 at forward0/16/32cm observe raw80/64/48cm, bearing0. Old `target_001` becomes CONFIRMED with its own three separated positions.
2. Frame4 at6s contains no detections while the remembered position is in view. The old identity naturally archives as LOST, hit3, ever_confirmed=true.
3. A near-field raw25cm frame cannot create a hit or revive that identity.
4. Three fresh legal frames at the original separated poses create `target_002`, then give it its own three-hit CONFIRMED state. Its fused position is exactly the old fused position; neither ID is rewritten. Baseline completion still lists both IDs as pending.
5. An empty old-position observation plus an explicit synthetic holding response supplies the normal pick evidence. A fresh release observation contains one red ball and one public green-region pixel box. Its exact current frame, ball ID/category/position/bbox, release boundary, preexisting IDs, empty gripper, and unique inside-region witness pass the existing `mark_delivered` gate. The new ID becomes DELIVERED. Baseline completion still lists the original LOST ID as pending, reproducing the defect without physical identity truth.

Additional public-sensor fixtures create two archived confirmed competitors, or an active TENTATIVE/STALE/CONFIRMED neighbor. They remain ambiguous even when an archive-only search would have one candidate. Both input orders are tested, including two new identities becoming confirmed in one frame.

## Required candidate semantics

The candidate must wait for a new identity's own normal three-position CONFIRMED evidence, using the unchanged raw range/bearing and association gates. It can then record a bidirectionally unique historical binding using a complete immutable competition snapshot. It must exclude action lifecycle identities and delivery aliases as historical candidates, reject ambiguous matches, and preserve both original tracks and timelines. Older hits cannot be borrowed to confirm a new identity. Queries must be detached and nonmutating.

Binding is an auditable association hypothesis, not delivery and not independent physical-identity proof. The old row remains LOST and pending until the bound successor, or the valid terminal successor of a chain, is DELIVERED by the original pick/place evidence. Cycles, missing rows, duplicate identities, incomplete/nonfinite evidence, invalid three-position evidence, and ambiguous candidates must keep the historical obligation pending.

## Baseline test evidence

Command, run from the frozen execution copy with `WORLD_MODEL_ROOT=vendor/wm_kit_opt2` resolved against the repository root:

```text
python3 -B -m pytest -q tests/test_brain_reacquisition.py -p no:cacheprovider
```

- Final baseline v3: **6 failed,32 passed in0.15s; exit1**.
- Full output: `artifacts/autonomous-brain/reacquisition-fix-20260925/baseline-tests-v3.txt`.
- Exact invocation metadata and test SHA: `artifacts/autonomous-brain/reacquisition-fix-20260925/baseline-validation-v3.json`.
- Test SHA256: `e6c5c1fe29bef5dcdc966c1f4f84ddb4798e6cbaf4b2b1e66729ce3c653942fb`.
- The six failures are absent binding,29cm/30cm accepted-gate positives, detached binding query positive, confirmed-successor delivery leaving old pending, and a valid reacquisition chain. The32 negative/safety cases pass.

Earlier raw evidence is retained. Baseline v1 had four fixture defects in addition to the six intended failures: three compared a robot-relative distance after changing robot pose, and one requested an impossible pixel box extending beyond image width. V2 fixed these by checking unchanged raw archive fields and using a fully contained raw80cm/+35.5-degree out-of-bearing-window box; it had6 failed/22 passed. V3 added ten malformed-binding consumer checks. No physical or perception threshold was changed to repair those fixtures.

Root's separate `run13-sensor-replay.json` reports365 saved observations under candidate Perceptionv7, unchanged per-frame perception evidence except version, unchanged objects, and zero bindings. That is consistent with not forcibly identifying the saved near-field or insufficient-hit tracks. It does not establish a successful physical run or replace the old trial's result.
