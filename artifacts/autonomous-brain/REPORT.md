# WorldModel + 外部单动作大模型：本轮交付

平台够用门禁 **PASS**，外部大脑及评测代码已实现。**正式 map-05 自主双球验收未执行，尚无成功局；十布局未运行。** 当前运行环境缺少 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，已请求配置文件位置或环境配置；没有使用假模型替代正式验收。

本轮按最新任务范围执行，octos 编排、技能契约和逐条 record 确定性对照暂缓。旧 v4 的严格 FAIL、空检测验收作废结论与所有历史证据不变。

## 平台

平台分支：`v4/robot-backend`，提交 `54b36f82109836226cf654e9a676ddf0c3b07cd0`。仓库为 `54dK3n/wm_bench`。本轮沿用已修复的桥，不再修改平台源码：红球、蓝球、障碍保留 `virtual-cv`，绿色区域保留 `storage-ground-pixels`。接口文档位于该分支的 `projects/car-python/docs/robot-backend-bridge.md`。

两次新运行使用真实平台与机器人桥，固定执行 `explore → look_around`；模型端是本机固定诊断桩。它们验证平台输入输出，不代表自主任务成功。

| 检查 | 结果 |
|---|---|
| 桥与内部检测器逐条一致 | 20/20 次 observe，100% |
| 四类检测总数 | 红球 2、蓝球 6、障碍 68、存放区 4；每局四类均非零 |
| 两次检测比较，仅报告 | 10/10 对相同 |
| 指定距离窗的应见/检出，仅报告 | 红球 0/0、蓝球 0/0、障碍 0/0；短路线未覆盖该窗口 |

原始记录、独立转换口径、SHA256 和复算入口见 `artifacts/autonomous-brain/fresh-map05-gate-20260925/REPORT.md`。两个运行的脑源码版本有差异，固定动作脚本和平台版本相同；此结果不声称整个大脑的确定性，范围见同目录 `SOURCE_SCOPE.md`。

另对冻结平台的历史长路线作只读复算：386 次 observe 全部一致，红球/蓝球/障碍应见与检出分别为 12/8、10/10、24/20；193 对检测相同。它不是本轮新增仿真，也不改写旧严格 FAIL，见 `artifacts/autonomous-brain/platform-gate-20260925/REPORT.md`。

## 外部大脑和检查

大脑分支为 `codex/autonomous-brain`，代码位于 `autonomous_brain/`。入口和配置见 `docs/AUTONOMOUS_BRAIN.md`。

- WorldModel 官方 main 已通过远程查询确认提交 `fef0ba9b754ce9652836fdb720d1162dcadbc5ef`；vendor 的 50 个锁定文件校验通过。显式使用广阳岛静态配置及 `max_range_m=0.9`，M5 参数不变。
- 模型每轮只选一个动作，温度为 0，JSON 不合法只修复一次；所有调用输入、响应、耗时及协议异常写入日志。回放严格匹配请求，不调用模型网络接口。
- 执行器只访问桥白名单。观测、里程计、道路、夹爪进入 WM 和日志；真值、布局、record 仅由独立评测进程持有。`go_to`、`pick` 的初始对象必须 CONFIRMED。
- 修正已确认物体的近距重见被误当漏检的问题：仅双向唯一关联时刷新可见时间，不增加命中、不改置信度和估计位置。最终抓取接近使用已确认位置与里程计约束，保留每步观测和最多三次尝试。
- 仿真上限 1200 秒、每局 200 轮；达到上限判失败。只有独立 record 与最终真值同时证实 map-05 两个红球交付，且脑正常完成，才允许十布局批跑。

最终单测 **99 项通过**，输出、命令、依赖版本、最终源码 SHA256 见 `artifacts/autonomous-brain/validation-final-20260925/validation.json`。最终动作版本为 v3；它比 `transport-smoke-03` 的 v2 多修了一处小于桥最小 0.1cm 指令的边界问题，由针对单测验证。诊断没有执行抓放，不能据此声明抓放已通过。

`transport-smoke-03` 的真实桥诊断为 **23/23 检查通过**：2 个执行动作、4 次假模型响应、10 次非空观测、仿真 6.18 秒，越权调用 0。第三轮输出经一次修复仍非法，按预期停止。离线回放消费全部 4 条记录，禁止联网，动作和错误精确相同。原始证据及复算见 `artifacts/autonomous-brain/transport-smoke-03/DIAGNOSTIC.md` 和其 `replay-diagnostic/DIAGNOSTIC.md`。这些数字只属于诊断，真实模型调用仍为 0。

感知离线回放见 `artifacts/autonomous-brain/perception-replay/v4-map05-run1/REPORT.md`：167/167 红蓝原生测距及方位重建一致；193 帧中 105 帧具有同 tick 里程计，88 帧没有，未用真值补齐。此轨迹未触发近距刷新，新行为由语义测试验证。

## 正式验收尚缺什么

| 用户要求的正式 map-05 指标 | 本轮状态 |
|---|---|
| 两红球交付与最终真值核对 | 未执行，无成功证据 |
| 总轮数、真实模型调用与耗时、仿真用时 | 未执行，不能引用诊断值充当任务成绩 |
| 各球首次看到、确认、抓到、送达时间线 | 评测器已实现，尚无正式局 |
| WorldModel 位置误差 | 目前评测范围为已确认红球；尚无正式样本，无样本不记为零误差 |
| 失败动作及逐轮完整日志 | 记录器已实现，当前仅有诊断日志 |
| 十布局结果 | 尚未达到运行前提，未运行 |

当前实现仍有需要实跑验证的限制：place 使用绿色 bbox 的几何包含估计，并非逐像素区域证明；未验证的释放保持 `RELEASED_UNVERIFIED`，尚无完整身份恢复路径。这些情况不会被改判为成功。审查及明确 FAIL 的诊断评测见 `artifacts/autonomous-brain/review-20260925.md`。

配置三个 LLM 环境变量后，下一步运行：

```sh
node tools/autonomous_brain_driver.js --out artifacts/autonomous-brain/map05-run-01
```

该输出目录尚未使用。运行后必须独立评测并处理真实失败；只有正式成功后才进入十布局。全部交付文件摘要见 `artifacts/autonomous-brain/SHA256SUMS`，不包含该摘要文件自身。
