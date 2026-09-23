"use strict";
// Offline only: no main(), browser, server, native render or simulation.
// node --test tools/tests/test_inloop_host_io.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { terminalDelta, persistTerminalDelta, verifyNativeExport,
  visionManifestSignature, demoManifestSignature } = require("../inloop_driver.js");
const ROOT = path.resolve(__dirname, "../..");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-host-io-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = vm.createContext({cache: {}});
  vm.runInContext(`globalThis.delta = ${terminalDelta.toString()}`, ctx);
  const state = {text: "", ackId: 0}, metrics = {writeCalls: 0, writtenBytes: 0, writeMs: 0,
    receivedSuffixBytes: 0, fullFallbacks: 0};
  const filename = path.join(dir, "output.txt");
  function read(text) {
    return JSON.parse(JSON.stringify(ctx.delta(text, {ackId: state.ackId, cursor: state.text.length}, ctx.cache)));
  }
  function accept(packet) { persistTerminalDelta(filename, state, packet, metrics); }
  function update(text) { const packet = read(text); accept(packet);
    assert.deepEqual(fs.readFileSync(filename), Buffer.from(text, "utf8")); return packet; }
  return {ctx, state, metrics, filename, dir, read, accept, update};
}

test("append-only suffix equals complete UTF-8 logs including Chinese and emoji", t => {
  const r = rig(t);
  for (const s of ["", "GY {\"event\":\"你好😀\"}\n", "GY {\"event\":\"你好😀\"}\n第二行\r\n"])
    assert.equal(r.update(s).mode, "append");
  assert.equal(r.metrics.receivedSuffixBytes, Buffer.byteLength(r.state.text));
});

test("same-length prefix changes and shorter resets require full replacement", t => {
  const r = rig(t);r.update("abcXYZ");
  assert.equal(r.update("abdXYZ").reason, "reset_or_prefix_changed");
  assert.equal(r.update("a").mode, "full");
});

test("changes at the start cannot evade a suffix-only sentinel", t => {
  const r = rig(t);r.update("A"+"z".repeat(1000));
  assert.equal(r.update("B"+"z".repeat(1000)+"new").mode, "full");
});

test("unknown browser read cache requires full fallback", t => {
  const r = rig(t);r.update("committed");r.ctx.cache = {};
  assert.equal(r.update("committed suffix").reason, "unknown_ack");
});

test("split UTF-16 surrogate pair replaces old UTF-8 replacement bytes", t => {
  const r = rig(t);r.update("before\uD83D");
  assert.equal(r.update("before\uD83D\uDE00after").reason, "unicode_boundary");
});

test("unacknowledged packet/read timeout cannot omit its bytes on next read", t => {
  const r = rig(t);r.update("old");r.read("old lost reply");
  const packet = r.update("old lost reply and next");
  assert.equal(packet.data, " lost reply and next");
});

test("failed write does not commit cursor and retry preserves full bytes", t => {
  const r = rig(t);r.update("old");const ack = r.state.ackId;
  fs.unlinkSync(r.filename);fs.mkdirSync(r.filename);
  assert.throws(() => r.accept(r.read("old new")));
  assert.equal(r.state.ackId, ack);assert.equal(r.state.text, "old");
  fs.rmdirSync(r.filename);r.update("old new plus");
});

test("missing/truncated output file recovers from host cache without dropped bytes", t => {
  const r = rig(t);r.update("old");fs.truncateSync(r.filename, 1);
  r.update("old suffix");
});

test("unknown packet mode and wrong acknowledgement are explicit errors", t => {
  const r = rig(t);const p = r.read("hello");
  assert.throws(() => r.accept({...p, mode:"unknown"}));
  assert.throws(() => r.accept({...p, baseId:123}));
  r.accept(p);assert.equal(r.state.text,"hello");
});

test("empty updates avoid file rewrite; forced final read supports complete byte check", t => {
  const r = rig(t);r.update("hello");const writes = r.metrics.writeCalls;
  for (let i=0;i<10;i++)r.update("hello");
  assert.equal(r.metrics.writeCalls,writes);
  const p = r.read("hello unseen final line");r.accept({...p,mode:"full",data:"hello unseen final line"});
  assert.equal(sha(fs.readFileSync(r.filename)),sha(Buffer.from("hello unseen final line")));
});

test("real map08 1.7M-character log replay preserves all raw JSON lines", t => {
  const r = rig(t);
  const base = path.join(ROOT,"artifacts/inloop/opt-2/round-1");
  const text = fs.readFileSync(path.join(base,"map-08.partial.txt"),"utf8");
  let oldFullTransferBytes = 0;
  for (let end=4096;end<text.length;end+=4096) {
    const current=text.slice(0,end);r.update(current);oldFullTransferBytes+=Buffer.byteLength(current);
  }
  r.update(text);oldFullTransferBytes+=Buffer.byteLength(text);
  const parsed=r.state.text.split("\n").filter(s=>s.startsWith("GY ")).map(s=>JSON.parse(s.slice(3)));
  // The raw exporter uses JSON.stringify: JavaScript's -0 becomes JSON 0.
  // Original text bytes (including any printed -0.0) are checked separately.
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)),JSON.parse(fs.readFileSync(path.join(base,"map-08.json"),"utf8")).lines);
  assert.ok(r.metrics.receivedSuffixBytes < oldFullTransferBytes/100);
  assert.equal(sha(fs.readFileSync(r.filename)),sha(Buffer.from(text)));
  console.log(JSON.stringify({offlineLogReplay:{utf8Bytes:Buffer.byteLength(text),rows:parsed.length,
    suffixUtf8Bytes:r.metrics.receivedSuffixBytes,oldFullTransferUtf8Bytes:oldFullTransferBytes,
    persistedUtf8Bytes:r.metrics.writtenBytes,writeMs:r.metrics.writeMs,
    caveat:"offline chunk schedule, not a live wall-time speedup measurement"}}));
});

test("vision signature reacts to frame/query/truth/error changes and retains historical errors", () => {
  const e={runId:"r",taskId:"task",frameCount:1,frameBytes:42,queryCount:1,renderTruth:{frames:[{tick:3}],errors:[]}};
  const original=visionManifestSignature(e,[]);
  assert.equal(original,visionManifestSignature(structuredClone(e),[]));
  for(const patch of [{runId:"other"},{frameCount:2},{frameBytes:43},{queryCount:2},
    {renderTruth:{frames:[{tick:4}],errors:[]}},{renderTruth:{frames:[{tick:3}],errors:["truth-error"]}}])
    assert.notEqual(original,visionManifestSignature({...e,...patch},[]));
  const error=[{message:"timeout"}];assert.notEqual(original,visionManifestSignature(e,error));
  assert.deepEqual(error,[{message:"timeout"}]);
});

test("demo renderCount-only changes can skip rewrite; new PNG/error/native bytes cannot", () => {
  const e={runId:"r",taskId:"t",errors:[],screenshotBytes:40,renderCount:1};
  const original=demoManifestSignature(e,100,[]);
  assert.equal(original,demoManifestSignature({...e,renderCount:999},100,[]));
  assert.notEqual(original,demoManifestSignature({...e,screenshotBytes:80},100,[]));
  assert.notEqual(original,demoManifestSignature({...e,errors:["capture"]},100,[]));
  assert.notEqual(original,demoManifestSignature(e,101,[]));
  assert.notEqual(original,demoManifestSignature(e,100,["export"]));
});

function archive(t) {
  const r=rig(t),bytes=Buffer.from("native-png-test-bytes"),digest=sha(bytes);
  fs.writeFileSync(path.join(r.dir,"one.png"),bytes);
  const frame={evidenceId:"e",frameId:1,seq:4,tick:12,stateRevision:3,byteLength:bytes.length,sha256:digest};
  const query={type:"vision_query",seq:5,tick:12,evidenceId:"e",frameId:1};
  return {record:{runId:"r",visionFrames:[{...frame,pngBase64:bytes.toString("base64")}],inputs:[query]},
    exported:{runId:"r",frames:[{...frame,image:"one.png",exportedSha256:digest}],queries:[query],exportErrors:[{message:"old timeout"}]},
    filename:path.join(r.dir,"manifest.json"),dir:r.dir};
}

test("final native verification checks bytes and queries but never erases historical error", t => {
  const a=archive(t);assert.equal(verifyNativeExport(a.record,a.exported,a.filename).allPass,true);
  assert.deepEqual(a.exported.exportErrors,[{message:"old timeout"}]);
});

for (const kind of ["png", "metadata", "query", "inventory"]) test(`final archive rejects ${kind} mismatch`, t => {
  const a=archive(t);
  if(kind==="png")fs.appendFileSync(path.join(a.dir,"one.png"),"bad");
  if(kind==="metadata")a.exported.frames[0].tick++;
  if(kind==="query")a.exported.queries=[];
  if(kind==="inventory")a.exported.frames=[];
  assert.throws(()=>verifyNativeExport(a.record,a.exported,a.filename));
});

test("preserved real map08 native archive validates without modifying its historical timeout", () => {
  const raw=JSON.parse(fs.readFileSync(path.join(ROOT,"artifacts/inloop/opt-2/round-1/map-08.json"),"utf8"));
  const record=JSON.parse(fs.readFileSync(raw.fullRecordFile,"utf8"));
  const bytes=fs.readFileSync(raw.visionEvidenceFile),exported=JSON.parse(bytes);
  assert.equal(exported.exportErrors.length,1);
  const result=verifyNativeExport(record,exported,raw.visionEvidenceFile);
  assert.equal(result.frames,61);assert.equal(result.queries,62);assert.equal(result.pngBytes,15037811);
  assert.equal(sha(fs.readFileSync(raw.visionEvidenceFile)),sha(bytes));
  assert.equal(exported.exportErrors.length,1);
});
