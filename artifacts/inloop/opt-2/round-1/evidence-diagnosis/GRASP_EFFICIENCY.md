# Grab recovery: read-only round 1 findings

Reproduce with `PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-1/evidence-diagnosis/grasp_efficiency.py`. `grasp_efficiency.json` records every raw line, native interaction, exact same-tick full-precision pose, target package, reconstructed components and input SHA256. It does not start a simulation. The WM components are reconstructed from the rounded WM target log and public odometry; they are labelled approximate. The per-station WM radius comes directly from the unrounded `grab_step.wm_distance_m` log.

## Quantified waste and geometric distinction

The public grab rectangle is **4.75 ≤ forward ≤ 16.875 cm, |side| ≤ 4.75 cm**. Under any in-place heading, its maximum radius is therefore **sqrt(16.875² + 4.75²) = 17.5307765088 cm**. A target beyond this radius cannot be reached by rotating. `forward > 16.875` alone is not sufficient to prove this: a point near a corner can have greater forward distance at the current heading but still fit after a small rotation.

Across all ten layouts, **17 scans / 68 extra grabs** consumed **91.46 simulation seconds**. Every scan was empty, restored its original heading, and the eventual successful grabs all occurred at an original, unturned station after a 6 cm advance. Each complete scan cost **5.38 s**: four failed grabs occupy 3.60 s of simulation time; the five turns occupy the remaining 1.78 s. Native platform code uses 480 ms closing plus 420 ms opening on failure (`app.js:12068`, `:12108`). This excludes other host wall delays.

Truth proves **14 of the 17 scans** were outside the maximum radial reach (75.32 s). Only **11** are also directly identifiable from the runtime WM at the station. The other three unreachable scans occur when WM underestimates distance. The proposed runtime rule must not use truth to skip them.

## Three independent scene examples

The frozen round's comparator puts these in distinct scenarios S04, S05 and S08. They also have distinct true target positions C, D and E and different relative target geometry. They are not merely different layout names. Indices below are zero-based indices into raw `lines`; interaction ticks come from full-record events, before the later `grab_step` log.

| Scene / ball | Raw line / native tick | True forward / side / radius (cm) | WM forward / side (approx cm), exact logged radius | Empty scan cost |
|---|---|---|---|---|
| map-05 / 1, C, S04 | 525 / 4748 | 19.4548 / −1.6094 / 19.5213 | 21.2115 / +0.0337, r=21.1972 | 4 grabs / 5.38 s |
| map-06 / 1, D, S05 | 645 / 3747 | 17.8226 / −4.7371 / 18.4414 | 21.9733 / +2.3310, r=22.0793 | 4 grabs / 5.38 s |
| map-09 / 1, E, S08 | 1029 / 5924 | 31.0824 / +3.9003 / 31.3262 | 22.0772 / −1.0479, r=22.0682 | 4 grabs / 5.38 s |

All three WM estimates are beyond the public corner radius; after the existing 6 cm advance, predicted forward remains above 4.75 cm and predicted side remains within ±4.75 cm. This supports a general geometry-based efficiency rule, not a newly fitted confidence/distance margin.

## Proposed bounded rule and expected local savings

Keep the original unturned grab at every station. After it is empty, if another original 6 cm advance is still available, skip lateral recovery only when:

1. WM radius exceeds `hypot(public_max_forward, public_max_side)`;
2. predicted forward after that original advance is at least `public_min_forward`;
3. predicted absolute side is no greater than `public_max_side`.

Otherwise keep the existing angle scan. Keep the final station's scan because no forward step remains. Use current WM and odometry only, preserve competitor/confirmed-track/on-road checks and original movement cap, and log all inputs/conditions. This requires no observe or additional approach, and no new fitted threshold.

This rule identifies one first-station scan on each of 11 grabbed ball slots: **44 extra grabs / 59.18 s** locally avoidable. Counting map-01/map-03 only once gives **40 grabs / 53.80 s**. On map-05, 6 and 11 total grabs include 4 and 8 lateral extras; only the first 4 per ball meet this rule, giving a local 10.76 s reduction. On map-10, both six-grab sequences each contain one qualifying scan, also 10.76 s. These are sums of observed omitted actions, **not a prediction that a new run succeeds, takes exactly that much less time, or follows an identical route**.

WM error prevents a physical guarantee. For example, map-05 ball 2's second station (line 3004, native tick 13731) has true r=17.5690 cm but WM r=15.4629 cm. map-09 stations 2 and 3 have true r=25.3838/19.4769 cm but WM r=16.0709/10.0866 cm. The proposed rule preserves their scans. Conversely, WM overestimating distance could skip a scan that would have caught a truly nearby lateral target. Retaining the original first grab and bounding the original advance reduces disruption but does not eliminate that risk.

## Relation to faster road travel

Using the existing CRUISE speed for road-memory travel is independent of this optimization. It does not remove the four grab animations or angle rotations. Keep fine approach and the original 6 cm grasp advance unchanged; retain native road clamping and on-road checks. The shared `_vp_enter` / `_vp_travel` helpers are also used by confirmation, so a speed change must be explicitly scoped to memory approach (and existing delivery), not globally applied to all VP calls. `_mag_frontier_step` currently passes SLOW directly and needs consistent scope if road-memory travel is changed. Faster travel can change discrete arrival poses; the next full frozen batch is needed to assess effects.

No task code was changed to produce this diagnosis. A later authorized implementation must be separately hashed and tested.
