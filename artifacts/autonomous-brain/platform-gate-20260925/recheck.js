"use strict";
// Evaluation only: recheck the frozen map-05 evidence under the user's revised
// two-gate definition. This does not run a new simulator and does not supersede
// or rewrite the historical, stricter FAIL result.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../../..');
const audit = require(path.join(ROOT, 'tools/v4_stage1_content_audit.js'));
const VERSION = 'wm-autonomous-platform-gate/v1';
const INPUT = 'artifacts/inloop/v4/stage-1/restore-20260925/acceptance-02';
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const read = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const same = (a, b) => audit.difference(a, b) === null;
function recheck() {
  const manifest = read(`${INPUT}/manifest.json`);
  const sourceChecks = Object.entries(manifest.platform).map(([file, expectedSha256]) => {
    const relative = `${manifest.platformRoot}/${file}`;
    return {file: relative, expectedSha256, currentSha256: sha(relative), unchanged: sha(relative) === expectedSha256};
  });
  for (const entry of [manifest.driver, manifest.evaluator]) sourceChecks.push({file: entry.file,
    expectedSha256: entry.sha256, currentSha256: sha(entry.file), unchanged: sha(entry.file) === entry.sha256});
  const totalCounts = Object.fromEntries(audit.CATEGORIES.map(c => [c, 0]));
  const truthCounts = Object.fromEntries(audit.TRUTH_CATEGORIES.map(c => [c, {expected: 0, detected: 0, misses: 0}]));
  const inputHashes = {};
  const rawRuns = [];
  const runs = [1, 2].map(run => {
    const directory = `${INPUT}/map-05-run-${run}`;
    const files = ['captures.json', 'http-transcript.json', 'record.json'];
    for (const file of files) inputHashes[`${directory}/${file}`] = sha(`${directory}/${file}`);
    const data = {map: 'map-05', run, directory, captures: read(`${directory}/captures.json`),
      transcript: read(`${directory}/http-transcript.json`), record: read(`${directory}/record.json`)};
    rawRuns.push(data);
    const result = audit.auditRun(data);
    const contentFailures = result.failures.filter(f => !f.code.startsWith('C-ENV-001'));
    const sourceCounts = {};
    const rows = data.captures.map((capture, index) => {
      const checked = result.rows[index];
      const failures = checked.failures.filter(f => !['EXPECTED_CLASS_MISSING', 'C-ENV-001_PHASE_MISMATCH', 'CHECKPOINT_SCHEMA', 'TRUTH_SCHEMA'].includes(f.code));
      const virtualMappings = checked.projection?.mappings.filter(m => m.rawSource === 'virtual-cv') || [];
      const sourcePreserved = virtualMappings.every(m => capture.robotDetections[m.projectedIndex]?.source === 'virtual-cv');
      for (const detection of capture.bridgeObservation.detections) sourceCounts[detection.source] = (sourceCounts[detection.source] || 0) + 1;
      if (!sourcePreserved) failures.push({code: 'VIRTUAL_CV_SOURCE_CHANGED'});
      return {frameId: capture.frameId, requestId: capture.requestId, detections: capture.bridgeObservation.detections.length,
        exactContent: failures.length === 0, sourcePreserved, failures};
    });
    for (const c of audit.CATEGORIES) totalCounts[c] += result.outputCounts[c];
    for (const c of audit.TRUTH_CATEGORIES) for (const key of ['expected', 'detected', 'misses']) truthCounts[c][key] += result.truthCounts[c][key];
    return {map: 'map-05', run, directory, observations: result.observations, outputCounts: result.outputCounts,
      sourceCounts, truthCounts: result.truthCounts, contentFailures, rows,
      eachObservationExact: contentFailures.length === 0 && rows.every(r => r.exactContent),
      fourClassesNonzero: audit.CATEGORIES.every(c => result.outputCounts[c] > 0)};
  });
  const pairRows = Array.from({length: Math.max(...rawRuns.map(r => r.captures.length))}, (_, index) => {
    const left = rawRuns[0].captures[index], right = rawRuns[1].captures[index];
    return {index, leftFrameId: left?.frameId, rightFrameId: right?.frameId,
      equal: !!left && !!right && same(left.bridgeObservation, right.bridgeObservation)};
  });
  const gates = {sourceEvidenceStillApplies: sourceChecks.every(row => row.unchanged),
    bridgeInternalContent100Percent: runs.every(r => r.eachObservationExact),
    allFourClassesSeen: runs.every(r => r.fourClassesNonzero)};
  return {schema: VERSION, evaluationOnly: true, mode: 'offline_recheck_of_existing_frozen_runs',
    historicalInput: INPUT, historicalResultPreserved: 'FAIL under former stage-1 requirements',
    newSimulationRun: false, sourceChecks, inputHashes,
    reviewer: {file: path.relative(ROOT, __filename), sha256: sha(path.relative(ROOT, __filename))},
    gates, allPass: Object.values(gates).every(Boolean), runs, totalCounts, truthCounts,
    repeatDetectionReport: {gate: false, observationsPaired: pairRows.length, equal: pairRows.every(r => r.equal), rows: pairRows},
    expectedDetectionReport: {gate: false, rule: audit.RULES.expected, matching: audit.RULES.detected,
      limitation: audit.RULES.instanceLimitation},
    note: 'Only content equality and nonempty four-class detections are task gates; recall, repeated detections, record and pixel determinism, and checkpoint waveform are not gates in the revised task.'};
}
function report(result) {
  const lines = ['# 平台够用门禁（2026-09-25）', '', `结果：**${result.allPass ? 'PASS' : 'FAIL'}**。`, '',
    '本次是对已完成、源码冻结的 map-05 两次日志做离线重新验算，并非新跑仿真。旧版严格验收 FAIL 及原始证据均保留。按本次用户要求，只有桥内容一致和四类非空构成门槛。', '',
    `历史输入：\`${INPUT}\`。${result.sourceChecks.length} 项平台及验证源码 SHA256 全部${result.gates.sourceEvidenceStillApplies ? '匹配' : '未匹配'}原清单。`, '',
    '| 运行 | observe 次数 | 桥与内部检测一致 | 红球 | 蓝球 | 障碍 | 存放区 |', '|---|---:|---|---:|---:|---:|---:|'];
  for (const run of result.runs) lines.push(`| map-05 第 ${run.run} 次 | ${run.observations} | ${run.eachObservationExact ? '100%' : 'FAIL'} | ${audit.CATEGORIES.map(c => run.outputCounts[c]).join(' | ')} |`);
  lines.push('', '所有实际仿真检测保留 `source: virtual-cv`；地面存放区独立像素检测保留 `source: storage-ground-pixels`。比对包括数量、顺序、类别、像素框、置信度及 source；640×640 检测器框按固定 letterbox 换算为 640×480 原始相机坐标，再与桥输出逐条比较。', '',
    '以下应见检出统计仅报告，不作门槛。统计单位为（帧，真值物体）；检出定义为该帧存在对应类别检测，不声称逐物体实例匹配。', '',
    '| 类别 | 应见 | 检出 | 未检出 |', '|---|---:|---:|---:|');
  for (const c of audit.TRUTH_CATEGORIES) { const t = result.truthCounts[c]; lines.push(`| ${c} | ${t.expected} | ${t.detected} | ${t.misses} |`); }
  lines.push('', `同一脚本两次检测：${result.repeatDetectionReport.observationsPaired} 对观测${result.repeatDetectionReport.equal ? '逐条相同' : '存在差异'}（只报告）。`, '',
    '全部数值、原始日志 SHA256、逐帧检查结果见同目录 `gate.json`。复算：', '',
    '```sh', 'node artifacts/autonomous-brain/platform-gate-20260925/recheck.js --check', '```', '',
    '该命令重新读取原始 captures、record 与 HTTP transcript，复算新门槛并核对已保存的 gate.json；不修改历史日志。', '');
  return lines.join('\n');
}
if (require.main === module) {
  const result = recheck();
  if (process.argv.includes('--check')) assert.deepEqual(result, JSON.parse(fs.readFileSync(path.join(__dirname, 'gate.json'), 'utf8')));
  else {
    for (const file of ['gate.json', 'REPORT.md']) assert.ok(!fs.existsSync(path.join(__dirname, file)), `refusing to overwrite ${file}`);
    fs.writeFileSync(path.join(__dirname, 'gate.json'), JSON.stringify(result, null, 2) + '\n');
    fs.writeFileSync(path.join(__dirname, 'REPORT.md'), report(result));
  }
  console.log(JSON.stringify({allPass: result.allPass, observations: result.runs.reduce((n,r)=>n+r.observations,0), counts: result.totalCounts, truth: result.truthCounts, repeated: result.repeatDetectionReport.equal}));
  process.exitCode = result.allPass ? 0 : 1;
}
module.exports = {recheck, VERSION};
