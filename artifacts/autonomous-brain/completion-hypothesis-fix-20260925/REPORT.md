# Archived unconfirmed hypotheses: offline candidate

This candidate fixes a completion-state deadlock using only public observation history. It was developed in an isolated temporary checkout (`wm-completion-shadow-0tmdhfxm`), copied from frozen commit `27d3a4eb3eed854d8101c837bbaf3aafa2e09f18`. No main-package source, live-run evidence, simulator state, layout, truth, credentials or environment file was edited or consumed by this work. The parent independently changed main `actions.py` navigation after run10 finished; that change is recorded separately in the final manifest.

This is an offline candidate, not a successful simulation or a change to any run verdict. The synthetic fixtures establish a reachable controller state and its transition rules; they do not assert the number or identity of physical balls.

## Minimal change

`Perception.objects()` retains every historical LOST row. A red row gains the read-only classification `retired_unconfirmed_hypothesis` only when the exact track is in the WM archive, its recorded `confirmed_s` is explicitly null, its first observation frame is known and nonempty, and it has no manipulation lifecycle. Evidence retains first/last observation times and frames, archive update time, confidence and hit count. The historical state stays LOST: no DELIVERED assignment, identity merge, location suppression or threshold change is made.

All active TENTATIVE/STALE/CONFIRMED rows, ever-confirmed LOST rows, HELD and RELEASED_UNVERIFIED identities remain pending. Missing confirmation or first-frame history also remains pending. A later valid detection at the same or nearby observed position still enters the unchanged perception pipeline as a new pending identity.

The pure `completion_evidence()` query is shared by `done()` and `Runtime.state()`. Both expose pending IDs and explicit retirement evidence; the recent action summary preserves the same whitelisted basis. The gripper and road-exploration gates are unchanged. A retired hypothesis means an uncertain archived memory no longer blocks completion; it does not establish delivery or nonexistence. The candidate prompt explains that distinction without selecting actions for the model.

Versions are Perception v6, Runtime v6 and LLM v10. The isolated Actions source is v13; its completion helper/done patch is separate from the version hunk so the parent's independent navigation v13 changes can be retained. Historical v1–v9 LLM records retain their original prompts, requests and record fields.

## Evidence

| Check | Result | Evidence |
|---|---|---|
| New regression against frozen code | 18 failed, 1 passed; exit 1 | `baseline-tests.txt` |
| Same scoped baseline, unchanged package | 18 failed, 250 passed; exit 1 | `baseline-scoped-tests.txt` |
| Initial candidate regression | 19 passed; exit 0 | `shadow-completion-tests.txt` |
| Initial candidate scoped tests | 268 passed; exit 0 | `shadow-scoped-tests.txt` |
| Final regression including incomplete-history cases | 22 passed; exit 0 | `final-completion-tests.txt` |
| Final scoped perception, identity, actions, state and LLM tests | 271 passed; exit 0 | `final-scoped-tests.txt` |
| Real saved v9 model transcript | 77/77 rounds, 89/89 calls; exit 0 | `v9-offline-replay/checks.json` |

The 18 initial failures reflect missing classification/evidence and the proved completion deadlock. Original guards and tracking tests pass in both scoped runs. The final regressions explicitly cover active unconfirmed STALE, ever-confirmed LOST, held/unverified, new nearby detections, a real current-pixel delivery witness alongside retired history, unchanged timeline/track storage, detached query output, empty gripper and explored-road gates. The independent review additionally found incomplete first-frame metadata could raise an exception; the final candidate treats missing, null and empty first-frame values as pending. Initial patches/hashes remain under `initial-candidate/`.

The saved run09 transcript was replayed with the candidate v10 client using only `brain/rounds.jsonl` and `brain/llm.jsonl`. All records were exhausted and remained identical except `mode`; network, environment and sleep attempts were zero. The source logs' SHA256 stayed unchanged. No actions or simulator were replayed, and run09's result is not reinterpreted.

Exact test/replay commands, exit codes and output filenames are in `validation.json`. Commands and diagnostic path spellings are repository-relative; only path spellings in test output were normalized. No full repository suite was run. Tests blocked socket connections and used fake LLM transports/credentials; actual-model requests were never made.

## Applying after review

Use `actions-completion.patch`, `perception.patch`, `run.patch`, `llm.patch` and `tests.patch`. Their combined `git apply --check` passed against the parent's current navigation-v13 working tree; no patch was applied by this task. Skip `actions-version.patch` when Actions is already v13. `source-frozen-baseline.patch` is the full source-only patch for the original v12 frozen baseline and is provided for audit, not to replace the parent's newer Actions source.

`manifest-before.json` records frozen source SHA256. `manifest-after.json` records final candidate source/test/patch hashes and main-package comparisons. Main Perception/Runtime/LLM remain byte-identical to the frozen source at handoff. Parent integration and a new real run remain separate validation steps.

Publication path normalization: the patch argument in both validation manifests is written relative to this repository; the isolated checkout name is retained without an absolute location. Test results and source/patch bytes are unchanged.
