# wm_bench

WorldModel × 广阳岛机器人仿真：运行程序、视点规划、双球流程、评测工具与实验报告。

最小双球 demo 已成功；旧 opt-2 三轮结束，最终双球送达 2/10，未达到 8/10。当前按新任务执行 demo 整理 → WorldModel 回流 → 行为不变重构 → opt-2b 优化；进度见下方执行状态。旧阶段 3–4 未执行，赛题 1 未运行，过滤测试集污染限制仍有效。本仓库不代表总验收通过。

## 阅读入口

- [当前 A–D 执行状态](docs/NEXT_WORK_STATE.md)
- [WorldModel 回流结果及 PR](artifacts/worldmodel-return/SUMMARY.md)
- [v3 全阶段状态](artifacts/inloop/V3_FINAL_STATUS.md)
- [双球 demo](artifacts/inloop/demo/DEMO.md)
- [阶段 1 报告](artifacts/inloop/opt-1/SUMMARY.md)
- [阶段 2 最终报告](artifacts/inloop/opt-2/SUMMARY.md)
- [最终逐球表](artifacts/inloop/opt-2/round-3/BALL_TABLE.md)
- [最终冻结程序](artifacts/inloop/opt-2/round-3/program.py) / [实际执行字节](artifacts/inloop/opt-2/round-3/executed_program.py)

## 目录与 Git 管理

| 路径 | 内容 |
|---|---|
| `programs/src/` | 按模块组织的唯一运行源码；固定顺序拼接构建 |
| `programs/world_model_opt2.py` | 当前唯一生成程序；历史生成程序位于 artifacts |
| `programs/tests/` | 当前模块及明确冻结的历史回归测试 |
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

当前构建和重构运行入口使用仓库相对路径；平台位置必须通过 `GUANGYANG_PLATFORM_ROOT` 提供。历史清单中的原始路径保持不动，由当前工具解析到本仓库；迁移到另一台机器前仍须恢复真实回放数据。本仓库尚不能宣称干净环境一条命令完成全部仿真复跑。根目录 `run.py`、`eval_inloop.py`、`mutate.py` 还依赖外部旧 wm_kit 中未随本仓库提供的 acceptance/planning/selection 模块，不作为默认安装检查。

## 重新构建与运行的入口

在仓库根目录执行；将平台环境变量设为本机独立平台目录。构建直接使用已锁定的 vendor 快照，不依赖嵌套 Git 或修改旧程序正文。

```sh
export GUANGYANG_PLATFORM_ROOT="../robot_competition-main/projects/car-python"
python3 tools/verify_worldmodel_vendor.py
python3 tools/build_opt2_program.py \
  --calibration artifacts/inloop/opt-2/controlled-calibration/calibration.json \
  --version wm-local-review \
  --out programs/world_model_opt2.py
python3 tools/refactor_preflight.py \
  --program programs/world_model_opt2.py --out artifacts/inloop/refactor/local-preflight
```

预检包含真实平台 worker 启动、无重名函数、指定 pylint 错误码与布局坐标检查。以下入口会真正运行十布局；每轮运行中不改源码，同一布局只执行一次，新轮次使用新目录。

```sh
python3 tools/run_refactor_batch.py \
  --program programs/world_model_opt2.py --out artifacts/inloop/refactor/round-1
python3 tools/compare_refactor_records.py --candidate artifacts/inloop/refactor/round-1
```

重构须与 `artifacts/inloop/opt-2/round-3/` 原生 inputs/events 和得分相等，最多三轮。旧 `run_opt2_batch.py`、`opt2_preflight.py` 等入口保留为历史工具，当前工作以新入口为准。冻结程序、旧轮次和成功证据不得覆盖。

已保存证据的只读核验：

```sh
python3 tools/repository_evidence.py --check
```

原项目来源与版权状态见 [VENDOR.md](docs/VENDOR.md)。未替原有代码添加或变更许可证。
