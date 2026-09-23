#!/usr/bin/env python3
"""Recompute v2 evidence from authorized development JSON only; no simulator/test I/O."""
import collections
import hashlib
import itertools
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tools"))
from detection_evaluation import read, replay_filter, summarize
from detection_filter_development import category_trace
from stage_report import compare, POLICY

OUT = Path(__file__).resolve().parent
DEV = ROOT / "artifacts/inloop/opt-1/filter-development"
V1 = ROOT / "artifacts/inloop/opt-1/filter-candidate-v1/runtime_filter.py"
V2 = ROOT / "programs/detection_filter.py"
SUPPORT = {
    "window_false_red": ("target", "false", True, [("calib_runs_v6/attempt-02.json", 91), ("calib_runs_v6/attempt-08.json", 77), ("v28r1_batch/map-09.json", 87)]),
    "window_false_blue": ("distractor", "false", True, [("calib_runs_v6/attempt-03.json", 3), ("calib_runs_v6/attempt-05.json", 56), ("calib_runs_v6/attempt-08.json", 37)]),
    "outside_true_red": ("target", "true", False, [("calib_runs_v6/attempt-02.json", 13), ("calib_runs_v6/attempt-03.json", 87), ("calib_runs_v6/attempt-08.json", 20)]),
    "outside_true_blue": ("distractor", "true", False, [("calib_runs_v2/attempt-01.json", 5), ("calib_runs_v6/attempt-03.json", 74), ("calib_runs_v6/attempt-08.json", 58)]),
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def window(row):
    return 40 <= row["observation"]["distanceCm"] < 90


def main():
    rows = read(DEV / "dev_labels.json")["rows"]
    frames = read(DEV / "dev_runtime_frames.json")["frames"]
    for row in rows:
        rel = Path(row["source"]).resolve().relative_to(ROOT / "artifacts/inloop")
        assert rel.parts[0] in {"calib_runs", "calib_runs_v2", "calib_runs_v4", "calib_runs_v5", "calib_runs_v6", "v28r1_batch"}
    old_ids, _ = replay_filter(frames, V1)
    new_ids, _ = replay_filter(frames, V2)
    old_ids, new_ids = set(old_ids), set(new_ids)
    assert new_ids <= old_ids
    metrics = summarize(rows, new_ids)
    changed = [row for row in rows if row["row_id"] in old_ids - new_ids]
    assert all(not window(row) for row in changed)
    support = {}
    for name, (category, label, in_window, specs) in SUPPORT.items():
        selected, traces = [], []
        for relative, line in specs:
            source = ROOT / "artifacts/inloop" / relative
            matches = [row for row in rows if row["source"] == str(source) and row["raw_line_index"] == line
                       and row["category"] == category and row["label"] == label and window(row) == in_window
                       and (not in_window or row["row_id"] in new_ids)]
            assert len(matches) == 1, (name, relative, line)
            selected.append(matches[0])
            traces.append(category_trace(source, category))
        comparisons = [{"sources": [a["source"], b["source"]], **compare(a["trace"], b["trace"])}
                       for a, b in itertools.combinations(traces, 2)]
        geometry = []
        for a, b in itertools.combinations(selected, 2):
            av, bv = a["truth_binding"]["vehicle"], b["truth_binding"]["vehicle"]
            geometry.append({"rows": [a["row_id"], b["row_id"]],
                             "observer_distance_cm": math.hypot(av["x"] - bv["x"], av["z"] - bv["z"]) * 100 / 8,
                             "heading_difference_deg": abs((math.degrees(av["heading"] - bv["heading"]) + 180) % 360 - 180)})
        support[name] = {"rows": selected, "full_category_traces": traces, "pairwise_comparisons": comparisons,
                         "actual_geometry_differences": geometry,
                         "three_independent_sequences": len(traces) == 3 and all(not item["equivalent"] for item in comparisons)}
    assert all(group["three_independent_sequences"] for group in support.values())
    by_scope = {}
    for color, category in (("red", "target"), ("blue", "distractor")):
        subset = [row for row in rows if row["category"] == category]
        by_scope[color] = {scope: {"total": len(group), "labels": dict(collections.Counter(row["label"] for row in group)),
                                    "known_coverage": sum(row["label"] in ("true", "false") for row in group) / len(group),
                                    "v1_rejected": dict(collections.Counter(row["label"] for row in group if row["row_id"] in old_ids)),
                                    "v2_rejected": dict(collections.Counter(row["label"] for row in group if row["row_id"] in new_ids))}
                           for scope, group in (("inside", [r for r in subset if window(r)]), ("outside", [r for r in subset if not window(r)]))}
    report = {"schema": "wm-filter-v2-development-provenance/v1", "filter_sha256": sha(V2), "v1_archive_sha256": sha(V1),
              "inputs": {str(p): sha(p) for p in (DEV / "dev_labels.json", DEV / "dev_runtime_frames.json", Path(__file__).resolve())},
              "contamination": {"test_influenced_rule_selection": True, "status": "previous test is contaminated; subsequent replay is a regression check, not held-out generalization",
                                "trigger": "parent reported v1 false rejection of three outside-window true detections; this tool does not read those records",
                                "new_test_records_read_by_this_tool": False},
              "rule": "reject target confidence<0.84 or distractor confidence<0.80 only for finite 40<=raw distanceCm<90; otherwise abstain",
              "constant_origin": {"0.84/0.80": "unchanged v1 confidence floors; original full-dev boundary proof retained",
                                  "40/90": "existing WM eligibility contract, reused without fitting or changing confirmation; raw lower inclusive, upper exclusive",
                                  "range_caution": "this is the WM localization eligibility window, not a claim that all measurements outside it are false or uncalibrated"},
              "candidate": metrics, "baseline": summarize(rows, []), "by_scope": by_scope,
              "rejections_removed_from_v1": {"all": len(changed), "red": dict(collections.Counter(r["label"] for r in changed if r["category"] == "target")),
                                             "blue": dict(collections.Counter(r["label"] for r in changed if r["category"] == "distractor"))},
              "supports": support, "comparison_policy_unchanged": POLICY["near_tolerances"],
              "limits": ["No development true detection was wrongly removed by v1, so development data cannot establish a false-kill improvement from v2.",
                         "Only three labelled red false detections remain rejected; they are three distinct full trajectories, but this is a very small precision denominator.",
                         "Outside-window genuine observations in three trajectories per class support retaining such evidence; this is not proof that v1's low-confidence outside observations were genuine.",
                         "Unknown labels are excluded from rates but counted explicitly. Test feedback influenced scope selection; no unbiased test claim is permitted.",
                         "v2 retains additional known false detections; confirmation/WM eligibility stay unchanged and must protect localization downstream."]}
    (OUT / "constant_provenance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    lines = ["# Filter v2 开发证据（测试已污染）", "", "v1 测试误杀反馈影响了本次规则选型；后续同测试集结果仅为回归检查，不是独立泛化测试。此复算只读取原标定采集和 v28r1 开发数据。", "", "仅在原 WM 合法原始距离窗口 **40≤d<90cm** 内应用原置信度门：红<0.84、蓝<0.80。窗外、封顶、距离/置信度缺失或非有限时保留并记录弃权原因。40/90 为原合同复用，.84/.80 不变；没有新增拟合阈值或布局/坐标分支。", "", "v1 源码及专属单测已原样归档到 filter-candidate-v1/runtime_filter.py 与 test_detection_filter.py。旧单测的距离无关合同改为窗口内过滤，新增边界和弃权用例；原确认窗口与机器人调用未改。", "", "|类别|真例保留|已标误杀|已标过滤precision|过滤unknown|额外保留known false / unknown|", "|---|---:|---:|---:|---:|---:|"]
    for color in ("red", "blue"):
        m = metrics[color]
        unknown = m["all_raw_filtered"] - m["true_filtered"] - m["false_filtered"]
        changes = report["rejections_removed_from_v1"][color]
        lines.append(f"|{color}|{m['true_kept']}/{m['true_total']}|{m['true_filtered']}/{m['true_total']}|{m['false_filtered']}/{m['true_filtered']+m['false_filtered']}|{unknown}|{changes.get('false',0)} / {changes.get('unknown',0)}|")
    lines += ["", "过滤总数36：26条已标伪检测、10条unknown。红precision分母仅3，不宜作强结论。若被过滤unknown全是真例，则红/蓝precision分别最低3/4=75%、23/32=71.875%；unknown不能冒充伪检测。", "", "开发集里 v1 没有已标真例误杀，所以开发证据不能声称v2改善已标误杀率；它只证实窗外存在真实目标及证据不足、并量化弃权的过滤代价。", "", "以下每组均用完整类别轨迹（首末相关帧之间含空帧）归一，相同既有3cm/2°/confidence .05/tick2容差逐对比较，三对均不等价；另保留实际观察位姿与几何差值。不以布局名或单点读数计独立性。", ""]
    for name, group in support.items():
        lines.append(f"- {name}: " + "; ".join(f"{Path(r['source']).parent.name}/{Path(r['source']).name} lines[{r['raw_line_index']}], tick {r['tick']}, d={r['observation']['distanceCm']}cm, bearing={r['observation']['bearingDeg']}°, confidence={r['observation']['confidence']}" for r in group['rows']))
    lines += ["", "所有完整轨迹、原始行、真值绑定、pairwise比较及计数在 constant_provenance.json；评测原输出在 dev_evaluation.json。", "", "复算（不启动仿真、不读测试）：", "```sh", "PYTHONDONTWRITEBYTECODE=1 python3 -m unittest programs.tests.test_detection_filter -v", "PYTHONDONTWRITEBYTECODE=1 python3 tools/detection_evaluation.py --dataset dev --filter-file programs/detection_filter.py --out artifacts/inloop/opt-1/filter-candidate-v2", "PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-1/filter-candidate-v2/reproduce_provenance.py", "```", ""]
    (OUT / "DEVELOPMENT.md").write_text("\n".join(lines))
    print(json.dumps({"filter_sha256": sha(V2), "supports": {k:v['three_independent_sequences'] for k,v in support.items()}, "candidate": metrics}, ensure_ascii=False))


if __name__ == "__main__":
    main()
