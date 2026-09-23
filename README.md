# wm_bench

WorldModel × 广阳岛机器人仿真：运行程序、视点规划、双球流程、评测工具与实验报告。

当前保留的是实验结束时的真实状态：最小双球 demo 已成功；阶段 2 三轮用尽后停止，最终双球送达 2/10，未达到 8/10。阶段 3–4 未执行，赛题 1 未运行。阶段 1 的过滤测试集污染限制仍有效。本仓库不代表总验收通过。

## 阅读入口

- [v3 全阶段状态](artifacts/inloop/V3_FINAL_STATUS.md)
- [双球 demo](artifacts/inloop/demo/DEMO.md)
- [阶段 1 报告](artifacts/inloop/opt-1/SUMMARY.md)
- [阶段 2 最终报告](artifacts/inloop/opt-2/SUMMARY.md)
- [最终逐球表](artifacts/inloop/opt-2/round-3/BALL_TABLE.md)
- [最终冻结程序](artifacts/inloop/opt-2/round-3/program.py) / [实际执行字节](artifacts/inloop/opt-2/round-3/executed_program.py)

## 目录与 Git 管理

| 路径 | 内容 |
|---|---|
| `programs/` | 机器人程序、规划/抓取/送货片段、检测过滤器及单测 |
| `tools/` | 构建、驱动、预检、评测、诊断和报告工具 |
| `vendor/wm_kit_opt2/` | WorldModel 源码快照，按普通文件管理，不是子模块 |
| `artifacts/` | 实验报告、校准数据、评测输入、冻结源码与版本证据 |
| `docs/` | 数据保留策略、WorldModel 来源、本地大证据清单 |
| 根目录旧脚本 | 历史验收入口，依赖外部旧版 wm_kit，见下方限制 |

源码、报告、小型评测数据、冻结程序和 WorldModel Git bundle 纳入版本控制。系统/测试缓存、虚拟环境、安装依赖和凭据由 `.gitignore` 排除。大型 PNG、完整 record、samples、终端副本留在本机，没有删除；仅 demo 的关键帧作为小型展示文件直接入库。

被排除的实验文件不是缓存，也没有自动上传到其他存储。其相对路径、大小和 SHA256 见 [本地证据清单](docs/local-evidence-manifest.json)；恢复和核验方法见 [数据保留说明](docs/DATA_POLICY.md)。没有恢复这些文件时，部分历史报告的图片/原始证据链接与真实回放测试不可用。

`.gitattributes` 禁用换行转换，以保留历史程序和证据文件的原始 SHA256。不要格式化、重写或在已完成轮次目录中重新运行会覆盖报告的命令；新实验使用新目录。

## 本地检查

Python 工具以 Python 3.9.6 验证，部分离线统计用 NumPy；预检用 pytest、pylint。可以在独立虚拟环境安装开发依赖：

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
(cd vendor/wm_kit_opt2 && python -m pytest tests -q)
python -m pytest programs/tests/test_detection_filter.py -q
```

上述单测不启动仿真。完整驱动还需要独立的 `robot_competition-main/projects/car-python` 平台、浏览器及 Node.js；当前实验使用 Node.js 26.7.0。平台项目不包含在本仓库中。

当前驱动、测试及历史清单仍有本机绝对路径。`GUANGYANG_PLATFORM_ROOT` 只覆盖部分入口；迁移到另一台机器前需要配置/适配路径并恢复真实回放数据。本仓库尚不能宣称干净环境一条命令完成全部仿真复跑。根目录 `run.py`、`eval_inloop.py`、`mutate.py` 还依赖外部旧 wm_kit 中未随本仓库提供的 acceptance/planning/selection 模块，不作为默认安装检查。

## 重新构建与运行的入口

下列是供后续开发使用的入口，**不是继续已停止阶段的授权**。构建应写入临时目录并设置新版本，不覆盖冻结程序。

`embed_world_model.py` 从独立 WorldModel Git 历史读取指定提交；普通 vendor 源码目录在新 clone 中没有独立 Git 历史。先从保存的 bundle 恢复：

```sh
git clone artifacts/inloop/opt-2/wm-kit-action-evidence/wm_kit_opt2.bundle /tmp/wm-kit-rebuild
git -C /tmp/wm-kit-rebuild checkout --detach 326a5f8892b9da11996b5f3d3d0fc56341aca6e4
python tools/build_opt2_program.py \
  --calibration artifacts/inloop/opt-2/controlled-calibration/calibration.json \
  --version wm-local-review \
  --wm-src /tmp/wm-kit-rebuild \
  --out /tmp/wm-local-review.py
```

预检入口为 `tools/opt2_preflight.py --program ... --out ...`，需先满足平台/路径/数据依赖。`tools/run_opt2_batch.py` 会真正运行十布局批次，仅在决定开展新实验后调用。`tools/opt2_report.py` 会写回汇总报告，应在证据副本或新输出目录使用。

已保存证据的只读核验：

```sh
python3 tools/repository_evidence.py --check
```

原项目来源与版权状态见 [VENDOR.md](docs/VENDOR.md)。未替原有代码添加或变更许可证。
