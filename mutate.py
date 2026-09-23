#!/usr/bin/env python3
"""变异测试驱动：对基线与 8 个已知缺陷各跑一遍离线验收套件，输出对照矩阵。

用法：python3 mutate.py [--heading-sign 1|-1] [--out artifacts/mutation]
配置级变异通过 WorldModel 构造参数注入；源码级变异通过运行时替换公开函数注入
（见 tests/acceptance/conftest.py），并在此先做"变异是否生效"探针。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

WM_KIT = Path(os.environ.get("WORLD_MODEL_ROOT", str(Path.home() / "wm_kit")))
ART = Path(os.environ.get("WM_ACCEPT_ARTIFACTS", str(Path.home() / "wm_bench" / "artifacts" / "acceptance")))

MUTATIONS = [
    ("gate_50m", "关联门控基础值 0.5 m → 50.0 m", ["test_2_4_no_false_merge", "test_2_8_gate_grows_with_time_gap_and_is_capped"], "2_4", "total_merges"),
    ("gate_cap_0_01m", "门控上限 2.0 m → 0.01 m", ["test_2_3_no_track_split"], "2_3", "total_splits"),
    ("confirm_hits_1", "confirm_hits 3 → 1", ["test_2_2_track_count_matches_truth"], "2_2", "correct_layouts"),
    ("fov_half_life_600s", "视野内漏检半衰期 1.5 s → 600 s", ["test_2_5_grabbed_target_goes_stale_within_3s"], "2_5", "passed"),
    ("turn_no_normalize", "最短转角去掉归一化，直接返回 target - current", ["test_3_2_shortest_turn_20_cases"], "3_2", "failures"),
    ("turn_cost_k_zero", "代价函数转向项系数 k → 0", ["test_3_3_cost_optimal_beats_euclidean_nearest"], "3_3", "selection_correct"),
    ("euclid_path", "路径距离改用欧氏距离替代图上最短路", ["test_3_3_cost_optimal_beats_euclidean_nearest", "test_3_4_first_target_uses_graph_shortest_not_euclidean"], "3_3", "selection_correct"),
    ("contract_extra_obj_id", "契约输出多加一个 obj_id 字段", ["test_2_6_contract_fields_exactly_eight"], "2_6", "problems"),
]

PROBES = {
    # 变异生效探针：在变异环境下执行，返回 True 表示被测函数的行为确实被改变
    "turn_no_normalize": "import selection.turn as t; print(abs(t.normalize_turn_deg(10, 350) - 340) < 1e-9)",
    "turn_cost_k_zero": ("import selection.selector as s; c=s.Candidate(candidate_id='a', node_id=None, bearing_deg=180, path_distance_cm=100);"
                         "a=s.score_candidate(c, current_heading_deg=0, k=1.0); b=s.score_candidate(s.Candidate(candidate_id='b', node_id=None, bearing_deg=0, path_distance_cm=100), current_heading_deg=0, k=1.0);"
                         "print(abs(a.cost-b.cost) < 1e-9)"),
    "euclid_path": ("import selection.selector as s; g={'nodes':[{'nodeId':'S','x':0,'z':0},{'nodeId':'N','x':0,'z':400},{'nodeId':'A','x':100,'z':0}],"
                    "'edges':[{'roadId':'r1','fromNodeId':'S','toNodeId':'N','lengthCm':400,'oneWay':False},{'roadId':'r2','fromNodeId':'N','toNodeId':'A','lengthCm':500,'oneWay':False}]};"
                    "r=s.score_candidate(s.Candidate(candidate_id='A', node_id='A', bearing_deg=0), current_heading_deg=0, start_node='S', graph=g, k=1.0);"
                    "print(abs(r.path_distance_cm-100) < 1e-6)"),
    "contract_extra_obj_id": ("from world_model.adapters import to_scene_observations; from world_model.types import TrackedObject;"
                              "print('obj_id' in to_scene_observations([TrackedObject(obj_id='x', name='target')])[0])"),
}


def run_suite(env_extra: dict, label: str, out_dir: Path) -> dict:
    env = dict(os.environ)
    env.update(env_extra)
    cmd = [sys.executable, "-m", "pytest", "tests/acceptance/offline", "-q", "-p", "no:cacheprovider", "--no-header", "-rA"]
    proc = subprocess.run(cmd, cwd=str(WM_KIT), env=env, capture_output=True, text=True)
    (out_dir / f"{label}.log").write_text(proc.stdout + "\n" + proc.stderr, encoding="utf-8")
    status = {}
    for line in proc.stdout.splitlines():
        m = re.match(r"^(PASSED|FAILED|ERROR) tests/acceptance/offline/[a-z_0-9]+\.py::([A-Za-z0-9_]+)", line)
        if m:
            status[m.group(2)] = m.group(1)
    return status


def probe(mutation: str, env_extra: dict) -> bool | None:
    code = PROBES.get(mutation)
    if not code:
        return None
    env = dict(os.environ)
    env.update(env_extra)
    boot = ("import os, sys; sys.path.insert(0, os.getcwd()); "
            "from tests.acceptance import conftest; conftest._apply_runtime_mutation(os.environ['WM_ACCEPT_MUTATION']); ")
    proc = subprocess.run([sys.executable, "-c", boot + code], cwd=str(WM_KIT), env=env, capture_output=True, text=True)
    return proc.stdout.strip().endswith("True")


def metric(folder: str, test_id: str, key: str):
    path = ART / folder / f"{test_id}.json"
    if not path.exists():
        return None
    value = json.loads(path.read_text(encoding="utf-8")).get(key)
    if isinstance(value, list):
        return len(value)
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--heading-sign", default="1")
    parser.add_argument("--out", default=str(Path.home() / "wm_bench" / "artifacts" / "mutation"))
    args = parser.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    mode_suffix = "_diag" if args.heading_sign.startswith("-") else ""
    base_env = {"WM_ACCEPT_HEADING_SIGN": args.heading_sign, "WM_ACCEPT_MUTATION": ""}
    print("baseline ...", flush=True)
    baseline = run_suite(base_env, "baseline" + mode_suffix, out_dir)
    rows = []
    for name, desc, tests, test_id, key in MUTATIONS:
        env = dict(base_env)
        env["WM_ACCEPT_MUTATION"] = name
        print(f"mutation {name} ...", flush=True)
        effective = probe(name, env)
        status = run_suite(env, name + mode_suffix, out_dir)
        for t in tests:
            before, after = baseline.get(t, "MISSING"), status.get(t, "MISSING")
            if before == "PASSED" and after == "FAILED":
                verdict = "有效（绿→红）"
            elif before == "FAILED" and after == "FAILED":
                verdict = "基线已红，无法区分"
            elif after == "PASSED":
                verdict = "无效（变异后仍绿）"
            else:
                verdict = f"{before}→{after}"
            rows.append({"mutation": name, "description": desc, "test": t, "before": before, "after": after,
                         "metric": key, "metric_before": metric("baseline" + mode_suffix, test_id, key),
                         "metric_after": metric(name + mode_suffix, test_id, key),
                         "mutation_effective_probe": effective, "verdict": verdict})
    result = {"heading_sign": args.heading_sign, "baseline": baseline, "rows": rows}
    (out_dir / f"matrix{mode_suffix}.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    for r in rows:
        print(f"{r['mutation']:<22} {r['test']:<48} {r['before']:>6} -> {r['after']:<6} 指标 {r['metric']}: {r['metric_before']} -> {r['metric_after']}  探针:{r['mutation_effective_probe']}  {r['verdict']}")


if __name__ == "__main__":
    main()
