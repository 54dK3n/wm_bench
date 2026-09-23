# Bounded lateral recovery after an empty grab

`programs/opt2_grasp_fragment.py` supplies **`_opt2_grab_loop()`**, returning the original boolean memory-navigation result. The builder may replace only the original final grab loop, after unchanged road navigation, confirmation, fine movement and approach, with `return _opt2_grab_loop()`. This fragment has not been run in the simulator.

At every original 6cm forward station, the first control action remains an unturned grab. If it succeeds, the fragment immediately emits the existing `memory_navigation_metric` and returns; there is no recovery turn. If it is empty, it tries at most four in-place headings. It does this **before** the next forward advance, including at the last station, so it does not first advance past the ball. If all attempts are empty, it restores the station heading and only then permits the existing 6cm advance. The original 42cm advance cap remains. The scan has zero observe, zero approach and zero translation calls. Approach counters and the last-observe/memory-forward accounting are preserved.

The only inputs are the currently locked WM target and known WM scene, public odometry/road state, and holding class. All helpers are top-level functions and direct helper calls, compatible with the platform asynchronous transformation.

## Public constants and ideal geometric coverage

`competition-core.js:2624–2626` defines the interaction defaults as minimum forward 0.38, maximum forward 1.35 and maximum absolute lateral 0.38 world units. The task scale is 8 world units per metre: **4.75cm, 16.875cm, ±4.75cm**. The older 16.9cm is a rounded display value, not a larger permitted window. No threshold has been fitted from a layout.

Let `F=16.875`, `m=S=4.75` centimetres and `δ=2 atan(S/F)=31.4418555716°`. After the original heading 0, extra headings are `+δ,+2δ,−δ,−2δ`, mirrored when the WM target lies to the right. This ordering is bounded at four extra grabs/five turns per empty station. The actual observed heading is recorded for every attempt.

For an ideal fixed vehicle centre, the union of these headings covers the **original rectangle plus the front circular cap `original_forward≥m` and `radius≤F`**. Proof for the extra portion:

1. A point in the cap has absolute bearing at most `acos(m/F)=73.651355936°`, inside the five-heading grid's `2.5δ=78.604638929°` extent. Its nearest grid heading differs by at most `δ/2`.
2. Side distance after that turn is at most `F sin(δ/2)=4.572316004cm < S`.
3. If the original grab failed on side distance, `radius>sqrt(m²+S²)`, so new forward distance is at least `sqrt(2)m cos(δ/2)=6.466231305cm > m`; it is at most `radius≤F`.
4. Points already in the original rectangle succeed on the original unturned attempt.

The proof is conditional on ideal angle execution, an empty gripper, the intended ball at the stated physical location, unchanged vehicle centre and no skipped angle. It is **not an error-free WM guarantee**. The fixture tests check over 90,000 points in this stated region. Radius above 16.875cm, points behind the original forward plane, actual heading errors and competitor-suppressed angles have no added coverage guarantee. Radius above `hypot(16.875,4.75)` cannot be solved by any in-place rotation. Restoring the requested heading is checked using the already existing 3° aim tolerance; the logged residual makes imperfect execution visible.

## Identity and safety

Before grabbing, the active WM ID must remain the same confirmed ID; lost/replaced/unconfirmed tracks stop the sequence. Known other target or distractor tracks in the **actual heading's** public grab rectangle cause that recovery angle to be skipped. Preexisting holding is rejected; a non-target holding class stops immediately. Every turn and grab is followed by odometry and road-state checks. Any off-road state or unexpected translation during the scan stops without forward advance. No truth or package ID enters this code.

**Identity limit:** `holding()` exposes only the class “目标物”, not a package ID. A stable confirmed WM lock and absence of known competing objects protect the runtime association but cannot prove the physical identity of an unseen or mislocalized second red ball. The result explicitly labels its evidence `confirmed_track_lock_and_holding_class_only`; the independent driver must verify each accepted package ID against the selected confirmed ball. This fragment does not claim exact package identity from class alone.

A complete empty scan adds at most 18 odometry/road queries (five turns and four grabs, each with one pair), plus four holding reads. No other navigation query is used. The original eight stations permit at most 40 grabs total (eight original plus 32 recovery), 42cm forward and 144 added navigation queries per ball. Existing cached pre-grab reads avoid additional simulator queries. This is a bounded fallback and can still consume time/budget; it is not free. Scan logs include track ID, requested/actual offsets, tick before/after, competitors, holding, road status, pose, attempts, restoration and failure reason.

## Old evidence and regression scope

`geometry_acceptance.json` records four independent old local geometries, their source paths/hashes, ticks and original attempts:

| Source | Report-only real position | Original forward sequence cm | Side cm | Original outcome |
|---|---|---|---|---|
| stage1 r2 map01 | B | 23.4 → 17.4 → 11.4 | +1.2 | captured |
| stage1 r2 map04 | C | 22.3 → 16.3 | +2.4 | captured |
| stage1 r2 map06 | D | 17.8 → 11.8 | −4.7 | captured |
| stage1 r3 map09 | E | 31.1 → 25.1 → 19.1 → 13.1 | +3.9 | captured |

These are distinct true target positions and local histories; duplicate B map03 is not counted. They justify preserving the original first grab, forward station sequence and 42cm allowance as regression protections. They are **not three observed side failures**, and no such claim is made. The additional rule is justified by the public geometric proof, not empirical success on these layouts. Synthetic fixtures use the report's one-decimal rounded numbers and retain the same 12/6/6/18cm advances; they are not exact trajectory replay or new trials. Truth coordinates occur only in this separate report artifact.

Reproduce: `python3 artifacts/inloop/opt-2/grasp-recovery/reproduce_acceptance.py` and `python3 -m pytest programs/tests/test_opt2_grasp.py programs/tests/test_target_selection.py -q`. The saved run has **70 passed**: 22 grasp tests plus 48 selection tests. Grasp tests cover ideal geometry, first-grab preservation, lateral recovery before advance, old success geometries, 42cm bound, restoration/query count, track/off-road/translation guards, competitor exclusion, wrong/preexisting holding, the geometric impossibility region, and the real platform AST transform executing the whole loop.
