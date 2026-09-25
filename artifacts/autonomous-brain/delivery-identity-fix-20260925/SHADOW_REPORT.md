# Isolated delivery identity fix

Status: prepared and tested in the separate copy referenced by `shadow-manifest.json`. **Not applied to the live package.** Candidate versions are perception v5 and actions v10. The live actions/perception hashes still match the frozen source recorded in the manifest.

## Defect and correction

The original synthetic integration test executes real `Actions.place` and real `Perception` against declared public bounding boxes. Release and retreat observations create a new eligible red track before delivery marks the held ID. The held ID becomes DELIVERED while the new ID remains TENTATIVE, then LOST; subsequent delivery-position matching suppresses detections without removing this duplicate pending task identity. The baseline has 4 failures and 1 passing nearby-object safety control; see `synthetic-proof-before.json` and `tests-before.log`.

The candidate sends the unique witness track ID, category, current frame and public geometry together with the actual post-release observation boundary and same-class IDs known before release. Perception validates the current frame/time, exact category/position/bbox, the unique current pixel witness using the existing containment function, and track creation at or after the release observation and timestamp. The observation-order check also rejects an older track born at the same simulation time. A stale or mismatched witness, preexisting identity, or ambiguous observation causes no delivery mutation.

Only the exact verified witness is archived as an alias of the held identity. Both raw timelines and accepted observation poses remain, with explicit alias evidence and the canonical delivery's witness ID. `get_object` can still inspect the alias. `objects` avoids counting this verified alias a second time; unrelated LOST objects remain visible and pending. No proximity-wide suppression, perception/association threshold change, or completion-gate change is included.

The actions change consists of a version bump and the release/witness evidence payload. The source patch also rejects reuse of an already-seen perception frame ID, so the release-order record cannot be overwritten by a repeated ID.

## Validation

`tests-shadow-final.log`: **94 passed in 0.34s, exit 0; zero network calls.** Seven copied test files cover delivery identity, existing perception, actions, navigation regressions, route progress, visual standoff and road clearance. The runner asserts that both loaded modules come from the isolated copy. Its exact command is in `shadow-test-command.json`.

Identity tests cover the original duplicate and completion failures, two nearby legitimate preexisting red balls, stale/current-frame mismatches, wrong track/category/position/bbox, forged preexisting lists, same-time earlier birth frames, multiple new witnesses, a falsely claimed unique witness count, raw timeline retention and rejected repeated binding.

Old successful mark_delivered fixtures previously supplied an invented placement without a current sensor frame. Their copied versions now create authentic current public ball/storage detections and release metadata. Existing 14cm/16cm exclusion-boundary and multiple-ball checks retain their thresholds and assertions; ball counts explicitly exclude the newly required storage witness track.

An independent read-only review found no concrete regression in this scoped change. Both patch dry-run checks passed. Full source/test SHA256 values, patch hashes, exit code and unchanged-live-source checks are in `validation-shadow-final.json`.

## Reviewable patches

- `delivery-identity-source.patch`: only `autonomous_brain/perception.py` and `autonomous_brain/actions.py`.
- `delivery-identity-tests.patch`: copied perception fixture updates and the expanded delivery identity regressions.

These patches are prepared for a later authorized freeze change. This offline synthetic validation neither establishes that the active run has triggered the defect nor changes any live run result.
