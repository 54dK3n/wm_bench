# Round 1 archive and host-time diagnosis

Read-only post-round analysis. No simulation, re-export, source change, or original artifact overwrite. Reproduce from the workspace with `PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-1/evidence-diagnosis/reproduce.py`. The output `evidence_diagnosis.json` contains every check, frame binding, input SHA256, ending and relevant timing gap. All 438 read inputs were unchanged after the audit.

## map-08: complete evidence, historical export timeout remains a failed gate

The frozen `audit_native_evidence` returns 23/24 checks true. Its only mismatch is `no_export_or_truth_errors`. At **2026-09-23T17:18:46.562Z**, the driver recorded **`Runtime.evaluate timeout after 120000 ms`** in `attempt-022.vision.json.exportErrors`, mirrored in the raw archive. This is a failed host CDP read during incremental export, not a native camera failure or a truth-capture error. `renderTruth.errors` is empty. The exact slow operation inside the page has not been profiled; the timeout alone cannot identify it.

The final archive contains **61 native PNGs, 62 native vision queries (59 observe), and 15,037,811 image bytes**. Every PNG is byte-identical to the full record's base64 payload, with matching hash, metadata, evidence/frame ID, tick, state revision and exact render truth. All raw observe detections match their corresponding native query; all samples match the full record. The full record itself matches the recorded byte length and SHA256. Two success screenshots are also exported (347,949 bytes); the driver records no demo hook/export errors and no missing success screenshot. Native bytes remain below 20 MiB.

**There is nothing missing to fill from the existing archive.** The final successful export already recovered the delayed data without another simulation. The export path uses `seq` cursors and retries on subsequent output changes and once at the end (`tools/inloop_driver.js:236–237`, `:258–263`, `:458`, `:564`). A timeout is retained as history (`:295–302`); this history cannot honestly be removed. The frozen evidence gate therefore remains **FAIL**. An additional report may distinguish “complete recovered data” from “zero export errors”; it must not rewrite the frozen gate or original raw file.

## All ten runs ended through program completion

| Layout | Driver wall seconds | Native simulation seconds | Final program stage | Native evidence gate |
|---|---:|---:|---|---|
| map-01 | 78.710 | 63.2 | delivery failed | PASS |
| map-02 | 568.272 | 322.4 | navigation query budget exhausted | PASS |
| map-03 | 79.222 | 63.2 | delivery failed | PASS |
| map-04 | 633.503 | 434.3 | navigation query budget exhausted | PASS |
| map-05 | 367.261 | 313.7 | two-ball delivery succeeded | PASS |
| map-06 | 854.563 | 510.6 | confirmation failed | PASS |
| map-07 | 565.341 | 298.8 | confirmation failed | PASS |
| map-08 | 873.819 | 379.9 | confirmation failed | FAIL: historical export timeout |
| map-09 | 285.560 | 259.6 | navigation query budget exhausted | PASS |
| map-10 | 366.101 | 327.4 | two-ball delivery succeeded | PASS |

All ten have `timedOut=false`, `stallReason=null`, and a native `run_finished` event with reason `program_finished`. None was stopped by the driver's deadline or stall branch. The audit verifies **381 native PNGs / 92,426,537 bytes** across all layouts. The 20 MiB cap applies per run, not to this sum.

For map-08, final tick **18995** is present in the last observe, `flow_end`, full-record end and native result. `flow_end` reports ball 2 confirmation failure, one delivery, **862 navigation queries / 174 controls**, and no holding. The driver wall time is **873.819 s**; the batch/driver default timeout is **900 s** (`tools/run_opt2_batch.py:284`, `tools/inloop_driver.js:21`). The driver starts that deadline after the run-button click, while its wall duration begins before that click (`:417–418`, `:445`), so their origins are slightly different. The raw file does not separately store the passed timeout argument. Regardless of the exact configured deadline, its explicit flags and native termination prove this run did not take the deadline/stop path.

The driver measures `wallSeconds` before final sample/full-record export (`:484`, `:540–578`). Browser setup is included in raw `startedAt`/`finishedAt` duration but excluded from `wallSeconds`. A long final record serialization cannot explain the measured in-run wall gap.

## Source-supported host overhead; not a timing profile

- Every half-second status poll obtains the whole terminal text within the page, counts it and searches for DONE (`tools/inloop_driver.js:423–438`). Each output change then transfers the whole string again and rewrites the entire partial log (`:455–458`). Original logs must remain complete, but their collection can use append-only suffixes, a committed cursor and a final whole-log equality check in a future version.
- PNG transfer already uses incremental frame/query sequences. However, each export rescans native inputs/frames, returns the full truth ledger, rebuilds every binding and rewrites the full JSON manifest (`:223–294`). Even unchanged demo exports rewrite metadata (`:311–350`). Future cursor-based metadata collection and skipping unchanged manifest writes can preserve all evidence.
- Platform `app.js:12539–12542` performs `textContent += text` and reads `scrollHeight` for every Python output chunk; `:12741–12744` also refreshes the Python watchdog. Together with wrapped text in `styles.css:958–965`, the growing terminal can cause repeated string copies and layout. A future pure UI optimization must preserve all text, watchdog refreshes, rendering/keyframe attribution and robot messages; it requires an equivalence check. It must not change simulation time, physics or native evidence budget.
- map-08's sampled output grows to **1,720,003 UTF-16 code units**. The largest timeline gap is **160 wall seconds** (245→405), while simulation advances only **9.3 seconds** (tick 11011→11476); the export timeout falls in this gap. The next output snapshot jumps from 242,587 to 990,536 code units. These observations support investigating host log/export load, but do not quantify each cause or prove that log work alone caused the timeout.

These are recommendations for a later authorized revision. No optimization has been applied to this round, and no guarantee of identical wall-time render scheduling is claimed.
