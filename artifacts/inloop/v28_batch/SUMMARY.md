# #18 v28：确认阶段泛化 + 10 布局诊断批跑（2026-09-23）

- 程序：`programs/world_model_target_delivery.py`（快照 `program_v28.py`），`PROGRAM_VERSION = wm-memory-v28-20260923`，
  文件 SHA256 `bacae82a…`（`program.sha256`）。program_version 行打印
  `wm_kit_commit = ad237a143f0d35e100a28c15567d4b75bd56cccf`、`wm_embed_sha256 = 651a8996…9f66e3`。
- 批跑期间未改代码。每布局一局；另有 2 局平台启动错误（map-05、map-02，`composite delivery … missing from the
  interaction definition`，程序未执行）按基础设施问题重跑，日志 `infra-*`。
- 逐局数据：`map-XX.json / .samples.json / .log`；汇总 `batch_report.json`（`tools/batch_report.py`）。

## 运行前检查

- `pylint --disable=all --enable=E1123,E1120,E1121,E0633,E0602 --additional-builtins=robot`：0 条（10.00/10）。
  `robot` 由平台注入，不加 `--additional-builtins=robot` 时只有它的 E0602。同一检查对 v26 程序报出 2 条 E1123
  （`attempts` / `require_candidate`），即 v27 map-10 的崩溃点。E0633 查不到那处"把 dict 当三元组拆包"（推断不出返回类型）。
- 布局坐标常量：`tools/check_no_layout_constants.py` 扫描 370 个数字字面量（跳过内嵌包行），按 7 个位置在
  场景单位 / 米 / 厘米 / 起点里程计系（米、厘米）下比对：成对匹配 0；单值近似只有 `MAX_OBSERVES = 92`、
  循环次数 `12`（与 A 在里程计厘米系的分量相差 <0.5%，非坐标）。

## 结果

复核更正：平台 `program_error` **9/10**，严格“程序报错 0/10”门限未通过。9 局均由任务失败分支主动
`raise RuntimeError` 触发；其它意外代码异常为 0/10，不能用这个子集替代门限。后续修订与重跑见 `../v28r1_batch/`。

| 布局 | 球 | 标定 | 确认 | WM 最终误差 | 抓取 | 抓取瞬间真值 前向/侧向 | mission | 失败原因 |
|---|---|---|---|---|---|---|---|---|
| map-01 | B | 已用于选择 | 通过 | 3.0 | 3（far, far, grabbed） | 12.2 / +0.6 | 0/13 | 送货：release_sample 三次 follow_road 0cm（junction），`未找到可确认的目标物存放姿态` |
| map-02 | C | 已标定 | 失败（2/3） | 7.8 | 0 | — | 0/13 | ⑤ 第 3 点选 toward（预测 61.7cm）= 回到第 1 点位姿，判重复；回退 away 读数 100 |
| map-03 | B | 已用于选择 | 通过 | 3.0 | 3（far, far, grabbed） | 12.2 / +0.6 | 1/13 | — |
| map-04 | C | 已标定 | 失败（1/3） | 4.2 | 0 | — | 0/13 | ④ away（预测 74.7）到真值 87cm 处无任何红球检测；① 回退 toward 在路口 0cm |
| map-05 | C | 已标定 | 失败（1/3） | 4.2 | 0 | — | 0/13 | 同 map-04（同一路段、同一数值） |
| map-06 | D | 已标定 | 失败（1/3） | 28.0 | 0 | — | 1/13 | ② 读数 100（夹紧）时进窗循环 16 次 0cm 移动、原地重复 observe；后首命中 78cm@34.6°，① toward 路口 0cm，⑦ 回退 away 读数 93 >90 |
| map-07 | E | 未见过 | 失败（0/3） | —（无轨迹） | 0 | — | 0/13 | ② 进窗循环 17 次 0cm；③ 近处看到 20cm@29°，进窗 away 25cm 后车头背向球，无 WM 轨迹不回转，看不到；19cm↔看不到 往返至 observe 预算 |
| map-08 | C | 已标定 | 失败（1/3） | 6.4 | 0 | — | 0/13 | 同 map-04（首命中 53cm，away 预测 72.7，真值 87.1cm 处无检测，toward 路口 0cm） |
| map-09 | E | 未见过 | 失败（采样记录 2/3；WM 两轨迹各 1） | 51.7（首轨迹约 12.3） | 0 | — | 0/13 | ① toward 只走 13.3cm（路口）→ 69cm 判重复；⑥ 回退 away 同帧读数 93（窗外）与 55（窗内），55 新建 target_002，采样记录跨轨迹累计；此处到 E 真值 114cm |
| map-10 | D | 已标定 | 失败（1/3） | 28.0 | 0 | — | 0/13 | 同 map-06（进窗循环 16 次 0cm；78cm@34.6°；toward 0cm；away 读数 93） |

- 只有 B 通过确认；抓取闭环在 B 上两局一致：far 24.2 → far 18.2 → 抓到 12.2cm，侧向 +0.6cm；
  视线/接近夹角 −7.0°（先测不改；只有这一个球的数据）。
- WM 精度测试结果（只算 E）：map-09 首轨迹约 12.3cm（65cm@34°，视野边缘）；最终被选择的伪检测新轨迹误差 51.7cm，
  首轨迹仍保留，不能描述成它的平均值被污染；map-07 未建立轨迹。G 没有被追踪，无测试样本。其余位置只报告。
- map-06 mission 1/13 但未抓到球，来自其它任务项，未深究。
- 同位姿重复观测不计命中已生效：map-02 第 3 次观测回到第 1 点位姿，WM 命中数停在 2（未再被判 CONFIRMED）。

## 失败类型（按出现次数）

| # | 类型 | 局 | 说明 |
|---|---|---|---|
| ① | 采样移动被路口截断 | 02,04,05,06,08,09,10 | 采样只用 follow_road，到节点即停（0cm 或 13.3cm）；球在路口附近时一个方向没有可用路段 |
| ② | 进窗循环在 0cm 移动时原地重复 observe | 06,07,10 | `_try_enter_range_and_confirm` 不检查移动距离，同一 tick 最多 17 次 observe |
| ④ | 预测在窗内但该处无检测 | 04,05,08 | 同一路段（C），真值 87cm 处原始检测为空；读数模型无法预测"看不到" |
| ⑦ | 回退方向预测已在窗外，实际也在窗外 | 06,10 | 预测 110.9，实际 93（>90） |
| ③ | 进窗 away 后背向球 | 07 | 没有 WM 轨迹时，observe 前不回转 |
| ⑤ | 选中的方向回到更早的命中位姿 | 02 | 规则只比较"上一采样点" |
| ⑥ | 窗外真红球与窗内伪检测导致轨迹切换 | 09 | 93cm 在窗外、55cm 在窗内；伪检测新建轨迹，程序采样记录跨轨迹累计 |
| — | 送货路段不通 | 01 | 送货段未改 |

## 本轮改动

1. `_try_enter_range_and_confirm`：`_capture_after_move` 调用去掉不存在的参数，返回 dict 按键取值。
2. 确认采样方向（`_choose_sample_direction` / `_sample_step` / `_move_and_sample`）：删掉 0.65/0.68/0.70m 阈值
   （`_choose_confirmation_direction` 本身已无人调用，一并删除）。沿当前道路方向 ±20cm 预测位置，用修正模型的逆
   `uncalibrate_reading`（观测前原地转向目标，方位按 0）算预测原始读数，选落在 45–85cm 的方向；都在选离上一采样点
   更远的，都不在选更接近 65cm 的；最后一个点另要求预测 WM 距离 ≥0.5m。首选失败（窗内无命中、没动、位置重复）→
   回到上一个命中位姿，换方向一次；没动时不 observe。逆变换往返误差 4e-14cm。
3. WorldModel（wm_kit 分支 `guangyang-static-confirmation`，提交 `ad237a1`）：`min_hit_pose_gap_m`（默认 0），
   guangyang 静态配置 0.15m；新增 2 个单测。提交同时纳入此前未提交的 world_model 工作区改动与 `providers/guangyang.py`，
   使提交与内嵌包逐字节一致（`tools/embed_world_model.py` 只从提交取内容，工作区不一致即拒绝）。
   **注意**：wm_kit 离线验收 2.2/2.5 共 6 项用同一静态配置回放 2Hz 连续帧（规格 5：连续命中即确认），开启位姿间隔后
   全部失败；已在 `tests/acceptance/harness.py`（未跟踪文件，未提交）里对回放显式关闭位姿间隔，断言未改。192 passed。
4. 日志：每次 observe 打印 tick 与全部红/蓝原始检测（distanceCm、bearingDeg、confidence、类别，含窗外）；
   `target_observations` 增加 `seen`（看到的红球数）与 `outside_window`；新增 `confirmation_direction`（两方向预测、
   规则、结果）、`confirmation_return_to_last_hit`、`confirmation_direction_fallback`。

## 后续复核发现的实现缺口

- 上述日志项并未覆盖送货阶段：`observe("存放点", ...)` 在接口处已过滤红蓝；低于调用置信度的检测也未进入日志。
- 回退未检验实际返回位姿；最后点过近的补采分支绕过一次回退换向规则。这两个边界没有在本批实际触发。
- v28r1 补齐以上要求，使用显式 `flow_end(success=false)` 表达已知任务失败，并完整重跑；本目录继续保留原始批次数据。
