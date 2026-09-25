# Driver v5: bounded evaluator export

The driver now stores the stop result in an evaluator-only page job and returns only a small status acknowledgement. It then streams `record`, `samples`, `sensorAudit`, `captures` and `envelope` through bounded CDP replies. This removes the previous whole-record `returnByValue` and host-side whole-record `JSON.stringify` operations. It does not change the platform, brain, action policy, observations, simulator or model settings.

The platform's existing `RobotBackend.stop()` still performs internal copies in recorder finish, bridge-call attachment, sensor-audit cloning and its returned clone. Those copies may still cause memory pressure or take time. The Run11 timeout alone does not prove which stage failed; this patch does not claim a transport-only diagnosis. Missing Run11 evidence is not reconstructed or fabricated.

## Export behavior

`installChunkedEvaluationExport` is installed only after the child brain exits. Its stop job runs once. Status calls return phase/error and small counts; truth exports and the page facilities are never added to the child's capability or robot whitelist.

The page traverses JSON object fields and array elements lazily. Each reply contains at most 65,536 UTF-16 code units plus a small protocol envelope; JSON escaping can increase wire bytes by a bounded factor. Large scalar fields are sliced across replies. A Unicode surrogate pair is never split between host UTF-8 writes. Field order, values and standard two-space JSON encoding plus the final newline are preserved. Non-JSON values and serialization failures remain errors rather than being silently dropped.

The host verifies dataset, sequence, cumulative character count and a terminal `done` marker. A CDP timeout can re-request the same chunk once; the page retains that response so an uncertain transport failure cannot skip or duplicate bytes. This retries only cached evaluator transport, never backend stop, robot actions or model requests. Permanent serialization/protocol failures are not retried. Stop has its existing configured timeout; export has a ten-minute overall deadline and a 100,000-chunk cap per dataset.

The host compresses incrementally and calculates SHA256 for compressed bytes and expanded JSON bytes. Complete datasets are renamed from `.part`; each one is recorded immediately in `evidence.json`. `record.json.gz`, `samples.json.gz`, `sensor-audit.json.gz` and `captures.json.gz` retain their original schemas. `envelope.json` remains plain JSON and its metadata explicitly says `compression: none`; consumers must honor that field rather than decompressing every evidence entry as gzip.

On failure, already completed datasets remain saved and the exporter attempts the other independent datasets within the shared deadline. A successfully finalized partial gzip preserves the exact received JSON prefix, its hashes and a `complete: false` status. An I/O failure that prevents gzip finalization reports accepted byte counts separately without claiming a valid expanded-byte hash. A metadata-write failure after file rename preserves the published payload's correct filename/hash and the original error. Existing complete files, `.part` files and progress files are never overwritten by a new export attempt.

`export-status.json` names completed datasets, failures and retained partial evidence. Main marks incomplete export as a failed trial, aborts later trials, and retains the temporary browser/server directory instead of removing it. Retaining that directory is not a claim that lost JavaScript heap data can be recovered after browser shutdown. The independently available camera captures can still be saved when stop fails.

The truth judge runs against the finished record in the evaluator page and returns only its judgement result. The host no longer loads the entire large record merely to calculate that judgement. Record persistence must succeed before a normal trial verdict is accepted.

## Validation and scope

`node --test tools/tests/test_autonomous_brain_export.js tools/tests/test_autonomous_brain_config.js` passed **13/13**, exit **0**, duration **1848.45275 ms**. Exact output is in `final-node-tests-v2.txt`; prior development-pass logs remain separate. `node --check tools/autonomous_brain_driver.js` and reverse application check of `driver-export.patch` also passed.

The fake-CDP test imposes a 1 MiB reply limit: the old whole-result call fails, while the new chunk path preserves the exact expected JSON bytes and all hashes for large arrays and scalar fields. Further tests exercise two-character Unicode boundaries, escaped controls, timeout response loss after the page advances, permanent failures, sequence/character/endcap mismatches, absent final endcap, stop failure, deadlines, no-overwrite behavior and metadata failure after rename. These tests do not access the simulator, real model, credentials or an environment file.

An independent read-only review found the post-rename metadata failure path could finalize a hash twice. That branch was corrected and is covered by the final regression. No additional helper source file was introduced: all exporter code is in the driver and is covered by its existing before/after SHA manifest.

Real-browser short and large-volume no-model tests are coordinated by the parent task after this source freeze. Their results are separate evidence; this implementation report does not claim they have passed, and does not claim recovery or success for Run11.

Changed files are `tools/autonomous_brain_driver.js`, `tools/tests/test_autonomous_brain_config.js` (version expectation only), and new `tools/tests/test_autonomous_brain_export.js`. Before/after source hashes and the applicable patch are in this directory. All report paths are repository-relative.
