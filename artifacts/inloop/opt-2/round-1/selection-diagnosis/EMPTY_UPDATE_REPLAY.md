# 空观测桥接的保存轨迹回放

范围：只重放公开observe原始数据、odo、timestamp、target_observations中实际fed选择及已验证holding后的mark_removed；没有加载控制器、场景或真值。调用冻结程序原有标定函数和提交326a5f8892b9da11996b5f3d3d0fc56341aca6e4的WM实现。源SHA和每帧前后对象都在JSON。

opt2-r1及opt1-r2共20局，原桥接重现67个WM快照，逐值差异0。原20次确认，所有bridge帧无条件更新仅保留15次；仅无eligible red的帧补空更新保留20次。

eligible red以真实target_observations.seen为准：此时置信过滤、调用方类别过滤及成功送达区域排除已经执行；窗外和封顶的未排除红仍计seen。只在原_update_wm调用点补更新，不额外创造observe、不改非空检测融合。

|批次/布局|原确认日志L/tick|无条件更新|无eligible red才空更新|
|---|---|---|---|
|opt-2/round-1/map-01|L295/t2146|False|confirmed, hit=3, conf=0.893900|
|opt-2/round-1/map-02|L759/t3258|True|confirmed, hit=3, conf=0.889700|
|opt-2/round-1/map-03|L295/t2146|False|confirmed, hit=3, conf=0.893900|
|opt-2/round-1/map-04|L280/t2648|True|confirmed, hit=3, conf=0.912200|
|opt-2/round-1/map-05|L322/t2846|True|confirmed, hit=3, conf=0.898200|
|opt-2/round-1/map-05|L2908/t12973|True|confirmed, hit=3, conf=0.924200|
|opt-2/round-1/map-06|L533/t2920|True|confirmed, hit=3, conf=0.886300|
|opt-2/round-1/map-08|L322/t2846|True|confirmed, hit=3, conf=0.892100|
|opt-2/round-1/map-09|L879/t4464|True|confirmed, hit=3, conf=0.890800|
|opt-2/round-1/map-10|L466/t2447|True|confirmed, hit=3, conf=0.887900|
|opt-2/round-1/map-10|L1208/t13749|True|confirmed, hit=3, conf=0.937000|
|opt-1/round-2/map-01|L292/t2146|False|confirmed, hit=3, conf=0.893900|
|opt-1/round-2/map-02|L756/t3258|True|confirmed, hit=3, conf=0.889700|
|opt-1/round-2/map-03|L292/t2146|False|confirmed, hit=3, conf=0.893900|
|opt-1/round-2/map-04|L277/t2648|True|confirmed, hit=3, conf=0.912200|
|opt-1/round-2/map-05|L319/t2846|True|confirmed, hit=3, conf=0.898200|
|opt-1/round-2/map-06|L530/t2920|True|confirmed, hit=3, conf=0.886300|
|opt-1/round-2/map-08|L319/t2846|True|confirmed, hit=3, conf=0.892100|
|opt-1/round-2/map-09|L961/t4489|False|confirmed, hit=3, conf=0.890800|
|opt-1/round-2/map-10|L463/t2447|True|confirmed, hit=3, conf=0.887900|

实际回归反例：opt2 01/03 L230 tick2056 raw=93cm/0.69°/.83，WM已2hit且confidence .903，上次更新tick857；旧body FOV判断visible，若误喂empty，在23.98秒间隔按1.5秒半衰期降到1.3906618888768367e-5并归档。opt1-r2 01/03对应L227。opt1-r2 09 L359 tick3680为100cm/−9.83°/.85，若把此封顶方位当miss则confidence .10921255139620113/LOST。窗外红保护必要，不能仅以fed==0补空更新。

保护模式仍按既有DecayConfig/FovConfig计算，不新增常数：body范围.15–.9m、水平75.2°，可见漏检半衰1.5秒，视野外60秒。该body域与M5反算raw 40–90cm不等同；不能把窗外观测宣称没有看见。原生WM在非空帧仍对未关联轨迹执行同一衰减，未改动。

|批次/布局|保护模式新增/重现的LOST|此前→之后confidence|该次raw红|
|---|---|---|---|
|opt-2/round-1/map-04|L1316/t9463 target_002|0.752795673→0.022462520|[{"category": "target", "distanceCm": 59, "bearingDeg": 35.27, "confidence": 0.92}]|
|opt-2/round-1/map-04|L2087/t9825 target_003|0.309148612→0.032420252|[{"category": "target", "distanceCm": 42, "bearingDeg": 2.07, "confidence": 0.93}]|
|opt-2/round-1/map-06|L1647/t10335 target_002|0.752795673→0.022462520|[{"category": "target", "distanceCm": 59, "bearingDeg": 35.27, "confidence": 0.92}]|
|opt-2/round-1/map-06|L2563/t10697 target_003|0.309148612→0.032420252|[{"category": "target", "distanceCm": 42, "bearingDeg": 2.07, "confidence": 0.93}]|
|opt-2/round-1/map-07|L7387/t13712 target_001|0.840000000→0.003984077|[]|

04/06 target002的LOST原本就在另一个tentative target003入库时发生；单加空更新不会修复旧ID锁死。需要只在锁定对象真正LOST时解除当前确认ID/accepted_hits，保留归档历史与已测道路几何。target003在原桥接此后无fed更新而保留；保护模式在04 t9825、06 t10697归档。07的未确认false target001在t13712归档。

已送达红排除之后对其他对象的漏检评估：这轮26条排除中23条严格对应已送达球、0条对应剩余球；因此当前记录没有把真剩余球误当missing的证据。独立几何对应见diagnosis.json。不能据此泛化为任意释放半径/遮挡均可靠，也不建议扩大排除半径。

固定轨迹局限：保留20次确认仅说明相同公开输入序列下，保护桥接未打断其WM三命中。返回巡逻、清锁及释放ray会改变后续动作和输入；并未离线“证明下一局成功”。尤其成功05曾空红后继续capped ray，提前退出会改变其第二球路径，须按既定轮次整局验证。

复算：`PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-1/selection-diagnosis/replay_empty_updates.py`。L均为raw.lines零基索引。
