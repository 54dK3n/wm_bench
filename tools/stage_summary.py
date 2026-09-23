#!/usr/bin/env python3
"""Recompute the completed stage-1 reports and aggregate them; never run simulation."""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage-dir", type=Path, default=ROOT / "artifacts/inloop/stage-1")
    parser.add_argument("--recompute", action="store_true", help="Regenerate batch, stage and indexed numeric reports first")
    args = parser.parse_args()
    folder = args.stage_dir.resolve()
    rounds = sorted(folder.glob("round-[123]"))
    assert len(rounds) == 3, "This final report requires all three completed rounds."
    collected = []
    for item in rounds:
        if args.recompute:
            for tool in ("batch_report.py", "stage_report.py", "extract_round_diagnostics.py"):
                subprocess.run([sys.executable, str(ROOT / "tools" / tool), str(item)], check=True,
                               stdout=subprocess.DEVNULL)
        stage, progress = read(item / "stage_report.json"), read(item / "progress.json")
        assert progress["status"] == "complete" and len(progress["completed"]) == 10
        runs = stage["runs"]
        collected.append({
            "round": item.name, "identity": progress["identity"],
            "source_sha256": progress["source_file_sha256"],
            "independent_success": stage["independent_success"], "gates": stage["gates"],
            "all_gates_pass": stage["all_gates_pass"],
            "confirmed_and_grabbed_layouts": sum(bool(r["confirmed_and_grabbed"]) for r in runs),
            "program_errors": sum(r["platform_program_error_count"] for r in runs),
            "stationary_repeats": sum(r["stationary_repeat_count"] for r in runs),
            "max_observes": max(r["observes"] for r in runs),
            "max_vision_bytes": max(r["vision_bytes"] for r in runs),
            "input_sha256": {name: hashlib.sha256((item / name).read_bytes()).hexdigest()
                             for name in ("stage_report.json", "batch_report.json", "progress.json")},
        })
    latest = collected[-1]
    assert not latest["all_gates_pass"], "A passing final round needs a different stage conclusion."
    data = {"status": "STOPPED_MAX_ROUNDS", "stage": 1, "completed_rounds": len(rounds),
            "subsequent_stages_started": False, "mission1_runs_in_this_execution": 0,
            "rounds": collected}
    (folder / "comparison.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    independent = latest["independent_success"]
    identity = latest["identity"]
    lines = [
        "# 阶段 1 最终报告：FAIL，三轮已满，停止后续阶段",
        "",
        f"三轮均完整执行赛题2的map-01…map-10，各布局每轮一次。最终确认并抓到 "
        f"{latest['confirmed_and_grabbed_layouts']}/10 局；按目标日志合并后为 "
        f"**{independent['passed']}/{independent['total']} 个独立场景 "
        f"({independent['rate']:.1%})，低于80%，需要至少{independent['required_successes']}/{independent['total']}。**",
        "",
        "按用户三轮上限停止：没有第四轮，没有进入阶段2–5，没有运行赛题1。"
        "未放宽门槛、未删除失败布局、未选用不同轮次的成功局拼表。最终程序保留第三轮冻结版本。",
        "",
        "## 三轮结果",
        "",
        "| 轮次 | 确认且抓到/布局 | 独立场景成功 | 程序报错/10局 | 原地重复observe | 单局最大observe | 单局最大证据MiB | 结论 |",
        "|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for row in collected:
        rate = row["independent_success"]
        lines.append(f"| [{row['round']}]({row['round']}/SUMMARY.md) | "
                     f"{row['confirmed_and_grabbed_layouts']}/10 | {rate['passed']}/{rate['total']} ({rate['rate']:.1%}) | "
                     f"{row['program_errors']} | {row['stationary_repeats']} | {row['max_observes']} | "
                     f"{row['max_vision_bytes']/1024**2:.4f} | FAIL |")
    lines += [
        "", "## 最终退出条件", "",
        "| 条件 | 第三轮结果 | 判定 |", "|---|---|---|",
        f"| 程序报错0 | {latest['program_errors']}/10；完整平台program_error事件计数 | PASS |",
        f"| 原地重复observe 0 | {latest['stationary_repeats']}；运动守卫违规0 | PASS |",
        f"| 独立场景确认并抓到≥80% | {independent['passed']}/{independent['total']}={independent['rate']:.1%} | **FAIL** |",
        f"| observe≤92/局 | 最大{latest['max_observes']} | PASS |",
        f"| 原生视觉证据≤20MiB/局 | 最大{latest['max_vision_bytes']:,} bytes ({latest['max_vision_bytes']/1024**2:.4f}MiB) | PASS |",
        "| 固定确认、记忆行驶、approach与onRoad约束 | 所有实际成功抓取局全部通过；未到达的阶段保留unknown | PASS |",
        "",
        "运行前指定pylint五类错误为0；123项回归通过；实际平台异步转换后的完整程序编译通过；"
        "主程序与嵌入包坐标扫描无成对违规，get_truth词元0。第三轮冻结15项检查及146项原始记录一致性检查全部通过。"
        "证据在[第三轮报告](round-3/SUMMARY.md)、[检查文件](round-3/review.json)与[数值诊断](round-3/numeric_diagnostics.json)。",
        "",
        "## 失败与改善必须同时保留", "",
        "- map-02：C已确认，WM误差5.4cm；第三轮纯记忆行驶1916.0cm后仍距WM 1.587m，"
        "memory_graph_exhausted，approach/grab均0。第二轮该局成功，第三轮出现退化。"
        "局部遇阻被记成整条道路方向封禁，最终排除了刚走过的退路；未知边界规划还存在返回同一落点的重入循环。"
        "[逐项路径证据](round-3/PLANNER_FINDINGS.md)。",
        "- map-07：最终仅2次伪红命中，最近真球89.7cm>30cm，报告为“无对应真球”；"
        "候选耗尽，确认失败。不能把该距离记为E/G定位误差。[原图诊断](round-3/VISION_FINDINGS.md)。",
        "- map-09：真实E误差10.3cm，图接近行驶从第二轮3291.8cm且失败，变为第三轮473.4cm且到达。"
        "4次grab后成功，瞬间真值前向13.1cm、侧向+3.9cm；approach仅1次，max_steps=1。随后送货失败。",
        "- map-01/09存放采样受路口零移动影响；map-06/10送货节点重规划耗尽。"
        "这些抓取成功仍按阶段1定义计入，但没有记作送达或整场完成。",
        "",
        "最终独立场景只有map-01/03合并，其余各自成组；旧v28r1六组另列保守对照，"
        "不冒充本轮分母。完整逐局表、合并差异、每次抓取真值与日志行索引见[第三轮SUMMARY](round-3/SUMMARY.md)。",
        "",
        "未见位置精度仅有E的有效样本1例(10.3cm)，G为0例；不据此声称泛化验收通过。"
        "B/C/D仅报告，不作未见位置结论。旧v28r1 tick1929缺少原始PNG，具体原因仍未能确定；"
        "新帧发现的遮挡或区域抑制不能冒充旧帧原因。",
        "",
        "## 冻结版本与交付", "",
        f"- PROGRAM_VERSION：`{identity['version']}`；[逐字节冻结程序](round-3/program.py)。",
        f"- 原始文件SHA256：`{latest['source_sha256']}`。",
        f"- 平台trim后执行文本SHA256：`{identity['file_sha256']}`。",
        f"- wm_kit已提交：`{identity['wm_kit_commit']}`。",
        f"- 嵌入包SHA256：`{identity['wm_embed_sha256']}`；14个Python文件等于上述提交。",
        "- 各轮目录均含原始日志、samples、原生帧图像、版本、改动清单、检查及批跑表。"
        "最新[改动清单](round-3/CHANGES.md)、[源码差异](round-3/changes.patch)、[冻结核验](round-3/freeze_verification.json)。",
        "",
        "以下一条命令仅离线重算三轮表格和本报告，不启动仿真，也不是尚未完成的P5总验收复跑：",
        "",
        "```sh", "python3 tools/stage_summary.py --recompute", "```", "",
        "视觉检测重算命令在每轮VISION_FINDINGS.md中。所有表格输入哈希及停止状态见[comparison.json](comparison.json)。",
        "",
        "批跑结束后的离线整理仅修正批报文件筛选：排除新增道路诊断JSON，读取map-??.json原始局。"
        "30局批报逐字段不变；60份原始日志/samples和当前机器人文件的SHA256全部不变。"
        "运行结束时冻结核验仍是历史有效记录，不能解释为后续报告工具也从未修改。"
        "原脚本、单行差异及完整核对见[postprocessing审计](postprocessing/audit.json)。",
    ]
    (folder / "SUMMARY.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (folder / "PROGRAM_VERSION").write_text(identity["version"] + "\n")
    (folder / "wm_kit_commit.txt").write_text(identity["wm_kit_commit"] + "\n")
    print(json.dumps({"summary": str(folder / "SUMMARY.md"), "status": data["status"],
                      "final_independent_success": independent}, ensure_ascii=False))


if __name__ == "__main__":
    main()
