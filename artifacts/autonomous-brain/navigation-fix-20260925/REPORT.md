# 首局失败后的导航修复与回归记录

本记录结论：修复已实施，回归测试通过；真实首局仍为 **FAIL**。首局运行 40 轮，最终有效送达 0 个，不能算成功。第二局已启动，大脑与 driver 源码冻结；本记录不评价第二局结果，也不将单测通过替代真实任务验收。

所有路径均相对仓库根目录。

## 首局证据

- 离线失败报告：`artifacts/autonomous-brain/map05-run-01/report/REPORT.md`
- 首局评测数据：`artifacts/autonomous-brain/map05-run-01/map-05-run-1/evaluation.json`
- 首局大脑总结：`artifacts/autonomous-brain/map05-run-01/map-05-run-1/brain/summary.json`

首局共有 40 次大模型调用、176 次观测、17 次失败动作，仿真用时 100.88 秒；大脑状态为 `failed`，终止原因是 `BridgeError: odometry: NOT_RUNNING`。离线报告独立核对有效交付事件和最终存放区位置，最终有效送达为 0；此结果不以 driver 的成功布尔值替代。报告中的真值仅用于离线评测，本次修复未向大脑输入真值、地图或道路 ID。

首局暴露了三类导航问题：路口动作可能在 25cm 内直接从一个节点到另一个节点，出口记忆却依赖中间出现 `atNode=false`；短距离或零距离到达路口被当成阻塞并后退；阻塞后的直线后退未沿弯道返回，随后出现离路动作。模型还多次在非路口传入出口角度，或混用历史绝对朝向与当前相对出口。

## 已实施修复

| 文件 | 当前版本 | 行为变化 |
|---|---|---|
| `autonomous_brain/actions.py` | `autonomous-brain-actions/v4` | 及时识别路口到达，包括短距离和零距离返回；道路阻塞时转向并沿已观测道路有界返回；已经离路时停止，不继续盲目恢复。 |
| `autonomous_brain/navigation.py` | `autonomous-brain-navigation/v2` | 使用已观测节点的里程计位置确认跨节点完成，无需中间非节点帧；逆向出口匹配最近实际移动段，弯道、原地转向和重复位置帧均不引入未观测全局信息。 |
| `autonomous_brain/llm.py` | `autonomous-brain-llm/v4` | 提示只在当前路口从当前相对出口中原样选择 `exit_angle`；旧记录回放恢复记录中的系统提示，以保持请求一致性。 |

对应测试文件：`tests/test_brain_actions.py`、`tests/test_brain_navigation.py`、`tests/test_brain_llm.py`。六个文件的当前 SHA256 见 `artifacts/autonomous-brain/navigation-fix-20260925/SHA256SUMS`。

## 验证结果与来源

主任务在本报告生成前刚执行以下检查，向报告编写任务提供了命令及实测输出摘要；本报告编写任务没有重新运行这些检查，也没有单独保存其完整标准输出。

- `python3 -m pytest tests/test_brain_actions.py tests/test_brain_perception.py tests/test_brain_llm.py tests/test_brain_evaluation.py tests/test_brain_navigation.py -q`：`163 passed in 0.24s`，退出码 0。
- `node --test tools/tests/test_autonomous_brain_config.js`：tests 3 / pass 3 / fail 0，42.451333ms，退出码 0。
- `git diff --check`：退出码 0。

新增回归覆盖直接节点到节点完成、同节点原地转向不误完成、弯道逆向出口匹配、重复帧保持移动方向、近路口与零距离路口、弯道阻塞返回、离路停止，以及旧系统提示的精确回放。机器可读检查摘要及执行来源保存在 `artifacts/autonomous-brain/navigation-fix-20260925/validation.json`。

## 确认和抓放门槛

报告编写任务只读核对了当前源码与首局记录/版本库差异。`autonomous_brain/perception.py`、`autonomous_brain/bridge.py`、`autonomous_brain/run.py` 的 SHA256 与首局记录完全一致。`ball_inside_region`、`Actions.go_to`、`Actions.pick`、`Actions.place`、`Actions.done` 的语法树与 Git HEAD 一致；actions 仅新增 `return_from_blocked_road` 并修改 `explore`。因此，本轮没有降低或修改物体确认、抓取、放置和最终完成证据门槛。

本记录只新增报告文件，未修改冻结的大脑或 driver 源码，未读取 `.env`，未提交版本库。首局 40 轮、0 送达仍是失败；修复后的真实表现必须由后续完整运行及离线评测决定。
