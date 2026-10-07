# wm_bench

## 当前结果：2026-10-08，ChatGPT 真实双球两局 FAIL

本轮仍在 map-05 做“把两个红球送到绿色存放区”，沿用公共传感、同一 Runtime / vendored WorldModel、既有 `octos_robots.Executor` 和原 Actions。使用 ChatGPT 登录态 `codex-app-server`，实际模型 `gpt-6.1-sol` / reasoning low；这些计数是原生推理调用，底层 HTTP 次数没有独立观测。原 200 轮 / 1200 仿真秒上限保留。

代码保留 `fcda1eafc4928f9b76bc1a6ac547c56f1ef396a3` 的净空停车定位前缀。`552a2259b7a4879427c24d65d4477b2b5ff335ae` 补齐本地 native 配置字段、总超时检查和同 thread/turn 的模型改路拒绝；loader 的环境优先和字面值解析保持。改路事件按[官方 app-server 协议](https://learn.chatgpt.com/docs/app-server)绑定身份，原事件留存。真实 smoke 取得一个合法 `look_around`，调用 1 次，机器人动作 0。

| 独立运行 | 冻结源码 | 原生调用 / 合法决策 | 物理运动命令 | grab / release / 交付 | 主动 done | 仿真秒 | driver / evaluator | 双球结果 |
|---|---|---:|---:|---|---|---:|---|---|
| run-20261007T224158 | `552a2259b7a4879427c24d65d4477b2b5ff335ae` | 200 / 200 | 851 | 0 / 0 / 0 | 否 | 628.4 | 1 / 1 | FAIL，200 轮 |
| run-20261007T234008 | `3bed25dd11859f798ac83c614b855265fad5d264` | 201 / 200 | 477 | 0 / 0 / 0 | 否 | 713.8 | 1 / 1 | FAIL，200 轮 |

首局的合格净空停车保持了定位链，仍未计成成功遍历。r67 实际执行 `take_exit` 40.6cm 和 `follow_road` 20cm 后，下一次正向运动被预发送拒绝；末段从路中出发，原返回查询无法使用连续的两段来路。整轮已经行驶 60.6cm，只有被拒绝的下一动作没有发送。

据此做了本轮唯一一次针对性小修 `3bed25dd11859f798ac83c614b855265fad5d264`：返回查询可核验最多四段连续道路前缀，要求共享观测端点、已知回执、实测里程/tick、新帧、夹持不变、反向边与版本相符且未受阻；返回预算取实际里程。原正向障碍和执行前安全复查保持，不重发预拒绝动作，不把停止点直接并入旧路口。真实 r67 公共输入的组件回归从“无支持”变为 60.6cm 返回预算；这条组件结果没有执行机器人。

复测 r116 实际触发两段返回：obs480→481→482 的实测来路为 31.4cm + 20cm，正向预拒绝仍保留。`brain-002181` 转向（obs482→483），`brain-002186` 前行 20cm（obs483→484），`brain-002191` 前行 9.4cm（obs484→485）后遇到观测路口并停止。空夹爪、仍在路上；原锚点 `junction-242` 与返回端 `junction-246` 的语义关系仍为 `junction_identity_unresolved`，没有新增完成遍历。实际返回 29.4cm，不能据此宣称回到原锚点。公共来路几何支持已被使用，语义重连仍未解决；持球归路、首球交付和第二球均未进入验证。

复测最早的反复采样限制出现在 r7；首次搬运接近阻塞为 r43 / obs172，`target_040` 的一个检测同时匹配 `target_010/013/032/040`，`approach_started=false`。r46、r52 再次拒绝；本局共 18 次身份竞争拒绝、28 次无安全独立视角。另有 26 次路口身份未决；r186 到存放区的几何路线耗尽独立保留，不能统一归因于节点标签。r43 当时提供了需新观测复查的沿路采样候选，r116 返回后提供了三个实际观测出口；它们到目标的连通性仍未知。下一步应先用这些公共检测、采样轨迹和节点证据定位身份关联的最小缺口，再决定是否需要修复。当前没有可证明的安全抓取或回到原语义锚点方案。

复测第 61 次原生调用收到 `turn/completed: failed` / `serverOverloaded`，被回执校验拒绝；既有客户端随后发起一次真实推理修复调用并成功，仅分发合法新决策。两局 transport error 均 0；复测 validation rejection 为 1。没有切换模型、固定动作或未知运动重发。

直接相关 Python 回归 **139 passed**，配置 loader 测试 **12 passed**；持续通知总超时和迟到成功采用受控时钟/队列，子进程协议测试采用合成 peer，均不充当真实模型证据。原四项既有安全回归失败仍独立保留，未放宽断言。两局 15 个运行源码文件前后相符，实际加载依赖核验通过，五类物理导出完整；严格记录回放一致不代表搬运成功。

实际平台版本 `54b36f82109836226cf654e9a676ddf0c3b07cd0`；Executor `33af31baefc9b3beaa855f33849d52254aaa8c4b`；WorldModel 源码树 SHA256 `10895f70be67c9d70b1073256d7e264451934c8d025a11a82128bb7ad956cd7c`。两局各自冻结 manifest，没有运行中替换依赖。一次小修和一次复测额度已用完，200 轮后停止，无第三局；历史单球 PASS 和旧双球 FAIL 原件保留。

[独立指标与 r116 公共命令证据](artifacts/autonomous-brain/clearance-prefix-live/METRICS.json) · [首局原评测](artifacts/autonomous-brain/clearance-prefix-live/run-20261007T224158-evaluation/REPORT.md) · [复测原评测](artifacts/autonomous-brain/clearance-prefix-live/run-20261007T234008-evaluation/REPORT.md)。原始日志及物理数据保存在本机 `artifacts/autonomous-brain/clearance-prefix-live/run-20261007T224158/`、`run-20261007T234008/`；本次提交包含简明指标和原评测报告，完整原始数据未上传。

## 2026-09-30 历史结果（原文保留）

> 最新结果：同driver环境的网络检查与真实流式模型smoke已通过。之后两局真实双球均FAIL：基线交付1球；小修75fe359验证局抓到首球但未释放，r55净空停止后路口身份/路线连接未恢复，200轮停止。两局driver/evaluator均exit1，原始物理导出完整。已停止，无第三局；历史两次一球PASS保留。 [本轮报告、指标与证据](artifacts/autonomous-brain/two-ball-model-ready-next/after-network-restore/REPORT.md)。

## 上一轮历史：运行中监控恢复已修复，当时双球受模型连接阻断

冻结 `e54ad6106123770880f407c82d2d3b9b2e75c5cd` 实跑一局，r1 的6次既有模型请求尝试均在连接建立阶段被重置（ConnectionResetError / errno54），有效回复0、分发0、grab/release/交付/done均0。驱动exit1；初次evaluator因空响应异常退出1，单独修复 `4cf908e4afe6134a9619dfa9a119fc0c5caa06f9` 后在新目录复算双球FAIL/exit1。五类原始物理导出完整，未改原件；网络重置根因UNKNOWN，没有无修改重跑。

运行中恢复最多一次/8秒、原运行和控制器身份核验、暂停新桥命令并只核对原在途请求；真实Chrome/子进程受控测试通过。本局未出现CDP故障，恢复和持球运输均NOT_EXERCISED，不能据测试宣称双球已通过。依赖、模型、预算及安全门保持；历史两次一球PASS和旧FAIL保留。已停止，下一阻塞为本机到官方模型服务的HTTPS连接被重置。

[本轮报告与复算](artifacts/autonomous-brain/two-ball-monitor-next/REPORT.md) · [指标](artifacts/autonomous-brain/two-ball-monitor-next/METRICS.json)。

## 上一轮历史：双球运输修复后，两局真实 FAIL

本轮两局真实双球均 **FAIL**，已经停止，无第三局。运输约束修复 `6e09544fa23d5b2546eb64743a4f4a372f3f1520`；第二局冻结 `ae35f9c8e8f0a6f34cce49d0b6fd91b2f905b4d9`，只追加一次原页面导出重连。两局各32次模型 started / 31次完整回复，31次 Executor dispatch、124观测、558桥请求；pick/grab/release/DELIVERED/done均0。r32因驱动CDP连接中断被SIGTERM停止，未耗尽200轮/1200秒；断连底层原因UNKNOWN。

第二局成功重连健康原页面，五类物理数据完整导出，独立双球评测交付0、FAIL，driver/evaluator均exit 1。第一局仍缺物理原件。空载受阻记忆与模型选择替代出口实际触发；持球运输、实际重复段拒绝/绑定、第二目标操作后采样均NOT_EXERCISED，不能宣称已实测消除旧运输阻塞。两次历史一球PASS与所有旧FAIL保持，不启动阶段2、十布局或真机。

[本轮报告、实际命令与恢复/复算](artifacts/autonomous-brain/two-ball-transport-next/REPORT.md) · [指标](artifacts/autonomous-brain/two-ball-transport-next/METRICS.json)。

## 上一轮历史：真实双球开发基线 FAIL，已停止

map-05 的“把两个红球送到绿色存放区”已真实运行并独立评测 FAIL，driver/evaluator 均 exit 1。73 次真实模型调用、73 次 Executor dispatch / 72 次 judge、349 次观测；高层 pick 2、grab 4，观测抓持成功 1，release / 脑端 DELIVERED / 模型 done 均 0。首球持物后的存放路线重复受净空阻塞，r73 turn 和恢复 odometry 均收到 409 BRIDGE_CLOSED，未知结果未重发。

冻结 `d6c107f197a1845f8cc1ba66a413512f9a1c5b71`，生产文件与上一轮 c4bf08e 相同。record/captures/envelope 等导出失败，物理两球身份、物理交付数及平台 run ID 无法独立核验，不能把缺失当作真值 0。控制器关闭根因未知。首球未交付，交付后第二球采样窗口未实施、未实测；不将它写成本局终因。未做推测性小修或第二局，阶段 2、十布局、真机未启动。

[本轮报告、实际命令及恢复/复算](artifacts/autonomous-brain/two-ball-demo-next/REPORT.md) · [原始日志 Release](https://github.com/54dK3n/wm_bench/releases/tag/two-ball-baseline-20260927-d6c107f)。此前两次一球 PASS 保留，不据此推算成功率。

## 上一轮历史：两处小修后，一次真实一球回归 PASS

冻结 `c4bf08e1114363ddff3c0f5bce7cdcb1c041af27` 在 map-05 完成“把一个红球送到绿色存放区”：67 次真实 DeepSeek Flash 调用、67 轮、268.82 仿真秒，高层 pick 2 次、实际 grab 4 次、有效交付 1 颗。物理、脑端 DELIVERED、独立观测命令链均为 1，r67 模型主动 done，夹爪空，白名单外调用 0。独立一球 PASS；driver 固定双球 false/exit 1 保留，双球阶段 1 **NOT_RUN**。

复用既有 `octos_robots.Executor`（`33af31baefc9b3beaa855f33849d52254aaa8c4b`）、同一 WorldModel 和原平台；外部 Octos runtime 未接入。两修保留 CONFIRMED 身份采样候选并在截断前筛选指定对象，以及锁定失败当帧竞争上下文；原阈值、白名单和预算不变。r32 实际采样 31cm、增加 2 hit，旧身份竞争仍未消解；新 pick 上下文锁与 pick 离路逆归路本局未触发。上一成功基线原件和离线复算 PASS 保留。只运行本局后停止，后续阶段均未启动。

[一页结果与实际命令](artifacts/autonomous-brain/one-ball-review-next/REPORT.md) · [复算指标](artifacts/autonomous-brain/one-ball-review-next/METRICS.json) · [恢复/校验](artifacts/autonomous-brain/one-ball-review-next/RESTORE.md) · [原日志与 delivered-frame300.png](https://github.com/54dK3n/wm_bench/releases/tag/one-ball-review-20260927-c4bf08e)。

## 上一成功基线：2adc8ae 一球 PASS，原文保留

map-05 的“把一个红球送到绿色存放区”已真实完成：平台传感 → 同一 WorldModel → DeepSeek Flash → 既有 `octos_robots.orchestrator.executor.Executor` → Actions → 新观测；外部 Octos runtime 未接入。76 次真实模型调用、76 轮、299.7 仿真秒，物理交付、脑端 DELIVERED、独立观测命令链均为 1；模型主动 done、夹爪空、白名单外请求 0。独立一球评测 PASS；原 driver 固定双球结果仍为 false，不能将本局算作双球阶段 1。

冻结主仓 `2adc8aecc085c2f99f14131f1f2c10e7b109021e`、编排 `33af31baefc9b3beaa855f33849d52254aaa8c4b`，本局源码未变。模型保持 DeepSeek Flash / temperature=0 / thinking=disabled，Executor 不叠加重试，原安全门不变。模型另选唯一可见目标完成搬运；原另一目标身份竞争未解决，本局也未证明离路 pick 逆归路成功。仅运行这一局后停止，不启动双球、阶段 2、十布局或真机。

[一页结果与真实启动命令](artifacts/autonomous-brain/octos-minimal-demo-next/REPORT.md) · [可复算指标](artifacts/autonomous-brain/octos-minimal-demo-next/METRICS.json) · [恢复/校验](artifacts/autonomous-brain/octos-minimal-demo-next/RESTORE.md) · [原始证据与关键帧 Release](https://github.com/54dK3n/wm_bench/releases/tag/octos-one-ball-pass-20260927-2adc8ae)。

## 上一轮历史：真实编排已接通，搬运 demo 尚未完成

已在真实 map-05 上运行“平台传感 → 同一 WorldModel → DeepSeek Flash → 既有 Executor → Actions → 新观测”。复用 [octos_robots](https://github.com/54dK3n/octos_robots) 的框架无关 `orchestrator.executor.Executor`，不是外部 Octos runtime；平台模式 `max_retries=0`，原感知、动作、安全门和完成判据保留。

**两局一球开发 demo 均 FAIL，原双球阶段 1 NOT_RUN。** 真实模型请求分别 65、67 次，均为 DeepSeek Flash / temperature=0 / thinking=disabled；没有实际 grab/release、交付或主动 done。一次小修补齐身份竞争失败反馈后，第二局真实换位仍受身份竞争和离路恢复阻断，现已停止，没有第三局、阶段 2、十布局或真机。

[本轮一页报告与启动命令](artifacts/autonomous-brain/octos-live-demo-20260927/REPORT.md) · [恢复与复算](artifacts/autonomous-brain/octos-live-demo-20260927/RESTORE.md) · [原始证据 Release](https://github.com/54dK3n/wm_bench/releases/tag/octos-live-demo-20260927-c351695)。冻结源码为 `c351695f8c878e0923159d6be60d293d3c77979b`，编排源码为 `33af31baefc9b3beaa855f33849d52254aaa8c4b`。历史 PASS / FAIL 和原证据均不覆盖。

## 历史说明：2026-09-25 外部单动作大脑

以下保留当时描述；其中 Kimi 配置、Octos 暂缓和“下一局”编号不代表本轮状态。

WorldModel × 广阳岛机器人仿真：运行程序、视点规划、双球流程、评测工具与实验报告。

当前执行 **WorldModel + 外部单动作大模型自主小车**：平台提供传感器和执行器，大脑每轮观测、决策、行动、再观测。octos 编排、技能契约和逐条确定性门禁暂缓。平台的桥检测一致性与四类非空门禁已通过；外部大脑、M5 感知、模型记录回放和独立评测已实现。

Kimi 已配置为用户批准的 K2.6 非思考模式、温度 0.6，密钥只留在本机。前十三局均未通过双球验收，见[真实运行记录](artifacts/autonomous-brain/LIVE_RUNS.md)。第十三局完成58轮、69次模型调用、365次观测，独立交付0/2；源码和完整导出校验、模型离线回放通过。已确认身份归档后不能重获，使完成义务永久待处理；现加入保留历史的新确认轨迹关联，门限不变，485项离线测试通过，见[修复证据](artifacts/autonomous-brain/reacquisition-fix-20260925/REPORT.md)。下一正式运行目录为 `map05-run-14`。**尚无本轮 map-05 成功局，十布局未运行**。

旧 v4 严格验收的 FAIL、空检测验收作废结论及全部历史证据保留原样；本轮新的够用门禁不改写旧结果。

## 阅读入口

- [当前执行状态](docs/NEXT_WORK_STATE.md)
- [真实模型运行记录](artifacts/autonomous-brain/LIVE_RUNS.md)
- [本轮交付进度](artifacts/autonomous-brain/CURRENT_REPORT.md)
- [初版交付报告（历史）](artifacts/autonomous-brain/REPORT.md)
- [外部大脑运行与回放](docs/AUTONOMOUS_BRAIN.md)
- [新运行的平台够用门禁](artifacts/autonomous-brain/fresh-map05-gate-20260925/REPORT.md)
- [历史长路线的只读复算](artifacts/autonomous-brain/platform-gate-20260925/REPORT.md)
- [v4 平台实现与阶段门禁](docs/V4_AUTONOMOUS_LOOP.md)
- [阶段 1 恢复验收报告](artifacts/inloop/v4/stage-1/restore-20260925/REPORT.md)
- [内容验收口径与复算](docs/V4_STAGE1_ACCEPTANCE_RULES.md)
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
| `autonomous_brain/` | 当前外部大脑：单动作模型决策、WorldModel、传感器闭环动作 |
| `programs/src/` | 按模块组织的唯一运行源码；固定顺序拼接构建 |
| `programs/world_model_opt2.py` | 历史 Pyodide 路线的生成程序；不作为当前外部大脑 |
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
