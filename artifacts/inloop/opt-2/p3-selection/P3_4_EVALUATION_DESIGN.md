# P3.4 offline evaluation contract

This is an interface proposal, not an executed evaluation. True-ball labels remain exclusively in a separate driver/evaluator artifact. The runtime selector receives no truth or layout labels.

## Runtime selection snapshot

At each actual decision, before any motion, save one immutable snapshot with:

- `run_id, decision_id, ball_index, tick`, program and selector hashes, and snapshot schema version.
- Explicit measured `k_cm_per_degree`, calibration protocol/report hash, and fitted distance/turn coefficients. No fallback k.
- Public odometry and road state as received; WM eligible candidates with `obj_id,x,z,state,hit_count,confidence`, and excluded IDs with ordinary runtime reasons.
- Public graph edges with lengths/direction and graph hash; the exact measured VP `roads` and `intervals` used and their hash. No reconstructed truth geometry.
- The selector's complete result, every projected road/progress, path legs, distance, initial turn, turn charge, total cost, unknown/unreachable reasons and selected ID. Record tie policy and projection coverage scope.

Create the snapshot before dispatching the first selected-target action, using the same values passed to selection. For two-ball ordering, preserve both initial candidates and every reselection, including first delivery's post-release public state. Logging must not call observe or advance simulation time.

## Separate exact driver evidence

The driver should capture a read-only simulator state when processing the selection log event, recording `run_id,decision_id,event_tick,capture_tick,stateRevision` plus whether capture is truly same-tick/same-revision. Store true vehicle pose and each object's stable package ID/position/held/delivered state only here. A nearest earlier 5-tick sample is explicitly approximate and cannot establish exact selection-time truth. If no synchronous hook exists, leave exact state unknown; do not add an observe or alter physics to obtain it.

An independent evaluator associates each selected WM track to a real ball using a frozen matching contract and flags ambiguous/unknown associations, wrong-object grabs and ID changes. The executed grab/delivery package IDs must match the chosen confirmed track's association. The runtime never reads this table.

## Independent exhaustive oracle

For each known projected candidate, independently enumerate legal current-road exits and target-road entries, the direct same-road option, and all simple directed graph-node paths. Charge public current/target partial lengths and every full edge length. Nonnegative weights mean removing cycles cannot increase cost; this supplies a finite exact oracle without reusing the selector's Dijkstra implementation. Apply the separately implemented initial shortest-turn formula and explicit k, then compare every cost and the selected minimum. Preserve equal optima.

Report candidate-level coverage, unknown and unreachable counts, absolute selected-minus-oracle cost regret, selected and Euclidean-nearest cost, and percentage reduction only when the Euclidean baseline is positive. For incomplete measured geometry, label the result an observed-projection oracle; do not call it global true-road optimality. True road/object geometry may support a separate driver diagnostic, with its own scope, never substitute silently for runtime inputs.

For two candidate orders, enumerate both orders only if all required public decision-state inputs are available. First delivery changes vehicle pose and the second start state; a missing counterfactual endpoint must be unknown, not guessed from the executed order or Euclidean straight-line travel.

## Timing

Record actual ticks at program start, selection, first command for selected target, each accepted grab, each successful release/delivery, and mission end. Report selection-to-grab, grab-to-delivery, first-selection-to-second-delivery and full-program duration separately; failed/unfinished intervals are censored, not zero. The simulation tick duration must come from the platform record.

A single run observes only one order. Exhaustive offline **model cost** regret does not demonstrate an alternate order's actual elapsed time or task success. Actual time improvement needs an authorized comparable execution protocol; no such extra simulation is part of this implementation task. Preserve the already frozen independent-scene groups and display duplicate layouts separately.
