#!/usr/bin/env python3
"""Reproduce stage-2 constant provenance without running any simulator."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/inloop/opt-2/constant-evidence'


def main():
    historical_path = ROOT / 'artifacts/inloop/opt-2/calibration/calibration.json'
    measured_path = ROOT / 'artifacts/inloop/opt-2/controlled-calibration/measurements.json'
    report_path = ROOT / 'artifacts/inloop/opt-1/round-2/opt_report.json'
    historical, measured, report = [json.loads(path.read_text()) for path in (historical_path, measured_path, report_path)]
    mapping, groups = {}, {}
    for group in report['scenarios']:
        for name in group['members']:
            raw = json.loads((report_path.parent / (name + '.json')).read_text())
            mapping[raw['fullRecordFile']] = (name, group['scenario'])
        groups[group['scenario']] = group
    a, b = measured['fit']['aTicksPerCm'], measured['fit']['bTicksPerDegree']
    rows = []
    for sample in historical['eligible_samples']:
        key = sample['source']['record_file']
        if key not in mapping or sample['method'] != 'take_exit' or sample['speed_stratum'] != 'speed=30;obey=True':
            continue
        name, group = mapping[key]
        predicted = a * sample['distance_cm'] + b * abs(sample['turn_deg'])
        rows.append(dict(sample, layout=name, scenario=group, nominal_predicted_ticks=predicted,
                         nominal_relative_residual=abs(predicted - sample['elapsed_ticks']) / sample['elapsed_ticks']))
    summaries = []
    for group, metadata in groups.items():
        subset = [row for row in rows if row['scenario'] == group]
        summaries.append({'scenario': group, 'members': metadata['members'], 'samples': len(subset),
                          'max_relative_residual': max((row['nominal_relative_residual'] for row in subset), default=None),
                          'over_10_percent': sum(row['nominal_relative_residual'] > .1 for row in subset)})
    geometry = [{'layout': run['map'], 'scenario': next(group['scenario'] for group in report['scenarios'] if run['map'] in group['members']),
                 'all_grab_attempts': run['grab_attempts']} for run in report['runs'] if run['grab_attempts']]
    result = {'source_sha256': {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                                for path in (historical_path, measured_path, report_path)},
              'nominal_k_cm_per_deg': b / a, 'controlled_protocol_max_relative_residual': measured['fit']['maxRelativeResidual'],
              'field_rows': rows, 'field_scenarios': summaries, 'grab_window_support': geometry,
              'field_validation_not_used_for_refitting': True, 'field_rows_not_removed_for_residual': True,
              'decision': 'Use k as the calibrated nominal speed30 P3 cost; no claim of universal field time accuracy.'}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'constant_evidence.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    lines = ['# 新增常数来源与使用决定', '',
             f'采用受控原生协议测得的名义 k={b/a:.12f} cm/°。12 次实测全部纳入，最大残差 {measured["fit"]["maxRelativeResidual"]:.4%}；未用下表真实任务数据重拟合。', '',
             '原夹具报告的“生产 k 授权：否”表示当时尚未作使用决定；本文件记录根任务的集成决定，不覆盖原报告。该 k 只给 P3 的道路长度加初始转角代价，不宣称曲线道路、障碍、节点进出时间均达到 10%。', '',
             '三个角度条件及其重复不冒充三个真实独立场景。下面按冻结的真实场景分组列出全部 118 条同速合格 take_exit 的外部诊断，全部超差记录保留，明示名义系数的适用限制。', '',
             '|独立场景|布局|控制数|该名义模型最大残差|超 10% 数|', '|---|---|---:|---:|---:|']
    for row in summaries:
        lines.append(f'|{row["scenario"]}|{", ".join(row["members"])}|{row["samples"]}|{row["max_relative_residual"]:.2%}|{row["over_10_percent"]}|')
    lines += ['', '抓取窗口新增常数 4.75 / 16.875 / ±4.75cm 直接来自原生交互定义 0.38 / 1.35 / ±0.38 场景单位及公开 8 单位/米换算；扫描间距 2 atan(4.75/16.875)，额外朝向数由几何覆盖推导，不按布局拟合。', '',
              '|独立场景|布局|各次原方向抓取：前向/侧向 cm（driver 真值）|', '|---|---|---|']
    for row in geometry:
        pairs = '; '.join(f'{v["truth_forward_cm"]}/{v["truth_right_cm"]} ({v["reason"]}, tick {v["tick"]})' for v in row['all_grab_attempts'])
        lines.append(f'|{row["scenario"]}|{row["layout"]}|{pairs}|')
    lines += ['', '以上 ≥3 独立场景支持保留原向首抓、6cm步进及增加侧向覆盖；这些成功/前向失败数值不冒充已观测到 ≥3 个侧向失败。理想覆盖证明及实际航向误差限制见 ../grasp-recovery/GRASP_DESIGN.md。', '',
              '其余数值：2 个目标与逐球 approach≤3、总 observe92 来自用户契约；存放 5cm/10° 网格复用既有视点与转向约束；360° 为完整圆周；浮点 epsilon 仅防算术舍入，不放宽确认/关联距离。WM 动作证据置置信度0表示确定的原位置撤销，未改衰减/融合阈值。', '',
              '复现：`python3 tools/opt2_constant_evidence.py`。所有源哈希、输入索引与逐条数值见 constant_evidence.json。']
    (OUT / 'USAGE_DECISION.md').write_text('\n'.join(lines) + '\n')
    print(json.dumps({'native_samples': len(measured['rows']), 'field_controls': len(rows), 'field_scenarios': len(summaries),
                      'max_field_relative_residual': max(row['nominal_relative_residual'] for row in rows)}))


if __name__ == '__main__':
    main()
