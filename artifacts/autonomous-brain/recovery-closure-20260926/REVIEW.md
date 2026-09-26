# 六项恢复闭环修复入口

本轮从远端 `3ad444d03fc077e3d6215a2cf7165be1af2a7e5c` 开始。六项基线缺口均由公开传感器或纯合成配置输入复现；开发红测试允许修复迭代。正式验收状态和冻结提交以本目录 `REPORT.md`、`METRICS.json` 为准，本文不把离线测试当作正式任务 PASS。

| 问题 | 基线 | 修改与正反对照入口 |
| --- | --- | --- |
| 1 普通未入库红框漏记 | 存在 | `autonomous_brain/perception.py` 对全部红框保留原始发现；`run.py` 提供有界待验证摘要；`task.py` 检查未知数量任务当前和历史发现。`tests/test_brain_recovery_discovery.py` 使用真实 Perception、Runtime、done，覆盖近/远/饱和距离、重复帧、同帧竞争与已知两球语义。 |
| 2 发现和路口疑点没有恢复出口 | 存在 | 发现保留 source、hypothesis、canonical resolution、support/opposition 与撤销历史；确认门槛不变。`road_evidence.py` 在完整路线重访后修正历史 provisional 根及 anchor、exit、trip、candidate 引用，保留旧记录。发现和道路的独立消费者见 `tools/brain_evidence_audit.py`、`tools/brain_topology_audit.py`。 |
| 3 物理归路与地图重连不一致 | 存在 | `actions.py::return_place_path` 与 RoadMemory 联动保留入口和 excursion；先上路不再意味着地图重连。原 `.2cm/.2°` 门保持，沿有证据的安全原路径完成连接；partial、未知执行、夹爪变化和无安全路线仍停止并保留义务。 |
| 4 小于 10cm 的非法 follow_road 与提前消费 | 存在 | `actions.py::_follow_approach_path` 按实测累计弧长消费路段，保留连续合并窗口跨命令的剩余行程。短段只在连续无未处理路口时合并，或由直线历史和新鲜安全观测支持合法基础运动，否则有界停止。`tests/test_brain_route_contract.py` 每个运动命令实际调用冻结平台 `normalizeCommand`。 |
| 5 跨动作抓取确认被审计误拒绝 | 存在 | 动作日志显式连接 grab 命令、身份确认窗口、连续 holding 和 release。评测器独立查询原 bridge/motion/observation/round，不把任意 place 或 holding=True 当成抓取。`tests/test_brain_pending_grasp_audit.py` 覆盖正常、延迟、未知回执恢复和伪造/中断反例。 |
| 6 模型地址异常原值进入日志 | 存在（纯合成反例） | `llm.py` 和 driver 在机器人启动前验证地址结构；Request 构造进入受控边界，固定错误码不会保留原异常 cause/context。`tests/test_brain_model_endpoint_safety.py` 禁用网络、使用纯合成 marker，覆盖真实 run.main 的全部日志消费者及正常严格回放。此发现不证明历史真实配置曾泄露。 |

## 证据含义

- 发现不等于确认；确认不等于有效交付。原 WorldModel 三个相互分离位点、15cm 位点间距、关联竞争规则均保持。
- 物理 onRoad 与地图重连分别记录；归路不能清除仍未解释的路口身份。
- 候选生成、到达候选、复走历史行程、通过新视觉 25–40cm 接近判据分别记录。累计行程不作为净位移。
- grab、身份确认和 release 可以发生在不同动作窗口，但必须有明确命令引用和连续、新鲜的 holding 证据。未知执行不能盲目重发。
- 未知数量任务保留全图出口义务、目标发现义务、空夹爪和模型主动 done；独立统计仍按运行前的完整地图口径计算自建路口数/真实节点数 ≤1.2。
- 历史阶段 1 的 111 轮/115 次模型记录严格离线回放只是转录一致性检查；固定传感输入诊断也不证明新代码能够完成新闭环。

## 边界与不变项

平台方法及响应字段白名单仍由冻结 `robot-bridge-contract.js` 显式构造；不因合法方法名而暴露新字段。平台源码和 WorldModel 依赖以 SHA256 逐文件核验。真实布局、节点和物体身份仅用于运行结束后的独立评测。模型仍为 DeepSeek Flash、temperature=0、thinking=disabled；200 轮/1200 仿真秒上限保持。不运行十布局或真机。

所有原始日志只在本轮 Release 证据包。本目录摘要和复算入口使用仓库相对路径；原历史两份证据包与报告保持原字节和原结论。
