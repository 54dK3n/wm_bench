# 逐次 grab 授权审查

本轮 P0 已完成开发验证并 READY，停止本子任务源码与测试编辑，待根线程联合前置门。本报告只涉及公开合成传感输入、真实 Perception/官方冻结 WM、Actions、平台 normalizeCommand 与独立证据消费者；没有模型或正式仿真结果。

## 原缺口与修复

旧入口已拒绝 STALE，但接近和失败后再次前进一直使用第一次取出的 CONFIRMED 对象；mark_picked 只检查历史 confirmed_s。有效红测 `raw/grab/reproduction-final-red.txt` 为 6 failed / 2 passed：接近失效、重试失效、同帧竞争仍发 grab；回执和传感均未知时 pending 丢失；STALE 可借历史确认进入 HELD；正常链缺新增逐次授权字段。

Actions v26 每次实际 grab 紧邻命令重新授权：最新规范对象必须当前 CONFIRMED，完整同帧检测与已知身份双向唯一，夹爪明确空，沿用 22.5 cm / 3° 原门。Perception v14 保存不可变 `brain-grab-authorization/v1`，将原对象、当前 frame/tick/odometry、所有检测、竞争矩阵原索引、几何及精确 command_ref 放入原 `brain-grasp-chain/v1` 的 grab.authorization。授权本身不发命令，且一份物理命令授权只能消费一次。

非球地面区域投影失败仍保留原检测及矩阵空行，不导致 KeyError，也不移除任何可能竞争的球。新增真实顶端 storage raw 框、真实 WM 抓取链以及 runtime v18 独立审计正例已通过。

接近失效则冻结失败原帧，停止本次抓取；可沿本动作已连续测量的直线/转向安全回到记录视角，每段检查端点、方向、里程与弦长、当前前向余量。恢复失败不再另开通用回退动作。本次 pick 始终失败，不能回到旧视角就把 STALE 改为 CONFIRMED。新成功例使用之后真正分离 16 cm 的视角增加一个有效 WM hit，再发起新 pick 决策。

原抓取 intent 在命令前保留。未知回执不重发；完全没有原边界读回时保留 pending 并标连续性缺失，后续 place 也不得运动或释放。原命令具合法接收记录、新鲜连续 holding 和独立原位消失证据时，才可核实原抓取并执行 release。

## 可复算证据

`raw/grab/lifecycle-examples-final.json` 的 9 个场景，每个包含完整公开 observations、motions、bridge、rounds、summary.action_evidence 和独立 audit，明确 runtime v18。所有 9 个审计结果 failures=0；拒绝例无非法 pick/place 账本。关键实际命令边界：正常抓取 o9→o10；失败后仍确认重试 o9→o10 与 o11→o12；安全恢复后新决策 o23→o24；未知回执有读回 o9→o10；全无读回保留 o9→o9，后续拒绝 release。

导出入口支持独立源码目录和 create-only 新文件：

```sh
python3 artifacts/autonomous-brain/grab-sampling-contract-20260927/scripts/export_grab_examples.py --repo SOURCE_ROOT --output NEW_FILE.json
```

开发旧 `lifecycle-examples.json` 保留原源码 SHA；最终导出不覆盖旧输出。`raw/grab/SUMMARY.md` 保存完整 15 文件回归命令；`raw/grab/ready-regression.txt` 为 330 passed / 0 failed / 0 skipped，其中本轮新增 18 项。旧 fixture 只在 `tests/test_brain_actions.py` 明确补 round=1，无生产假轮次默认。初次 bbox 合成夹具越界和一次错误测试文件名的失败原日志同样保留，没有作为正式验收门。

## 源码与限制

开发基线：`10e3c879d2499d6f893151f24857c315f12fe2e7`。

| 源码 | 基线 SHA256 | READY SHA256 |
| --- | --- | --- |
| autonomous_brain/actions.py | `e1db744904888533a48119b1485f0f09f16f09880ced82ebf95e17ffb6437cf1` | `804c0ce9d93e7d2df842beab47bcb76eab7666e9230b289050371b9c0886c725` |
| autonomous_brain/perception.py | `0205a1ee99d3a2c565406020dd762fb9b62af2a1c0c34a1df007bfcb905dbdea` | `47f2249baeb61fa4e4ae6458f7268c7b0d2bf3dadb020ecf1ab93583f06094f0` |
| tools/brain_evidence_audit.py | `595000b19e886182c538234372865a5606ee96f2a89cfd5de2ad045f743c1c93` | `bc7507957d7212c56211b4de426a6260763d72237b4375cf4503d650608e103b` |

仅本次 pick 记录的连续安全路径可自动恢复；不补造更早路径。无完整读回连续链则保持待核实，尚无通用缺帧恢复器。低层无命令生命周期测试接口仅保留当前真实 CONFIRMED，正式运行必须有实际命令链和独立原帧审计。旧 r34 STALE 历史抓取不得因新版变为合法；历史审计由独立审计子任务记录。

这些组件测试和审计不证明正式任务成功，也不替代根线程统一门；本轮未发起正式局。

根线程统一冻结后使用新输出 `raw/gate/grab-frozen-candidate.json`；`scripts/export_grab_examples.py` 是可交付入口，开发原 `raw/grab/export_grab_examples.py` 保留不动。两个入口除默认源码根相对层级外同逻辑。
