"use strict";

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {gunzipSync} = require('node:zlib');
const {stopForChunkedExport, savePageDataset, persistPageExport} = require('../autonomous_brain_driver.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixtures(large = false) {
  const text = '中文🌍🧪 quote" slash\\ newline\n control\u0001 '.repeat(large ? 22000 : 4);
  return {exported: {record: {schemaVersion: 'guangyang.robot-record/v1', complete: true,
    clock: {stepMs: 20}, native: {samples: Array.from({length: large ? 700 : 2}, (_, i) => ({tick: i,
      holding: null, packages: [{id: '球🌍-' + i, x: i / 7, z: -i / 3}]})),
      visionFrames: [{frameId: 1, data: text}], events: [], simulationEndTick: 699},
    calls: [{result: {'data key🌍': text}}], ledger: [], bridgeCalls: []},
    sensorAudit: [{frameId: 1, text}], envelope: {controllerErrors: [], metadata: {text}}},
    captures: [{frameId: 1, note: '真实字符🌍\n\u0000', emptyArray: [], emptyObject: {}}]};
}

function page(data, stopError, maxReplyCharacters = Infinity) {
  let stops = 0;
  const requests = [], responses = [];
  const context = vm.createContext({__brainEvaluationCaptures: data.captures,
    RobotBackend: {stop: async reason => {
      stops++; assert.equal(reason, 'finished');
      if (stopError === 'pending') return new Promise(() => {});
      if (stopError) throw stopError;
      return data.exported;
    }}});
  const evaluate = async expression => {
    requests.push(expression);
    const value = await vm.runInContext(expression, context);
    // Model CDP's JSON crossing; never pass a live page object to the host.
    const serialized = JSON.stringify(value);
    responses.push(serialized.length);
    if (serialized.length > maxReplyCharacters) throw Object.assign(new Error('CDP reply exceeds fake bounded transport'), {code: 'CDP_TIMEOUT'});
    return JSON.parse(serialized);
  };
  return {evaluate, requests, responses, stops: () => stops};
}

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-export-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function verify(file, metadata, expected) {
  const packed = fs.readFileSync(file);
  const bytes = metadata.compression === 'gzip' ? gunzipSync(packed) : packed;
  const original = Buffer.from(JSON.stringify(expected, null, 2) + '\n');
  assert.deepEqual(bytes, original, 'UTF-8 document must be exactly the original JSON encoding');
  assert.deepEqual(JSON.parse(bytes), JSON.parse(JSON.stringify(expected)));
  assert.equal(metadata.sha256, sha(packed)); assert.equal(metadata.bytes, packed.length);
  assert.equal(metadata.expandedSha256, sha(original)); assert.equal(metadata.expandedBytes, original.length);
}

test('large arrays and scalar fields cross CDP only in bounded chunks and keep exact JSON/SHA', async t => {
  const dir = directory(t), data = fixtures(true), fake = page(data, null, 1024 * 1024);
  const unbounded = page(data, null, 1024 * 1024);
  await assert.rejects(unbounded.evaluate("RobotBackend.stop('finished')"), /exceeds fake bounded transport/);
  const ready = await stopForChunkedExport(fake.evaluate);
  assert.equal(ready.phase, 'ready'); assert.equal(ready.recordFrameCount, 1);
  await fake.evaluate('__brainChunkedExport.start()');
  assert.equal(fake.stops(), 1, 'small status/start calls never repeat backend stop');
  const result = await persistPageExport(fake.evaluate, dir);
  assert.equal(result.complete, true);
  assert.deepEqual(result.failures, []);
  for (const [name, expected] of Object.entries({record: data.exported.record,
    samples: data.exported.record.native.samples, sensorAudit: data.exported.sensorAudit,
    captures: data.captures, envelope: data.exported.envelope})) {
    verify(path.join(dir, result.evidence[name].file), result.evidence[name], expected);
    assert.equal(fs.existsSync(path.join(dir, result.evidence[name].file + '.part')), false);
  }
  assert.ok(result.evidence.record.expandedBytes > 1024 * 1024);
  assert.ok(Math.max(...fake.responses) <= 6 * 65536 + 1024, 'even escaped CDP responses are bounded');
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'export-status.json')));
  assert.equal(status.complete, true); assert.equal(status.completedDatasets.length, 5);
});

test('tiny chunk boundaries preserve non-ASCII, surrogate pairs, escapes and document endcaps', async t => {
  const dir = directory(t), data = fixtures(), fake = page(data);
  await stopForChunkedExport(fake.evaluate);
  for (const limit of [2, 3, 7, 31]) {
    // Open independent page streams, so each test starts from its own first chunk.
    const fresh = page(data); await stopForChunkedExport(fresh.evaluate);
    const file = path.join(dir, `unicode-${limit}.gz`);
    const saved = await savePageDataset(fresh.evaluate, 'captures', file, {chunkCharacters: limit});
    verify(file, saved, data.captures);
    assert.equal(JSON.parse(fs.readFileSync(file + '.export-progress.json')).complete, true);
  }
});

test('one uncertain CDP timeout repeats the cached sequence without losing or duplicating bytes', async t => {
  const dir = directory(t), data = fixtures(), fake = page(data);
  await stopForChunkedExport(fake.evaluate);
  let lost = false;
  const evaluate = async expression => {
    const value = await fake.evaluate(expression);
    if (!lost && expression.includes('.read("record",1,')) {
      lost = true; throw Object.assign(new Error('CDP Runtime.evaluate timeout'), {code: 'CDP_TIMEOUT'});
    }
    return value;
  };
  const file = path.join(dir, 'record.gz');
  const saved = await savePageDataset(evaluate, 'record', file, {chunkCharacters: 67});
  verify(file, saved, data.exported.record);
  assert.equal(fake.requests.filter(expression => expression.includes('.read("record",1,')).length, 2);
  assert.equal(fake.stops(), 1);
});

test('permanent chunk failure preserves its prefix and still saves independent datasets honestly', async t => {
  const dir = directory(t), data = fixtures(), fake = page(data);
  await stopForChunkedExport(fake.evaluate);
  let failedCalls = 0;
  const evaluate = expression => {
    if (expression.includes('.read("record",1,')) {failedCalls++; throw new Error('synthetic permanent failure');}
    return fake.evaluate(expression);
  };
  const result = await persistPageExport(evaluate, dir, {chunkCharacters: 67});
  assert.equal(result.complete, false); assert.equal(failedCalls, 1);
  assert.equal(result.evidence.record, undefined); assert.equal(fs.existsSync(path.join(dir, 'record.json.gz')), false);
  const partial = result.partial.record, prefix = gunzipSync(fs.readFileSync(path.join(dir, partial.file)));
  assert.equal(partial.complete, false); assert.equal(partial.gzipFinalized, true);
  assert.equal(partial.expandedSha256, sha(prefix));
  assert.equal(prefix.toString(), (JSON.stringify(data.exported.record, null, 2) + '\n').slice(0, 67));
  assert.equal(result.completedDatasets.length, 4);
  verify(path.join(dir, 'captures.json.gz'), result.evidence.captures, data.captures);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'export-status.json'))).complete, false);
});

test('wrong sequence, wrong character endcap and absent final endcap never publish a complete file', async t => {
  const dir = directory(t), data = fixtures();
  for (const mode of ['sequence', 'characters', 'missing_done']) {
    const fake = page(data); await stopForChunkedExport(fake.evaluate);
    const evaluate = async expression => {
      const value = await fake.evaluate(expression);
      if (expression.includes('.read(')) {
        if (mode === 'sequence') value.sequence++;
        if (mode === 'characters') value.characters++;
      }
      return value;
    };
    const file = path.join(dir, mode + '.gz');
    await assert.rejects(savePageDataset(evaluate, 'record', file, {chunkCharacters: 67,
      maxChunks: mode === 'missing_done' ? 1 : 100000}), error => {
      assert.equal(error.partialEvidence.complete, false); return true;
    });
    assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(file + '.part'), true);
    assert.equal(JSON.parse(fs.readFileSync(file + '.export-progress.json')).complete, false);
  }
});

test('stop failure retains separately available captures without inventing a record', async t => {
  const dir = directory(t), data = fixtures(), fake = page(data, new Error('synthetic stop clone failure'));
  await assert.rejects(stopForChunkedExport(fake.evaluate), /synthetic stop clone failure/);
  const result = await persistPageExport(fake.evaluate, dir);
  assert.equal(result.complete, false); assert.deepEqual(result.completedDatasets, ['captures']);
  assert.equal(result.failures.length, 4); assert.equal(result.evidence.record, undefined);
  verify(path.join(dir, 'captures.json.gz'), result.evidence.captures, data.captures);
  assert.equal(fake.stops(), 1);
});

test('serializer errors are permanent and cannot become a false successful endcap on retry', async t => {
  const dir = directory(t), data = fixtures(); data.exported.record.invalid = undefined;
  const fake = page(data); await stopForChunkedExport(fake.evaluate);
  const file = path.join(dir, 'invalid.gz');
  await assert.rejects(savePageDataset(fake.evaluate, 'record', file, {chunkCharacters: 67}), /non-JSON/);
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(fake.evaluate('__brainChunkedExport.read("record",0,67)'), /serialization failed/);
});

test('existing complete or partial evidence is never overwritten', async t => {
  const dir = directory(t), fake = page(fixtures()); await stopForChunkedExport(fake.evaluate);
  for (const suffix of ['', '.part', '.export-progress.json']) {
    const file = path.join(dir, 'no-overwrite-' + suffix.length + '.gz');
    fs.writeFileSync(file + suffix, 'original');
    await assert.rejects(savePageDataset(fake.evaluate, 'record', file), /refusing to overwrite/);
    assert.equal(fs.readFileSync(file + suffix, 'utf8'), 'original');
  }
});

test('stop and export deadlines terminate without manufacturing a completed export', async t => {
  const dir = directory(t), pending = page(fixtures(), 'pending');
  await assert.rejects(stopForChunkedExport(pending.evaluate, 20), /deadline exceeded/);
  assert.equal(pending.stops(), 1);
  const ready = page(fixtures()); await stopForChunkedExport(ready.evaluate);
  const file = path.join(dir, 'expired.gz');
  await assert.rejects(savePageDataset(ready.evaluate, 'record', file, {deadline: Date.now() - 1}), /deadline exceeded/);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(file + '.part'), false);
});

test('metadata failure after rename preserves the complete payload hash and original error', async t => {
  const dir = directory(t), data = fixtures(), fake = page(data);
  await stopForChunkedExport(fake.evaluate);
  const file = path.join(dir, 'published.gz');
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function(target, data, ...rest) {
    if (target === file + '.export-progress.json' && JSON.parse(data).phase === 'complete') {
      throw new Error('synthetic completion metadata write failure');
    }
    return write.call(this, target, data, ...rest);
  });
  await assert.rejects(savePageDataset(fake.evaluate, 'record', file), error => {
    assert.match(error.message, /synthetic completion metadata write failure/);
    assert.equal(error.partialEvidence.file, 'published.gz');
    assert.equal(error.partialEvidence.complete, false);
    assert.equal(error.partialEvidence.payloadComplete, true);
    verify(file, error.partialEvidence, data.exported.record);
    return true;
  });
  assert.equal(fs.existsSync(file), true); assert.equal(fs.existsSync(file + '.part'), false);
});
