# 2026-10-08：位置证据与真实双球结果

目标：map-05 原平台同一局交付两颗不同红球，模型主动 done。起点 `bb86e65df28e5667769ddd3791313a7c1f0253f9` 与远端相符；未提交文件、旧一球 PASS 和全部旧 FAIL/ERROR 原件保留。

生产提交 **`4d813db4c0adcca9adb2cd8f9fbe437c02189143`**：Perception v17 / Runtime v19 明确标注宽度/M5 位置为近似估计，保存均值及双向原像素一致性结果，向真实模型提供精简信息。WM 数值、关联、rivals、LOST、道路与抓放门限未改。位置证据的表述已修补；几何身份恢复和合法抓取尚未解决。

| 完整源码公共复算 | 接受帧 | 跨视角失败 | WM 均值水平残差，px |
|---|---|---:|---|
| 原 target_040 | 161/169/170 | 3/3 对 | −10.29/+7.57/+7.43 |
| 上一局 target_042 | 134/135/143/144/149 | 10/10 对 | −5.01/−2.87/+5.42/+4.53/+10.08 |

两组均值精确复现；另有 10 个公开样本的位置重建和本帧逆投影通过。现有水平容差约 1.536px，未扩大。WM 接受了 2.49–9.55cm 的关联代价，原像素证明仍失败。图像留白偏移、单位、航向符号可以复现。冻结平台渲染箱体，测距使用固定宽度代理；可信离线固定箱体投影与最新五帧边界最大差约 1.16px，支持外形假设不匹配。原 RGB 未找到，遮挡、截断、颜色分裂仍未知。离线场景信息未进入模型，未用于拟合坐标或合并身份。

**独立实跑 `run-20261008T063502Z`：双球 FAIL。** 固定 `codex-app-server / gpt-6.1-sol / low`：200 次 started、200 个正常终态、200 个合法决策，传输失败 0；底层 HTTP 次数不可见。运动 482 次（take_exit 96、turn 185、follow_road 193、forward 7、backward 1），公共观测 882 次。**grab/release/HELD/DELIVERED/done 均为 0**，末帧夹爪为空。200 轮停止，仿真 752.46 秒，墙钟 3887.61 秒；**driver=1、evaluator=1**。15 个源码文件核验通过，五类物理导出完整，严格记录复算通过；搬运未通过。70 项直接相关回归通过，未跑全仓、未改旧失败断言。

首个接近阻塞：r33 / obs141→142，`target_041` 检测匹配 `target_018/023/041`，接近未开始，恢复选项不可执行。完整真实后路复算不能支持 16/20/21/25/32cm 后退；原 r44/obs175 与上一局 obs155 也不支持所提中转，未增加中转逻辑。4cm 分支本局触发三次，均核验运动；上一局“未触发”保留。r29 `brain-000545` / obs120→121 实测 4.0025cm，未增加命中；r69 `brain-001505` / obs328→329 实测 4.0608cm，随后原像素不兼容。抓放与交付未发生。

下一步须验证 virtual-CV 的可靠观测几何，取得当前目标的排他身份证明。该阻塞点没有已证明可执行的取景恢复动作；其它道路到目标的安全连通性未知。本轮缺少证据充分的下一处安全小修，停止，未开第二局。

实际平台 `54b36f82109836226cf654e9a676ddf0c3b07cd0`；Executor `33af31baefc9b3beaa855f33849d52254aaa8c4b`；WM 源码树 SHA256 `10895f70be67c9d70b1073256d7e264451934c8d025a11a82128bb7ad956cd7c`。实际解释器与依赖清单在本机 `run-20261008T063502Z.source.json`；完整原件在本目录同名运行文件夹。原评测在 `run-20261008T063502Z-evaluation/evaluation.json`，退出码在 `run-20261008T063502Z-exit-codes.json`。

[指标](METRICS.json) · [关联边](association-edges.json) · [首次阻塞公共片段](live-first-identity-blocker.json) · [公共夹具](../../../tests/fixtures/identity_view_consistency_public.json) · [回归](frozen-component-tests.txt)。[复算入口](recompute_public.py)：`PYTHONPATH=vendor/wm_kit_opt2:. python3 artifacts/autonomous-brain/identity-view-consistency-next/recompute_public.py`；比赛及独立评测命令：[run_once.sh](run_once.sh)。
