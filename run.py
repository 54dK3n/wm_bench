#!/usr/bin/env python3
"""wm_bench 在环层一键跑批。

    python3 run.py --out artifacts/inloop [--program planner.py] [--repeats 3] [--max-attempts 40] [--task1]

产物：
  <out>/bearing/            1.2 / 1.3 方位角探针原始数据与评估
  <out>/explore/<task>/     每套布局一份探索采集 JSON（逐帧 observe/odometry），2.1 回放评估
  <out>/runs/<task>/        规划闭环成绩（需要 --program；否则标记为阻塞）
  <out>/summary.json        全部指标
  <out>/TABLES.md           主表（赛题2 × 10 布局）与泛化表（赛题1 × 8 布局）
未交付的规划闭环不会被伪造：没有 --program 时 4.x/3.4 列全部写"阻塞"。
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import eval_inloop as ev  # noqa: E402
import metrics  # noqa: E402
from world_model.providers.guangyang import GuangyangArtifactFilter  # noqa: E402
from tests.acceptance import truth as truth_mod  # noqa: E402

DRIVER = HERE / "tools" / "inloop_driver.js"
PROGRAMS = HERE / "programs"
TASKS = {"guangyang2": ("R2-GYI-MVP-02", 10), "guangyang1": ("R2-GYI-MVP-01", 8)}


def run_driver(mission: str, program: Path, out: Path, *, want_maps=None, disable_evidence=False, timeout_ms=1500000, prefix="GY") -> dict:
    cmd = ["node", str(DRIVER), "--mission", mission, "--program", str(program), "--out", str(out), "--prefix", prefix, "--timeout-ms", str(timeout_ms)]
    if disable_evidence:
        cmd.append("--disable-evidence")
    if want_maps:
        cmd += ["--want-maps", ",".join(want_maps)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    info = {"exit": proc.returncode, "stderr_tail": proc.stderr[-800:]}
    if out.exists():
        info["result"] = json.loads(out.read_text(encoding="utf-8"))
    return info


def cover_layouts(mission: str, program: Path, out_dir: Path, *, max_attempts: int, disable_evidence: bool, timeout_ms: int, existing_ok=True) -> dict:
    """反复注册新队伍直到把该赛题的全部布局各采集一次；返回 map_id -> 结果文件。"""
    task_id, count = TASKS[mission]
    wanted = [f"map-{i:02d}" for i in range(1, count + 1)]
    out_dir.mkdir(parents=True, exist_ok=True)
    covered = {}
    if existing_ok:
        for map_id in wanted:
            path = out_dir / f"{map_id}.json"
            if path.exists():
                covered[map_id] = path
    attempts = 0
    while len(covered) < count and attempts < max_attempts:
        attempts += 1
        missing = [m for m in wanted if m not in covered]
        tmp = out_dir / f"attempt-{attempts:03d}.json"
        print(f"[{mission}] attempt {attempts}: need {missing}", flush=True)
        info = run_driver(mission, program, tmp, want_maps=missing, disable_evidence=disable_evidence, timeout_ms=timeout_ms)
        result = info.get("result") or {}
        if result.get("skipped"):
            tmp.unlink(missing_ok=True)
            continue
        map_id = result.get("assignedMap")
        if info["exit"] != 0 or not map_id or map_id not in missing:
            print(f"   driver exit {info['exit']} map={map_id}: {info['stderr_tail'][-300:]}", flush=True)
            continue
        final = out_dir / f"{map_id}.json"
        tmp.rename(final)
        covered[map_id] = final
        print(f"   captured {map_id}: lines={len(result.get('lines', []))} runState={result.get('runState')}", flush=True)
    return {"task_id": task_id, "wanted": wanted, "covered": {k: str(v) for k, v in covered.items()}, "attempts": attempts}


def eval_bearing_stage(out_dir: Path, timeout_ms: int) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    raw = out_dir / "probe_bearing.json"
    if not raw.exists():
        info = run_driver("guangyang2", PROGRAMS / "probe_bearing.py", raw, timeout_ms=timeout_ms)
        if info["exit"] != 0:
            return {"error": info["stderr_tail"]}
    result = json.loads(raw.read_text(encoding="utf-8"))
    body = result["mapConfig"]["/api/v1/map-config/R2-GYI-MVP-02"]["body"]
    layout, matched = ev.layout_from_map_config("R2-GYI-MVP-02", body)
    evaluation = ev.evaluate_bearing(result, layout, camera_forward_m=0.0)
    evaluation["assigned_map"] = matched
    (out_dir / "bearing_eval.json").write_text(json.dumps(evaluation, ensure_ascii=False, indent=1), encoding="utf-8")
    return evaluation


def eval_localization_stage(cover: dict, mutation=None, heading_sign: float = 1.0) -> dict:
    per_map = {}
    all_errors, matched_errors, ghosts = [], [], 0
    d5_filtered = 0
    invalid_samples = {}
    valid_layouts = 0
    default_artifact_config = Path(__file__).resolve().parents[1] / "configs" / "guangyang_texture_artifacts.json"
    if not default_artifact_config.exists():
        default_artifact_config = Path.home() / "wm_kit" / "configs" / "guangyang_texture_artifacts.json"
    artifact_config = Path(os.environ.get("WM_D5_ARTIFACT_CONFIG", str(default_artifact_config)))
    for map_id, path in sorted(cover["covered"].items()):
        result = json.loads(Path(path).read_text(encoding="utf-8"))
        body = result["mapConfig"][f"/api/v1/map-config/{cover['task_id']}"]["body"]
        layout, matched = ev.layout_from_map_config(cover["task_id"], body)
        artifact_filter = (GuangyangArtifactFilter.from_path(str(artifact_config), allowed_categories=("target",))
                           if artifact_config.exists() else None)
        sample_metrics = ev.evaluate_localization(result, layout, mutation=mutation, heading_sign=heading_sign,
                                                  artifact_filter=artifact_filter,
                                                  distance_scale_by_class={"target": 1.25})
        sample_metrics["assigned_map"] = matched
        sample_metrics["run_state"] = result.get("runState")
        sample_metrics["wall_seconds"] = result.get("wallSeconds")
        per_map[map_id] = sample_metrics
        if sample_metrics.get("invalid_sample"):
            invalid_samples[map_id] = {
                "reason": "zero_confirmed_tracks",
                "run_state": sample_metrics.get("run_state"),
                "frames": sample_metrics.get("frames"),
            }
            continue
        valid_layouts += 1
        all_errors += list(sample_metrics.get("confirmed_errors_cm") or [])
        matched_errors += list(sample_metrics.get("matched_errors_cm") or [])
        ghosts += int(sample_metrics.get("ghost_tracks") or 0)
        d5_filtered += int(sample_metrics.get("d5_filtered_detections", 0))
    summary = metrics.summarize_localization(all_errors, matched_errors)
    return {
        "per_map": per_map, "heading_sign": heading_sign,
        "median_cm": summary["median_cm"],
        "p90_cm": summary["p90_cm"],
        "n_confirmed_tracks": summary["n_confirmed_tracks"],
        "layouts": len(per_map), "layouts_run": len(per_map), "layouts_valid": valid_layouts,
        "invalid_samples": invalid_samples,
        "matched_tracks": summary["matched_tracks"], "ghost_tracks": ghosts,
        "matched_median_cm": summary["matched_median_cm"],
        "matched_p90_cm": summary["matched_p90_cm"],
        "d5_filtered_detections": d5_filtered,
    }


def first_target_reference(task_id: str) -> dict:
    """3.4 离线穷举参考：起点到各目标物道路锚点的图上最短路（测试侧 Dijkstra），起点唯一出口为直行，转向项相同。"""
    graph = truth_mod.load_graph(task_id)
    edges = graph["graph"]["edges"]
    adj = {}
    for e in edges:
        adj.setdefault(e["fromNodeId"], []).append((e["toNodeId"], e["lengthCm"], e["roadId"]))
        if not e.get("oneWay"):
            adj.setdefault(e["toNodeId"], []).append((e["fromNodeId"], e["lengthCm"], e["roadId"]))
    import heapq

    def dijkstra(src):
        dist = {src: 0.0}
        heap = [(0.0, src)]
        while heap:
            d, u = heapq.heappop(heap)
            if d > dist.get(u, float("inf")):
                continue
            for v, w, _ in adj.get(u, []):
                nd = d + w
                if nd < dist.get(v, float("inf")):
                    dist[v] = nd
                    heapq.heappush(heap, (nd, v))
        return dist

    start_node = graph["startRoadState"]["nodeId"]
    dist = dijkstra(start_node)
    by_road = {e["roadId"]: e for e in edges}
    reference = {}
    for map_id in truth_mod.list_map_ids(task_id):
        layout = truth_mod.load_layout(task_id, map_id)
        options = []
        for obj in layout.of("target"):
            edge = by_road[obj.anchor["roadId"]]
            via_from = dist.get(edge["fromNodeId"], float("inf")) + obj.anchor["progressCm"]
            via_to = dist.get(edge["toNodeId"], float("inf")) + (edge["lengthCm"] - obj.anchor["progressCm"])
            if edge.get("oneWay"):
                via_to = float("inf")
            options.append({"target": obj.oid, "road": obj.anchor["roadId"], "path_cm": round(min(via_from, via_to), 1)})
        best = min(options, key=lambda o: o["path_cm"])
        reference[map_id] = {"options": options, "optimal": best["target"], "start_node": start_node}
    return reference




def first_target_offline_stage(task_id: str) -> dict:
    """在测试侧用公开 mission 锚点做 3.4 的首选目标算法自检。

    这不是在环成绩，只验证 planning.first_target 在公开道路锚点上的选择与
    first_target_reference 参考一致；不写入任何布局真值坐标。
    """
    from planning.first_target import select_first_target

    raw_graph = truth_mod.load_graph(task_id)
    graph = raw_graph["graph"]
    start_node = raw_graph["startRoadState"]["nodeId"]
    rows = {}
    for map_id in truth_mod.list_map_ids(task_id):
        layout = truth_mod.load_layout(task_id, map_id)
        mission = {"objects": [
            {"role": "target", "roadId": obj.anchor["roadId"], "progressCm": obj.anchor["progressCm"]}
            for obj in layout.of("target")
        ]}
        rows[map_id] = [{"first_target": select_first_target(mission, graph, start_node),
                         "offline_first_target_only": True}]
    return {"task_id": task_id, "rows": rows, "offline_first_target_only": True}

def planner_stage(mission: str, program: Path, out_dir: Path, *, repeats: int, max_attempts: int, timeout_ms: int) -> dict:
    """规划闭环成绩采集（需要 --program）。逐套布局跑 repeats 次。"""
    task_id, count = TASKS[mission]
    rows = {}
    for r in range(repeats):
        sub = out_dir / f"rep{r + 1}"
        cover = cover_layouts(mission, program, sub, max_attempts=max_attempts, disable_evidence=False, timeout_ms=timeout_ms)
        for map_id, path in cover["covered"].items():
            result = json.loads(Path(path).read_text(encoding="utf-8"))
            rows.setdefault(map_id, []).append({
                "runState": result.get("runState"), "score": result.get("score"), "record": result.get("record"),
                "wallSeconds": result.get("wallSeconds"), "lines": len(result.get("lines", [])),
                "first_target": next((l.get("first_target") for l in result.get("lines", []) if isinstance(l, dict) and "first_target" in l), None),
            })
    return {"task_id": task_id, "rows": rows}


def score_num(text):
    try:
        return float(str(text).split("/")[0].strip())
    except (ValueError, TypeError):
        return None


def write_tables(summary: dict, path: Path) -> None:
    lines = ["# wm_bench 在环层结果", "", f"生成时间：{time.strftime('%Y-%m-%d %H:%M:%S')}", ""]
    for title, mission in (("主表：赛题2 × 10 布局", "guangyang2"), ("泛化表：赛题1 × 8 布局", "guangyang1")):
        task_id, count = TASKS[mission]
        lines += [f"## {title}（{task_id}）", "",
                  "| 布局 | 完成 | 总分 | 任务 | 规则 | 自主 | 效率 | 碰撞 | 违规 | 用时(s) | 定位中位误差(cm) | 备注 |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        planner = summary.get("planner", {}).get(mission)
        loc = summary.get("localization", {}).get(mission, {}).get("per_map", {})
        for i in range(1, count + 1):
            map_id = f"map-{i:02d}"
            l = loc.get(map_id)
            loc_cell = f"{l['median_cm']}" if l and l.get("median_cm") is not None else ("未采集" if not l else "无 CONFIRMED 轨迹")
            if planner and planner["rows"].get(map_id):
                runs = planner["rows"][map_id]
                s = runs[0]["score"] or {}
                rec = (runs[0].get("record") or {}).get("top", {}) if runs[0].get("record") else {}
                lines.append(f"| {map_id} | {s.get('mission', '?')} | {s.get('total', '?')} | {s.get('task', '?')} | {s.get('rule', '?')} | {s.get('auto', '?')} | {s.get('efficiency', '?')} | {rec.get('collisionCount', '?')} | {rec.get('ruleViolations', '?')} | {runs[0].get('wallSeconds', '?')} | {loc_cell} | 重复 {len(runs)} 次 |")
            else:
                lines.append(f"| {map_id} | 阻塞 | 阻塞 | 阻塞 | 阻塞 | 阻塞 | 阻塞 | 阻塞 | 阻塞 | 阻塞 | {loc_cell} | 在环 BLOCKED：planner 未完成，不填数字 |")
        agg = summary.get("localization", {}).get(mission, {})
        invalid_count = len(agg.get("invalid_samples") or {})
        lines += ["", f"定位误差汇总：跑了 {agg.get('layouts_run', 0)} 局，有效 {agg.get('layouts_valid', 0)} 局，无效 {invalid_count} 局；CONFIRMED 轨迹 {agg.get('n_confirmed_tracks', 0)} 条，中位 {agg.get('median_cm')} cm，P90 {agg.get('p90_cm')} cm。", ""]
    b = summary.get("bearing", {})
    lines += ["## 1.2 / 1.3 方位角", "",
              f"样本 {b.get('n_samples')} 个，最大误差 {b.get('max_error_deg')}°，中位 {b.get('median_error_deg')}°；±7° 内样本 {b.get('n_center')} 个，方向冲突 {len(b.get('consistency_conflicts', []))} 个。", ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(HERE / "artifacts" / "inloop"))
    parser.add_argument("--program", default=str(PROGRAMS / "guangyang_planner.py"),
                        help="规划闭环程序；默认使用交付的 guangyang_planner.py")
    parser.add_argument("--no-planner", action="store_true", help="只跑离线/探索回放，明确跳过规划闭环")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--max-attempts", type=int, default=40)
    parser.add_argument("--timeout-ms", type=int, default=1200000)
    parser.add_argument("--task1", action="store_true", help="同时采集赛题1 八套布局（泛化表的定位列）")
    parser.add_argument("--skip-explore", action="store_true")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    summary = {"generated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "localization": {}, "planner": {}, "first_target_reference": {}}
    summary["bearing"] = eval_bearing_stage(out / "bearing", args.timeout_ms)
    missions = ["guangyang2"] + (["guangyang1"] if args.task1 else [])
    for mission in missions:
        # --skip-explore：不再跑新局，只评估已采集的布局
        cover = cover_layouts(mission, PROGRAMS / os.environ.get("WM_EXPLORE_PROGRAM", "explore_roads_light.py"), out / "explore" / TASKS[mission][0],
                              max_attempts=0 if args.skip_explore else args.max_attempts, disable_evidence=True, timeout_ms=args.timeout_ms)
        if cover["covered"]:
            summary["localization"][mission] = eval_localization_stage(cover)
            summary["localization"][mission]["attempts"] = cover["attempts"]
            summary.setdefault("localization_diag_heading_flipped", {})[mission] = eval_localization_stage(cover, heading_sign=-1.0)
    for mission in missions:
        summary["first_target_reference"][mission] = first_target_reference(TASKS[mission][0])
        summary.setdefault("first_target_offline", {})[mission] = first_target_offline_stage(TASKS[mission][0])
    if args.program and not args.no_planner:
        for mission in missions:
            summary["planner"][mission] = planner_stage(mission, Path(args.program), out / "runs" / TASKS[mission][0],
                                                        repeats=args.repeats, max_attempts=args.max_attempts, timeout_ms=args.timeout_ms)
    else:
        summary["planner_blocked"] = "已通过 --no-planner 跳过规划闭环；4.x/3.4 未评估"
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    write_tables(summary, out / "TABLES.md")
    print(json.dumps({"summary": str(out / "summary.json"), "tables": str(out / "TABLES.md")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
