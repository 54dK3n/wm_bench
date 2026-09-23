# P3.1 转向成本标定：BLOCKED

**不发布可运行 k。** 仅使用已保存公开控制 inputs；不使用场景真值，不启动仿真。

已审查 23 份完整真实运行记录；合格道路控制 1397 条，排除 1763 条，原地turn_angle辅助 448 条。历史 42 份raw没有完整inputs，不能据samples补造控制时序。

|范围/请求速度|合格样本|100cm完整直行|90°道路出口|180°道路出口|≥3重复非零转角组|诊断k(cm/°)|最大残差|>10%数|
|---|---:|---:|---:|---:|---:|---:|---:|---:|
|opt1_round2 / speed=100;obey=True|151|0|0|111|7|0.056866|13.78%|10|
|opt1_round2 / speed=30;obey=True|362|0|10|4|11|0.054295|48.49%|13|
|opt1_round1 / speed=100;obey=True|151|0|0|111|7|0.056866|13.78%|10|
|opt1_round1 / speed=30;obey=True|361|0|10|4|11|0.055146|48.49%|14|
|all_saved_full_records / speed=100;obey=True|333|0|0|223|12|0.059096|22.88%|35|
|all_saved_full_records / speed=30;obey=True|1064|0|25|11|29|0.055319|49.12%|44|

表中 k 全为诊断拟合，不能作为正式标定值。所有符合固定资格的样本均进入对应速度层，无按残差删除。误差定义为 |预测ticks−实测ticks|/实测ticks；原要求≤10%没有放宽。

- No saved full record contains even one follow_road(maxCm=100) request; >=3 complete 100cm straight controls required.
- No speed stratum meets both all required repeat groups and <=10% residual for all fixed eligible samples; no runtime k is authorized.

资格预先由类型、速度、stopreason和精确公开里程计决定：follow仅max_distance、take_exit仅entered_road，动作起止tick精确绑定，排除混入其它控制。转角使用公开heading最短角差，角度分组仅用原公开exits.turnDeg，不将87.7°四舍五入成90°。速度30和100分层，不择优选层通过。

100cm缺失不能由十次10cm控制或纯turn_angle补足。净heading角只反映端点姿态，不声称获得曲线内总转角。道路限速和控制器开销可能使单k不足，残差照实报告。

最小补采方案（仅提案，本工具未运行）：
- Use one frozen public road-control speed/obeySpeedLimit setting throughout each stratum.
- Locate an available straight segment using public graph/road_state only, with more than 100cm before the next node and sufficient clearance; issue one follow_road(100,speed,obey) per repeat, three accepted max_distance completions.
- At legal nodes choose exits using public road_state.exits. For prescribed 45/90/180deg groups, log and perform a preparation rotation equal to current public exit turnDeg minus desired turnDeg; refetch road_state to verify the public requested turn before take_exit. Perform three repetitions per group, with entered_road and exact public odometry before/after.
- Mark preparation vs measured controls before execution; preserve every preparation command and every failed measurement in the logs. Pure alignment turns are not measured take_exit repetitions. Do not regroup or drop any eligible measurement after looking at residuals.
- Record complete inputs, start/end public odometry, selected public exit turnDeg, elapsedTicks, distanceCm, speed and stoppedBy. Preserve all fixed-eligible controls including poor residuals.
- Fit all prequalified controls; if per-observation residual still exceeds10%, report model failure rather than adopt a scalar k. No experiment was started by this tool.

全部实测样本行索引/seq、公开里程计起止、逐样本残差见 calibration.json；严格公开字段投影见 public_control_inputs.json。

复跑：`PYTHONDONTWRITEBYTECODE=1 python3 tools/p3_turn_calibration.py`


任何非负k能否同时达到10%的可行性审查：
- r2 speed=100;obey=True: False；必要k区间[0.14310745985695011, -0.001351571249437546]。这是全样本约束，不只检查最小二乘解。
- r2 speed=30;obey=True: False；必要k区间[62.69113149846256, -220.3389830509205]。这是全样本约束，不只检查最小二乘解。
  同一distance=10cm、turn=1.4°：55ticks（attempt-002.record.json inputs[61], seq249）与112ticks（attempt-013.record.json inputs[631], seq2981）。任何只用这两特征的预测至少有34.13%最大相对残差。

必需协议子集（r2 speed30，全部公开请求45/90/180°完整出口控制，不按误差删样本）：
共17条；OLS k=0.04642827仅作诊断，最大残差10.856%，1条超过10%。协议子集存在可满足10%的非负参数区间，不应据全角域失败声称它也数学不可行；但本次固定OLS解未达门，且缺100cm×3，不发布k。

|公开请求角|实际净角|实测距离cm|elapsedTicks|源inputs索引/seq|
|---:|---:|---:|---:|---|
|45|45.0|36.3|231|attempt-001.record.json inputs[109], seq640|
|45|45.0|40.6|255|attempt-005.record.json inputs[190], seq973|
|45|45.0|36.3|231|attempt-015.record.json inputs[109], seq640|
|90|90.8|25|163|attempt-001.record.json inputs[16], seq50|
|90|90.8|25|163|attempt-002.record.json inputs[16], seq50|
|90|90.8|25|163|attempt-003.record.json inputs[16], seq50|
|90|90.8|25|163|attempt-005.record.json inputs[16], seq50|
|90|90.8|25|163|attempt-009.record.json inputs[16], seq50|
|90|90.8|25|163|attempt-010.record.json inputs[16], seq51|
|90|90.8|25|163|attempt-011.record.json inputs[16], seq50|
|90|90.8|25|163|attempt-013.record.json inputs[16], seq50|
|90|90.8|25|163|attempt-015.record.json inputs[16], seq50|
|90|90.8|25|163|attempt-029.record.json inputs[16], seq50|
|180|172.9|31.3|232|attempt-002.record.json inputs[73], seq334|
|180|149.4|24.2|203|attempt-003.record.json inputs[267], seq1352|
|180|172.9|31.3|232|attempt-011.record.json inputs[73], seq334|
|180|169.4|25|195|attempt-013.record.json inputs[673], seq3199|

名义出口90°的实际净角均90.8°；180°名义组实际149.4–172.9°。由公开里程计如实报告，不将道路控制内弯道变向误记成纯90/180原地转向。