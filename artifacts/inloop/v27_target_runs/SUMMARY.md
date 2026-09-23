# v27 在环运行摘要（2026-09-23，按球留一 + 等权融合 + 抓取闭环）

- 程序：`programs/world_model_target_delivery.py`，`PROGRAM_VERSION = wm-memory-v27-20260923`，SHA256 见 `program.sha256`
  （运行时自报 `188d7e70…`）。标定常数 `RANGE_CAL` 未改；送货段未改。
- 每局：`<map>-NN.json / .samples.json / .log / .verify.json`（`tools/verify_grab.py` 输出）。

## 结果

| 局 | WM 最终误差（真值） | 抓取次数 | 抓取瞬间真值 前向 / 侧向 | mission | 结论 |
|---|---|---|---|---|---|
| map-02 | 6.7 cm（target-1） | 0 | — | 0/13 | **失败**：确认阶段未凑够 3 次命中 |
| map-10 | —（未建立轨迹） | 0 | — | 0/13 | **失败**：进入读数窗口的代码路径 TypeError |
| map-03（回归） | 3.0 cm | 3（far, far, grabbed） | 12.2 / +0.6 cm | 1/13 | 通过 |

map-03 逐次抓取（与 record.events 对齐）：

```text
step 1  advanced  0cm  holding=None   event far      truth forward 24.2  right +0.6  (WM 0.213m)
step 2  advanced  6cm  holding=None   event far      truth forward 18.2  right +0.6  (WM 0.152m)
step 3  advanced 12cm  holding=目标物  event grabbed  truth forward 12.2  right +0.6  (WM 0.092m)
approach 调用 1 次；抓取闭环内 observe 0 次（全局 observe 7 次，均在确认阶段）
```

先测不改（仅 map-03 有数据）：最后一次命中视线方向与最终接近航向夹角 −7.0°（接近航向在视线左侧）；
抓取瞬间真值侧向 +0.6 cm。一局不足以说明夹角与侧向的关系。

## 失败原因

**map-02**（target-1，与标定球 map-08 target-1 同一摆放位置，相距 1cm）：
1. 第 1 次命中：原始 63cm → 修正 71.5cm，WM 距离 0.715m > 0.70 → 采样方向选 "toward"。
2. "toward" 的 follow_road 在路口返回 0cm → 反向为 "away"，并在原地再 observe 一次（WM 又计一次命中，
   `accepted_hits` 因间距 <15cm 拒收；等权融合下这次同位姿命中权重翻倍）。
3. "away" 20cm → 原始 77cm，第 2 次有效命中。之后方向一直是 "away"：原始读数超出 40–90cm 窗口，连续 4 次无命中
   → `confirmation_failed: sample_not_recorded` → `RuntimeError: WorldModel 未通过 observe() 确认目标物`。
- 直接原因：确认采样的方向阈值（0.70m / 0.85m）是按未修正距离写的；v26 修正让同一读数的 WM 距离长 8–13cm，
  改变了方向选择；"away" 分支又没有在超出窗口后回头。

**map-10**（最近的 target-1 与标定球 map-06 target-2 同一摆放位置，该球留出偏差 −15.5cm）：
- 第 6 次 observe 看到目标但原始读数不在 40–90cm 窗口 → `_try_enter_range_and_confirm` 调用
  `_capture_after_move(direction, 25.0, attempts=3, require_candidate=False, …)`，该函数没有这两个参数 →
  TypeError（平台提示"第 1726 行的参数类型不正确"，1726 是顶层 `patrol_until_target_seen` 调用行）。
  即使参数对了，调用方还把返回的 dict 当三元组拆包。这段从 v25 起就存在，map-03 从未走到。
- 本轮三局均未遇到平台启动间歇错误（`composite delivery … missing from the interaction definition`）。

两局都没有走到抓取闭环，抓取闭环只在 map-03 上验证过。

## 本轮改动

1. 分析器（`tools/calib_analyze.py` → `artifacts/inloop/calib/ANALYSIS_LOBO.md|json`）：按球留一。
   去掉 3 条同站点重复（map-04 target-2，tick 7822/7841/7860）。
   - A 组 = 布局+packageId：M5 留出偏差 −15.5…+25.5cm，红 2/6、蓝 4/8 在 ±5cm 内；M6 −10.7…+25.8cm，红 2/6、蓝 4/8。
   - B 组 = 物理摆放位置（另去掉 4 条跨布局完全相同的样本；map-04/06/07 的 target-1 等是同一位置）：
     M5 红 2/5、蓝 3/5；M6 红 2/5、蓝 3/5。
   - 注意：摆放位置在布局间大量复用。map-02 target-1 ≈ map-08 target-1，map-02/map-10 的 (12.82, 5.64) 目标
     = map-06 target-2；因此 map-02 / map-10 未参与标定和选择，但部分球位置参与了。
2. WorldModel（`~/wm_kit/world_model`，未提交）：`AssociationConfig.static_equal_weight`（默认 False），
   只在 `GUANGYANG_STATIC_ASSOCIATION_CONFIG` 打开；`_fuse` 在打开时用 1/n 权重（算术平均）。
   新增 2 个测试，wm_kit 190 passed。用 `tools/embed_world_model.py` 重新内嵌，只有 association.py / core.py /
   providers/guangyang.py 三个文件变化。
3. 抓取闭环：WM 前向 22cm 停车对准（已更近则后退），1 次 approach(max_steps=1)，然后 grab → holding()，
   未抓到直行 6cm，累计 ≤42cm（最多 8 次抓取），每步检查 onRoad，不 observe。
4. 日志：`grab_step`（步号、累计前进、holding、tick、WM 距离）、`grab_geometry`（视线/接近夹角、WM 前向/侧向）、
   `grab_loop_failed`（off_road / max_advance_reached / holding_wrong_object）。
