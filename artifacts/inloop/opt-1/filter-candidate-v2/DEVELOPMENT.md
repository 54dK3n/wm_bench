# Filter v2 开发证据（测试已污染）

v1 测试误杀反馈影响了本次规则选型；后续同测试集结果仅为回归检查，不是独立泛化测试。此复算只读取原标定采集和 v28r1 开发数据。

仅在原 WM 合法原始距离窗口 **40≤d<90cm** 内应用原置信度门：红<0.84、蓝<0.80。窗外、封顶、距离/置信度缺失或非有限时保留并记录弃权原因。40/90 为原合同复用，.84/.80 不变；没有新增拟合阈值或布局/坐标分支。

v1 源码及专属单测已原样归档到 filter-candidate-v1/runtime_filter.py 与 test_detection_filter.py。旧单测的距离无关合同改为窗口内过滤，新增边界和弃权用例；原确认窗口与机器人调用未改。

|类别|真例保留|已标误杀|已标过滤precision|过滤unknown|额外保留known false / unknown|
|---|---:|---:|---:|---:|---:|
|red|121/121|0/121|3/3|1|8 / 16|
|blue|111/111|0/111|23/23|9|45 / 20|

过滤总数36：26条已标伪检测、10条unknown。红precision分母仅3，不宜作强结论。若被过滤unknown全是真例，则红/蓝precision分别最低3/4=75%、23/32=71.875%；unknown不能冒充伪检测。

开发集里 v1 没有已标真例误杀，所以开发证据不能声称v2改善已标误杀率；它只证实窗外存在真实目标及证据不足、并量化弃权的过滤代价。

以下每组均用完整类别轨迹（首末相关帧之间含空帧）归一，相同既有3cm/2°/confidence .05/tick2容差逐对比较，三对均不等价；另保留实际观察位姿与几何差值。不以布局名或单点读数计独立性。

- window_false_red: calib_runs_v6/attempt-02.json lines[91], tick 8733, d=87cm, bearing=0.55°, confidence=0.81; calib_runs_v6/attempt-08.json lines[77], tick 5049, d=43cm, bearing=-34.25°, confidence=0.83; v28r1_batch/map-09.json lines[87], tick 4302, d=67cm, bearing=-13.13°, confidence=0.81
- window_false_blue: calib_runs_v6/attempt-03.json lines[3], tick 6, d=82cm, bearing=-2.62°, confidence=0.79; calib_runs_v6/attempt-05.json lines[56], tick 3773, d=58cm, bearing=25.24°, confidence=0.74; calib_runs_v6/attempt-08.json lines[37], tick 2503, d=73cm, bearing=20.33°, confidence=0.76
- outside_true_red: calib_runs_v6/attempt-02.json lines[13], tick 1076, d=100cm, bearing=-17.49°, confidence=0.89; calib_runs_v6/attempt-03.json lines[87], tick 8679, d=100cm, bearing=-1.52°, confidence=0.85; calib_runs_v6/attempt-08.json lines[20], tick 1881, d=100cm, bearing=25.81°, confidence=0.85
- outside_true_blue: calib_runs_v2/attempt-01.json lines[5], tick 44, d=35cm, bearing=-31.53°, confidence=0.8; calib_runs_v6/attempt-03.json lines[74], tick 7453, d=100cm, bearing=28.32°, confidence=0.85; calib_runs_v6/attempt-08.json lines[58], tick 3648, d=100cm, bearing=36.36°, confidence=0.9

所有完整轨迹、原始行、真值绑定、pairwise比较及计数在 constant_provenance.json；评测原输出在 dev_evaluation.json。

复算（不启动仿真、不读测试）：
```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest programs.tests.test_detection_filter -v
PYTHONDONTWRITEBYTECODE=1 python3 tools/detection_evaluation.py --dataset dev --filter-file programs/detection_filter.py --out artifacts/inloop/opt-1/filter-candidate-v2
PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-1/filter-candidate-v2/reproduce_provenance.py
```
