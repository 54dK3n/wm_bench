# Next-round host I/O change

This is an authorized post-round change to `tools/inloop_driver.js` plus a new offline test `tools/tests/test_inloop_host_io.js`. No platform source, renderer/capture hook, simulation clock, physical parameter, robot program, vision budget or original round artifact was changed by this work. No simulation was started.

Reproduce checks:

```sh
node --check tools/inloop_driver.js
node --test tools/tests/test_inloop_host_io.js
```

The 19 tests pass; output is in `driver_host_io_tests.txt`. No new runtime dependency file was introduced. The new **JavaScript test file must be explicitly included in the next runner freeze**, because a Python-only test glob will not include it. Existing `vision_truth_hook.js` and `demo_keyframes_hook.js` remain the driver's existing dependencies.

## Log collection

Each status request reads the DOM text once and returns its new suffix in the same CDP reply. A driver-owned read cache compares the entire previous committed prefix. This is a read cache, not a platform output/renderer hook. Host persistence acknowledges a packet only after its file write succeeds. An unknown acknowledgement, reset/prefix change, or split UTF-16 surrogate pair causes a complete replacement. Failed writes leave the acknowledgement unchanged; partial append failures attempt to truncate back to the committed byte length, and file-size mismatches trigger complete repair from the host cache. Malformed packets produce explicit errors.

At the end, the original full DOM read still occurs. The complete result replaces the partial log and is compared byte-for-byte with the file. `hostIO.terminal.finalVerification` records whether the full read was available, whether it already matched the cached output, the reason for any reconciliation, final byte length and SHA256. If the full read fails, the cached fallback is retained and `allPass=false`; it cannot masquerade as a successful full read. A disk/readback failure also leaves an explicit error.

The preserved map-08 log contains **1,721,307 UTF-8 bytes / 12,348 parsed GY rows**. Offline replay in successive 4096-code-unit snapshots transferred and wrote exactly 1,721,307 suffix bytes, compared with **363,868,413 bytes** for transferring the entire text at every replay snapshot. The final text hash and serialized raw rows are identical. Printed negative-zero text is retained byte-for-byte; the raw JSON exporter naturally serializes JavaScript `-0` as `0`. This is a reproducible data-volume comparison under an artificial chunk schedule, **not measured live speedup**. CDP request-code overhead and protocol bytes are excluded from that replay comparison and separately measured in the next real run.

## Evidence export

The existing monitor's 500 ms interval remains. Native vision export is now checked on every status iteration, including iterations without new terminal text. PNG/query transfer retains the existing sequence cursors. Unchanged frames, queries, exact render truth and error history skip a manifest rewrite. A new query without a new frame, a changed truth entry, or a new error invalidates the signature. No frame is discarded. Demo keyframe metadata similarly skips writes when only the main-view render counter changes; the final forced write preserves its latest value.

Both manifests are force-written during finalization. Export exceptions remain in their histories and are also written immediately where disk access permits. In full-record mode (all next-round runs use `--demo-evidence 1`), a further host-only final check compares every exported native frame's metadata and PNG bytes with the native full record and verifies the complete query list. Failure adds an export error. This check reports byte completeness only: it never removes a historical timeout or turns `no_export_or_truth_errors` into PASS. The independent frozen report audit still checks exact render truth, all samples, native queries, source identity and every PNG.

## Measurements and limits

`raw.hostIO` includes:

- Per CDP operation label: request/response UTF-8 JSON payload bytes, call/response counts, host round-trip time and JSON parse time. These exclude websocket framing and are not pure network latency.
- Browser terminal-read/prefix-comparison milliseconds, suffix bytes received, terminal write calls/bytes/time, full fallback count and errors.
- Manifest writes/skipped-unchanged counts, serialized bytes and write time, plus historical evaluate timeouts. File-write totals explicitly exclude PNG/full-record writes.
- Final terminal and native archive byte-verification results.

Resolved evaluate timeout timers are cleared; timeout durations and stall/deadline decisions are unchanged. The driver still reads a complete DOM string and compares its prefix inside the browser, and still transfers the full truth ledger on each evidence check. Platform `textContent +=`/layout costs are untouched. These remaining costs can still dominate; the metrics are intended to establish their effect before further work. Reducing host work may change wall-time render scheduling, so screenshot `tickDelta` remains measured rather than assumed identical.
