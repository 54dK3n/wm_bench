# v26 在环运行摘要（2026-09-23，测距标定）

- 程序：`programs/world_model_target_delivery.py`，`PROGRAM_VERSION = wm-memory-v26-20260923`，SHA256 见 `program.sha256`
- 有效日志：`attempt-2.json`（map-03）、`attempt-2.samples.json`、`attempt-2.verify.json`（`tools/verify_grab.py` 输出）
- `startup-error-1.*`：平台启动即报 `composite delivery delivery-target-storage guangyang-target-2 is missing from the interaction definition`，
  程序一行未执行（同一错误在标定采集时也出现在 map-07 / map-10，属平台间歇性问题，重跑即过）。
- 送货段代码与 v25 逐字节相同（`diff` 核对 `_delivery_event`…`clear_distractor` 与主流程尾部）。

## 验收（全部通过）

| 项 | 要求 | v25 | v26 |
|---|---|---|---|
| WM 目标与真球距离 | ≤ 5 cm | 13.0 | **4.39** |
| grab 瞬间真值前向 | 7–15 cm | 16.1 | **14.56** |
| grab 瞬间真值侧向 | ≤ 4 cm | 1.1 | **0.60** |
| 第一次 grab 即成功 | 是 | 否（4 次 far） | **是**（0 次失败） |
| approach 调用 | ≤ 3（上限 3） | 5（上限 12） | **1** |
| mission | ≥ 1/13 | 1/13 | **1/13**（score 43.1，package_delivered） |

余量偏薄：WM 误差离上限 0.6 cm，grab 前向离上限 0.4 cm。原因是 map-03 这颗球的读数仍比修正值偏短约 4 cm
（与标定集中"逐球系统偏差"同类，见下）。没有按 map-03 真值去调 `GRAB_STANDOFF_M`——那等于在测试集上调参。

三次确认命中（原始读数 → 修正后 → 与真球距离）：

```text
44cm @ +30.21°  →  58.0cm @ +27.65°   误差 4.69cm   （v25：18.8）
73cm @  +0.14°  →  81.1cm @  +0.13°   误差 0.15cm   （v25： 8.0）
87cm @  -4.13°  →  95.6cm @  -3.91°   误差 4.41cm   （v25：13.0）
```

## 标定

- 采集程序：`programs/calib_range.py`（calib-range-v6；不抓不送，驶向每个红/蓝球锚点，道路两端各来一次，
  10cm 小步 + 原地方位扫描 0/±16/±30°，observe 前静置 0.12 s，每行记 tick/里程计/全部红蓝读数）。
- 真值：`tools/inloop_driver.js` 按 tick 从 `record.samples` 取车体位姿（同 tick 场景位姿换算成里程计，
  与程序读数核对，位置差 ≤0.5cm、航向差 ≤0.5°，否则剔除），对每个读数取同类包裹中投影最近者，
  写 `<out>.calib.json`。方位约定右为正（与 `observe().bearingDeg` 同号）。
  注：用户给出的 v25 真值方位 "−29.7°" 是反号约定；按平台 `(cos h, −sin h)` 为右，同一帧真值为 +27.2°。
- 数据：map-09、map-01、map-07、map-05、map-06、map-08、map-04（不含 map-03）；
  文件见 `artifacts/inloop/calib_runs*/…calib.json`。
- 分析：`tools/calib_analyze.py` → `artifacts/inloop/calib/ANALYSIS.md|json|rows.json`。

样本 110（红 49 / 蓝 61）。剔除：位姿核对 5，关联失败/伪检测 416（地图纹理产生大量伪蓝球；
关联要求投影误差 ≤max(20cm, 0.35·距离)、第二近同类球 ≥2 倍远、相机系方位差 ≤3°——只按方位筛，不按距离误差挑样本），
超出 40–95cm×|β|≤35° 92。

误差表（真值 − 读数；每格 ≥2）：

| 读数 cm \ \|β\| | 0–12° | 12–24° | 24–35° |
|---|---|---|---|
| 40–55 | n=12 Δd +8.7±6.1 | n=22 Δd +10.2±4.2 | n=19 Δd +15.4±5.5 |
| 55–70 | n=14 Δd +7.5±6.6 | n=15 Δd +7.2±5.1 | n=4 Δd +13.0±3.0 |
| 70–85 | n=3 Δd +0.7±2.7 | n=4 Δd +11.5±13.8 | n=9 Δd +22.3±14.8 |
| 85–95 | n=3 Δd +3.3±17.1 | n=3 Δd −1.7±3.8 | n=2 Δd +18.4±15.3 |

数据给出的形式：读数偏短且随 |β| 增大；方位从车体中心看被高估 1–3°，但从相机（车体前方 5.375cm）看几乎无误差
（相机系方位 RMSE 0.7°）。所以修正 = 相机前移 + 相机量程随 1/cosβ 放大（检测器用 W·F/w/cosα 估距，
离轴球像宽约按 1/cos²α 放大）：

```text
rho = a + k·d/cosβ ；forward = L + rho·cosβ ；right = rho·sinβ
L = 5.1557 cm, a = 1.6239 cm, k = 1.0187      （L 与平台相机前移 5.375cm 独立吻合）
```

验证集（1/3，按站点分组，n=34）：

| 形式 | 位置 RMSE | p95 | max |
|---|---|---|---|
| M0 不修正 | 12.98 | 23.9 | 35.7 |
| M1 d'=a+k·d | 10.40 | 20.2 | 25.9 |
| **M5（采用）** | **9.55** | 18.1 | 20.9 |
| M6 反比量程 | 8.62 | 15.8 | 18.0 |

M6 验证略好但差距在逐球噪声内（34 个样本、同球高度相关）；M5 的 L 有物理对照，且在 map-03 留出数据
（v25 三次命中）上更好（均值误差 2.98 vs 4.49cm）。红/蓝分开拟合的常数接近（k 1.00/0.95），
互相验证不优于合并拟合，因此一套常数。

**下限**：残差主要是逐球系统偏差（同一球内标准差 2–7cm，不同球均值 −13…+15cm，如 map-04 target-1 +14.9、
map-06 target-2 −13.1），`distanceCm`/`bearingDeg` 无法区分；全域修正做不到 5cm。map-03 这颗球恰好偏差小。
其它布局上 WM 仍可能差 10cm 以上。

## 程序改动（接近/确认段；送货段不动）

- `calibrated_detection()`：WorldModel 唯一观测入口，两处 `observation_to_detection` 都改走它；
  `target_observations` 同时打印原始与修正后的距离/方位。
- `GRAB_STANDOFF_M = 0.11` 替换 v24 的 `MEMORY_STOP_DISTANCE_M = 0.06`（那是用来抵消偏短的）；最后一步按剩余距离缩短；
  抓前原地对准到 |β| ≤ 3°。`APPROACH_MAX_CALLS = 3`。
- 日志航向统一为 `odometry.headingDeg`（左转为正）：新增 `_pose_log()` 替换 7 处 `degrees(yaw_rad)`，`memory_hit` 同改，
  `memory_confirmed.hits[].pose_yaw`（弧度、右为正）改为 `pose_heading_deg`；`program_version` 行写明约定。
  本局同一位姿：`approach_result` 80.8°，`delivery_phase_start` 80.8°。

## 驱动 / 工具改动（bench 工具，平台文件未动）

- driver：`calib_obs` 行按 tick 与 samples 联结，输出 `<out>.calib.json`；运行中缓存输出并写 `<out>.partial.txt`；
  页面冻结后收尾读取压到 15 s 且各自容错（之前冻结会整局丢失）。
- 已知：`--disable-evidence`（把 `addVisionEvidence` 替换成返回 null）会让页面在约 30 次 observe 后冻结；
  标定改为保持证据账本开启、observe ≤85。
- 新增 `tools/calib_analyze.py`、`tools/verify_grab.py`（后者对 v25 复现 13.0cm / 16.1cm / 4×far）。
