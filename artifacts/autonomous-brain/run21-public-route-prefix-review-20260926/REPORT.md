# Run21 public route-prefix audit

This audit uses only the first 138 completed rounds, observations 1–893 and the first 617 motions. It reads no truth, recording, layout, credentials, network or simulator. It does not modify Run21 or production code. These public observations do not establish physical junction identity or final task acceptance.

## Reproduction and scope

Run from the repository root:

```text
python3 artifacts/autonomous-brain/run21-public-route-prefix-review-20260926/review_public_routes.py
```

`input-manifest.json` identifies each exact raw-line byte prefix, so later appends to the active log do not change this audit's inputs. The script checks the prefix hashes before and after execution. `navigation-v5-frozen.py.txt` is copied verbatim from commit `1d9b0a79aed7a67a539a03a2c7d5b181bbcbec21`, SHA-256 `9448fec895b60837dca0b3cdaf3568b36b16bc8379e8dc547320807a1d48d958`. It is executed in an isolated module without importing current production files. No navigation thresholds are changed.

The replay checks original geometry at all 138 decisions and synchronizes only the saved original `visits`, `completed` and `blocked` fields. It does not guess omitted action callbacks. Under that explicitly stated synchronization, all 893 observations leave the inherited v4 fields equal, and all 138 recomputed compact hints exactly equal the logged hints. Queries do not mutate any memory field. The collector reconstructs 61 directed traversals. This is not an independent reconstruction of every original flag mutation.

Evidence is in `findings.json`; exact execution outcome is in `execution.json`, `stdout.txt` and `stderr.txt`. The script passed with exit code 0.

## Sampled node-context overlap

Across this prefix, exactly one adjacent pair has different cached node IDs while both observations report on-road/at-node and the full world-heading exit sets match uniquely within the unchanged 5° test: r25 obs141→142, J11→J10. The motion is a completed 6 cm backward step; odometer distance changes 624→630 cm and position changes (−130.5,112.7)→(−124.5,113.0) cm. Both full world-heading sets are {−142.1°,16.3°,91.3°}.

The larger obs140–145 sequence has that same complete context at every sample. Four 6 cm backward motions from obs140 to144 traverse 24 cm, and obs145 is stationary. The remembered node changes from J11 to J10 within this sampled corridor. This is evidence of positional memory buckets dividing a sequence of matching public node contexts. Discrete samples cannot prove that `atNode` stayed true between samples, and cannot prove that the buckets identify the same physical junction. No aliasing or U removal follows from this observation.

J23/J24/J29 share approximately {−90°,0.7°,90°,179.3°}, but there is no corresponding sampled continuous-at-node cross-bucket sequence. In r73–74, obs475 is J23, obs476–478 explicitly have `atNode=false` and no exits, and obs479 is J24. J29 first arrives at obs641 between explicit non-node observations 639/640 and643. Their physical equivalence remains an unproved hypothesis. `findings.json` retains the complete relevant public windows and their r138 memory obligations.

## Recorded hints and r115–122 execution

There are 54 recorded-route hints across 18 decisions in this prefix. None targets J10/J11, the sampled overlap pair above. Repeated targets include J16 exit2/world90° (12 hints), J20 exit3/world−90° (8), J21 exit1/world−90° (8), and J23 exit2/world−90° (4). These are uncompleted memory exits; the observations do not independently establish that they are untraveled physical exits.

For each actual departure in r115–122, the script computes the effective chosen angle from the fresh pre-`take_exit` heading plus its real motion parameter, relative to the round-start heading. This also audits omitted-angle actions without assuming that the model selected a hint.

| Round | Followed first traversal | Historical arrival | First actual arrival / final / next round | Result |
|---|---|---|---|---|
|115|23|obs266, J15, (15.6,27.4) cm; full headings −90/−180/90/0.8°|759 /760 /761|Exact position, node and full context match|
|116|16|obs171, J1, (0,2.4) cm; full heading 0°|763 /764 /765|Exact position, node and full context match|
|117|17|obs175, J2, (0,25) cm; full headings 90/0.8/−90/−180°|767 /768 /769|Exact position, node and full context match|
|120|17|obs175, J2, (0,25) cm; same four headings|785 /786 /787|Exact position, node and full context match|

For all four rows, recomputing `current_node` at the historical arrival position with the nodes present at that decision and at the next decision returns the original cached node ID. No later nearer-node remapping explains this section. Heading of the robot itself need not match; the full world-heading context does match under the existing rule.

The route is interrupted before reaching its ultimate U target:

- At r118/J2, the action is `explore {}`. The original automatic ranking is `(blocked, completed, visits, abs(angle))`. All four current exits are completed and unblocked; −180° has zero visits and the other three have one. The code therefore selects −180°, actually returns to J1, and stops on a new object confirmation. Valid route hint first angles were 0.8° toward J16 through traversal18, and −90° toward J20/J21. The actual departure matches none.
- r119 performs a stationary full-circle look. r120 follows traversal17 back to J2 exactly.
- r121 performs another stationary full-circle look. r122 explicitly selects 90°, while current hint first angles remain 0.8° or −90°. It stops outside a node after new object observation.

Thus the followed first legs were fulfilled, but no selected route in this window reached its final U anchor. This evidence does not support saying that the model reached a fresh U target and then refused its exit. It does support a narrow integration gap: an omitted `explore` angle ignores available valid recorded-route hints and falls back to visit ranking. Explicit off-hint choices and look actions are separate model decisions.

## Candidate review only; no implementation

A bounded candidate can preserve current fresh-unexplored selection, then, when an omitted-angle `explore` has no available fresh U exit, select the first valid `recorded_directed_route` hint using this same indexed snapshot. Validate that its angle uniquely matches a current fresh exit, and retain the original ranking when no valid hint is available. The existing post-turn fresh-exit check and all movement/arrival/completion gates should remain unchanged. An explicit `exit_angle` must keep its existing semantics and must not be silently overridden.

Prompt guidance can ask the model to use a current valid route hint when no manipulation or recovery task takes priority, and to recheck on the next round. It must still permit stopping for fresh evidence, must not treat an empty hint list as done, and must not claim physical node identity or guaranteed U reduction. This targets the observed r118 omitted-angle gap; it does not establish a general convergence fix.
