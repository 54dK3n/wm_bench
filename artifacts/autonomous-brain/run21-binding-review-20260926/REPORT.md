# Run21 temporal binding diagnosis

Run21's original verdict remains **FAIL**. This supplement explains how later identity ambiguity affects the full-run report. It does not rewrite the original report, change any geometry rule, declare autonomous completion, or rerun the model or simulator.

The frozen evaluator is `autonomous-brain-offline-evaluation/v4`, SHA-256 `69e4f719afb536af72b55feb0c42835106c633c0491d4725fd9ed549965dccd7`. `evaluator_v4.py.txt` is an exact source snapshot. The diagnostic first reproduces the original global `perception` and `judge` objects **field for field**. All nine original inputs have unchanged SHA-256 before and after. The record's native samples also exactly equal the separate samples export.

## Reproduce

From the repository root:

```text
python3 artifacts/autonomous-brain/run21-binding-review-20260926/diagnose.py
```

The script refuses to overwrite an existing `diagnostic-v1.json`. To independently reproduce, use a separate copy of this diagnostic directory without that generated output. It derives eligible actions and track IDs from the saved actions rather than hard-coding rounds or identities. `input-sha256.json` identifies the original inputs; `execution-v1.json` and the original stdout/stderr record exit code 0. `diagnostic-v1.json` contains complete binding histories, conflict frames, five action windows, exact-tick native endpoints and events, and position-error samples.

## Original global result, unchanged

The original Judge has 5 eligible actions: 2 matches, 3 unverifiable, no false-positive or false-negative judgments. The global WM position metric has 29 valid samples, mean 7.388059 cm, RMSE 7.407041 cm and maximum 8.246669 cm. Its 71 excluded CONFIRMED observations comprise 69 with ambiguous track identity and 2 with no active same-frame truth. An excluded observation is not a zero-error sample.

The full-run binding rule makes `target_021` ambiguous between the two physical targets; `target_140` also has a later mixed identity. Therefore the original report's first-target `first_confirmed` is null. This means a globally consistent identity was unavailable under that rule, not that no earlier confirmed state was logged.

## Five complete action prefixes

For each action, the unchanged `evaluate_perception` is rerun over **every observation from 1 through the action's final observation**, including all inconvenient or conflicting frames within that prefix. Its resulting bindings are passed to unchanged `evaluate_judge`, with the same full native record and all prefix motions. No identity is assigned by nearest distance, and no frame is deleted selectively.

| Round/action | Track | Complete observation prefix | Original global Judge | Diagnostic prefix Judge |
|---|---|---|---|---|
|25 pick|target_021|1–145|Unverifiable: ambiguous identity|Match: independent success true|
|45 place|target_021|1–290|Unverifiable: ambiguous identity|Unverifiable: no release motion in action window|
|53 place|target_021|1–353|Unverifiable: ambiguous identity|Match: independent success true|
|97 pick|target_112|1–631|Match|Match: independent success true|
|99 place|target_112|1–661|Match|Match: independent success true|

The r45 action reported failure before any release because no usable complete storage region was available. Although its target identity resolves in the declared prefix, the original Judge requires an actuator motion to judge a release. That missing evidence stays missing. The supplement therefore yields **4 matches and 1 unverifiable**, only within these declared diagnostic scopes; it does not replace the formal global 2/3 result.

## Exact source of later ambiguity

`target_021` has 67 unique geometric associations with physical target 1 and one with physical target 2. The first conflicting association is r99 obs659, tick25867, 517.34 s, after the second ball's release. Its sole red box is `(146,266,342,214)`; the unchanged projected-centre check uniquely associates that box with target 2. The public converted row nevertheless has `track_id=target_021` and `known_delivered_object_id=target_021`, `fed_to_world_model=false`, and reason `matches_verified_placement`. Its reported distance to the old delivered memory is 0.0575194015 m. The old verified-placement association therefore adds a second identity to the first ball's global track binding.

This conflict occurs well after the first ball's pick/place windows. It remains included in the full-run evaluator and in r99's complete prefix. It does not make `target_112` ambiguous, so r99's selected-track Judge remains verifiable.

`target_140` independently has nine geometric associations with target 2 and one with target 1. Its conflicting frame is r123 obs805, 626.08 s. It is included in the diagnostic's full binding history and conflict evidence, but it is not a selected pick/place track. Neither conflict is repaired or suppressed here.

## Per-ball times

All values below are simulation seconds. “Raw seen” is the original evaluator's first uniquely matched raw box. The diagnostic confirmation is the first CONFIRMED observation whose same-frame geometric associations accumulated **up to that observation** identify exactly one target; future associations are not borrowed. Grab and delivery use native events, separate from the later memory verification times.

| Physical target | First raw seen | Diagnostic causal confirmation | First accepted grab event | First delivery event |
|---|---|---|---|---|
|1|2.76, r2 obs5|49.46, r12 obs72, target_021|104.30, tick5215|281.32, tick14066|
|2|97.20, r23 obs128|464.52, r93 obs596, target_112|482.44, tick24122|516.92, tick25846|

The original global first confirmation remains null for target 1 and 464.52 s for target 2. The action tracks' own memory timelines are also preserved: target_021 first presence22.14, confirmation49.46, picked107.78 and delivered284.42 s; target_112 first presence421.74, confirmation464.52, picked485.92 and delivered520.02 s. These memory verification times should not be confused with the earlier physical grab/delivery event times. Neither target has a delivery revocation in the evaluator timeline.

## Position error before the earliest conflict

The explicitly declared continuous prefix ends at obs658, immediately before the earliest mixed-identity association. Reusing the unchanged v4 geometry and coordinate transform gives 96 valid CONFIRMED action-track samples: mean **9.037708 cm**, RMSE **9.260535 cm**, maximum **12.479048 cm**. Target_021 contributes67 valid samples (mean9.751735, RMSE9.956365, maximum12.479048 cm); target_112 contributes29 (mean7.388059, RMSE7.407041, maximum8.246669 cm).

Four additional CONFIRMED samples remain excluded because there is no active same-frame truth: target_021 at obs139/140 and target_112 at obs625/626. They are retained with their reasons, not converted to valid or zero-error samples. This prefix metric explains the earlier estimates under their then-consistent binding; it is not substituted for the original global 29-sample metric.

Projected-centre correspondence still does not independently prove visibility through occlusion. These temporal checks address identity aggregation and action evidence only. Run21 stopped on LLM quota errors, made no autonomous `done` call, and retains its original FAIL and original failure list.
