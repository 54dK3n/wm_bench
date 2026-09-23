# 检测过滤候选 v1（仅开发集）

规则：红色 confidence <0.84、蓝色 confidence <0.80 才过滤；相等保留。只读取公开 category/confidence，原始观测不变，不查询机器人，不计算100cm点位，不改变确认窗口。缺失或非有限 confidence 保留为未知。模块未整合主程序。

先复算旧baseline：1153条全部保留、0过滤；filter precision为null，不得写100%。类别路由及WM窗口均另列、不冒充过滤。

| 类别 | 已标真实 | 已标伪检测 | unknown | 已标误杀 | 已标过滤precision | 过滤已标伪检测 | 过滤unknown | 已标覆盖率 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 红 | 121 | 33 | 152 | 0/121 | 100.0% | 11 | 17 | 50.33% |
| 蓝 | 111 | 491 | 245 | 0/111 | 100.0% | 68 | 29 | 71.07% |

以上误杀/precision仅适用于已有标签。若被过滤unknown全是真例，则红/蓝precision最低分别为11/28=39.29%、68/97=70.10%；不能把已标子集通过当作完整测试通过。100cm按用户指定机械标签参与评测，但runtime仅按confidence决定，不把100当精确距离。

阈值取各类已标真例的最低confidence：红0.84有两条真例保留，蓝0.80有三条真例保留。没有提高robot.observe请求门；集成时应在完整raw日志之后运行本模块，再执行原有调用者筛选。

独立证据采用完整相关类别轨迹，从首次出现到最后出现，去除绝对tick/布局和ID，保留检测序列；与现有stage_report.compare相同容差（3cm、2°、confidence 0.05、相对tick 2）。没有以三张图名称或三个孤立读数替代独立场景。

| 常数 | 独立开发序列 | 帧数 / 检测数 / tick跨度 | 已标伪检测支撑（raw行从0起） |
|---|---|---|---|
| target 0.84 | artifacts/inloop/calib_runs_v6/attempt-02.json | 62 / 9 / 8452 | lines[91], d=87cm β=0.55° c=0.81 |
| target 0.84 | artifacts/inloop/calib_runs_v6/attempt-08.json | 71 / 29 / 6435 | lines[77], d=43cm β=-34.25° c=0.83 |
| target 0.84 | artifacts/inloop/v28r1_batch/map-09.json | 23 / 27 / 961 | lines[87], d=67cm β=-13.13° c=0.81 |

target 比较 attempt-02.json ↔ attempt-08.json：equivalent=false，96处超容差/序列结构差异。全部归一轨迹与逐项差异保存在 constant_provenance.json。

target 比较 attempt-02.json ↔ map-09.json：equivalent=false，41处超容差/序列结构差异。全部归一轨迹与逐项差异保存在 constant_provenance.json。

target 比较 attempt-08.json ↔ map-09.json：equivalent=false，60处超容差/序列结构差异。全部归一轨迹与逐项差异保存在 constant_provenance.json。

| 常数 | 独立开发序列 | 帧数 / 检测数 / tick跨度 | 已标伪检测支撑（raw行从0起） |
|---|---|---|---|
| distractor 0.8 | artifacts/inloop/calib_runs/try-1.json | 25 / 21 / 2330 | lines[17], d=32cm β=-13.53° c=0.77 |
| distractor 0.8 | artifacts/inloop/calib_runs_v6/attempt-08.json | 75 / 135 / 7448 | lines[20], d=34cm β=16.1° c=0.79 |
| distractor 0.8 | artifacts/inloop/calib_runs_v6/attempt-05.json | 81 / 82 / 7487 | lines[56], d=58cm β=25.24° c=0.74 |

distractor 比较 try-1.json ↔ attempt-08.json：equivalent=false，66处超容差/序列结构差异。全部归一轨迹与逐项差异保存在 constant_provenance.json。

distractor 比较 try-1.json ↔ attempt-05.json：equivalent=false，65处超容差/序列结构差异。全部归一轨迹与逐项差异保存在 constant_provenance.json。

distractor 比较 attempt-08.json ↔ attempt-05.json：equivalent=false，263处超容差/序列结构差异。全部归一轨迹与逐项差异保存在 constant_provenance.json。

高置信度伪检测保留：红22/33、蓝423/491仍存活；这是一条保守低置信度抑制规则，不声称解决所有伪检测。未读取封存测试集；未运行仿真。

开发复跑：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest programs.tests.test_detection_filter -v
PYTHONDONTWRITEBYTECODE=1 python3 tools/detection_evaluation.py --dataset dev --filter-file programs/detection_filter.py --out artifacts/inloop/opt-1/filter-candidate-v1
PYTHONDONTWRITEBYTECODE=1 python3 tools/detection_filter_development.py
```

规则SHA256：`fe953d2e4f63db981e5eea33ff95dbedf524ed8f9a965046c12b830479c43659`；冻结UTC：`2026-09-23T13:31:38.582537+00:00`。测试解封仍由root授权，候选冻结文件不含评测器哈希，因此不能单独解封测试。

平台直接调用顶层 `detection_filter_update(observations, odometry=None, road_state=None, tick=None)`；离线 `DetectionFilter.update` 仅委托同一函数，6项单测通过。该入口调整不改变规则或任何开发集决策。
