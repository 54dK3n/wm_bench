# wm_bench

WorldModel × 广阳岛机器人仿真：运行程序、视点规划、双球流程、评测工具与实验报告。

当前执行 **v4 自主观测闭环**：平台只提供传感器和执行器，大脑在平台外运行。旧五阶段、比赛计分和比赛专用规则已作废，旧程序与结果仅作历史参考。2026-09-25 复核发现阶段 1 的机器人桥过滤了仿真物体检测，当前阶段门禁为 **FAIL / STOP**；后续阶段未实施或验收，尚无 v4 map-05 成功局。

## 阅读入口

- [当前 v4 执行状态](docs/NEXT_WORK_STATE.md)
- [v4 平台实现与阶段门禁](docs/V4_AUTONOMOUS_LOOP.md)
- [阶段 1 复核失败证据](artifacts/inloop/v4/stage-1/review-20260925/REPORT.md)
- [WorldModel 回流结果及 PR](artifacts/worldmodel-return/SUMMARY.md)
- [重构第 1 轮：未通过及视觉输入差异](artifacts/inloop/refactor/SUMMARY.md)
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

源码、报告、小型评测数据、冻结程序和 WorldModel Git bundle 纳入版本控制。系统/测试缓存、虚拟环境、安装依赖和凭据由 `.gitignore` 排除。大型原始证据留在本机，没有删除；demo 关键帧直接入库。本次 C 第 1 轮及其 opt-2 round-3 对照证据另以可校验压缩包入库，包含日志、record、samples 和全部帧；其他旧轮次仍依照本地证据清单管理。

新 clone 恢复本次 C 比较所需原始证据（原字节不改，已有不同文件会拒绝覆盖）：

```sh
python3 tools/package_refactor_evidence.py --restore
```

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

下列为历史 Pyodide 程序的复现入口，不是 v4 大脑或当前执行计划；旧门限只解释历史结果。

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

重构须与 `artifacts/inloop/opt-2/round-3/` 原生 inputs/events 和得分相等，最多三轮。第 1 轮已运行完毕且未通过：inputs 0/10、events 5/10、得分 8/10 相等；当前暂停，未进入 opt-2b。上面的 `round-1` 是已完成证据目录，运行器拒绝覆盖或重跑已执行的布局。旧 `run_opt2_batch.py`、`opt2_preflight.py` 等入口保留为历史工具，当前工作以新入口为准。冻结程序、旧轮次和成功证据不得覆盖。

已保存证据的只读核验：

```sh
python3 tools/repository_evidence.py --check
```

原项目来源与版权状态见 [VENDOR.md](docs/VENDOR.md)。未替原有代码添加或变更许可证。
