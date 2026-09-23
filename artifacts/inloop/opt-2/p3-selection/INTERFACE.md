# P3 target selection interface

`programs/target_selection.py` contains only pure top-level functions. No robot, truth, layout, image, file or network API is used. No live trial has been run for this module.

Call `select_target(candidates, graph, road_state, odometry, measured_geometry, k)`. The `k` argument is mandatory, finite and nonnegative, in centimetres per degree. It must come from the released measurement report; the synthetic tests' 0.5 and 2 values are algebra inputs, never runtime defaults. The module does not choose or calibrate k.

The original contract is `/Users/ken/wm_kit/selection/selector.py` and `selection/turn.py`: **cost = road path distance in cm + k × absolute initial turn in degrees**. Initial turn means current heading to the candidate's current absolute bearing; it is not the sum of turns along the route. The shortest signed turn is in **(-180, 180]**, with a half turn represented as +180. The public heading is left-positive; WM x is right and z is forward, so absolute heading is `-degrees(atan2(target.x - rightCm/100, target.z - forwardCm/100))`.

Inputs:

- `candidates`: dictionaries with unique nonempty string `obj_id`, finite WM-frame `x,z` in metres, optionally `name,state,confidence`. The caller supplies eligible WM candidates after its delivered/held/region exclusions. Confidence is not part of selection cost; no new confidence threshold is introduced.
- `graph`: public `edges`, each with `roadId,fromNodeId,toNodeId,lengthCm` and optional boolean `oneWay`. Node coordinates are neither read nor required.
- `road_state`: public `roadId,roadProgressCm,onRoad`.
- `odometry`: public `rightCm,forwardCm,headingDeg`; `tick` can be included in the caller's snapshot.
- `measured_geometry`: the existing VP dictionary structure: `roads[roadId]` is a list of `{s,x,z}` samples, where s is public road progress in cm and x,z are odometry-frame metres; `intervals[roadId]` contains actually traversed progress spans `[start,end]`.

Candidate projection uses only finite measured segments fully covered by traversed intervals. It neither interpolates across untraversed gaps nor extrapolates from singleton observations. A clamped interior measurement boundary that would require unseen road geometry is unknown. The nearest valid measured projection determines the target road/progress. Equal-distance projection choices are evaluated separately; public directed topology determines route feasibility and cost. Lateral projection distance is logged but is not added as fictitious on-road travel and grants no approach permission.

Dijkstra starts at both legal endpoints of the current road, charging its remaining/preceding partial length, and ends through legal endpoints plus target-road partial length. Same-road direct travel is considered. One-way constraints apply to every partial and full leg. Unreachable and unknown costs are `null`, never zero or infinity.

**Partial-geometry limitation:** when any public road lacks complete measured geometry, `geometry_coverage.global_nearest_road_status` is `unknown` and every computable candidate has `known_geometry_estimate_only=true`. Ranking these candidates is an estimate over observed projections; it is not a claim that an unmeasured road could not give a better projection. A caller may continue collecting public geometry when that distinction matters. `complete_candidate_costs` describes candidate cost availability, not complete global geometry.

Output includes selected ID/cost/path distance/turn, exact cost model and geometry coverage, and every candidate's status/reason, WM position, Euclidean diagnostic, absolute bearing, turn, turn cost, projection options and all route legs (`roadId,from_progress_cm,to_progress_cm,distance_cm,direction,kind`). Ties use cost, absolute turn, then candidate ID. Inputs are not modified.

Integration into `_demo_memory_target` should collect a single public snapshot, convert WM objects to the above whitelist, call `select_target` with measured k, print the **complete result plus decision ID and snapshot tick**, and resolve the selected ID back to the same WM object. Unknown selections must remain explicit; they must not silently fall back to a Euclidean surrogate while being logged as P3. This document is an integration contract; the main program has not been edited.

Offline validation is in `programs/tests/test_target_selection.py`: 20 explicit angle answers (five cross-zero and five cross-180), ten hand-solved topology counterexamples with at least 10% cost reduction over Euclidean-nearest, directed/partial-edge cases, unknown geometry, no input mutation, invalid k, zero cycles, and execution after the platform's actual AsyncRobotTransformer. All module functions are top-level and helper calls are direct names, so platform automatic awaiting applies.
