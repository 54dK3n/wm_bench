# opt1 单球规划语义修复（仿真前）

新文件：`programs/world_model_opt1.py`，版本 `wm-opt1-r1-20260923`。从冻结 `artifacts/inloop/stage-1/round-3/program.py` 复制；原 R3、demo、原单球程序及三个旧 fragment 均未修改。本文件只记录离线证据与回归，不声称 map-02 已经复跑成功。

## 原始日志证明的问题

下列索引均为原始 `round-N/map-NN.json` 的零起点 `lines[n]`，不是文本行号。更完整的既有提取方法见 `../stage-1/round-3/PLANNER_FINDINGS.md` 与其 `extract_planner_findings.py`。

- **02 局部停止被扩大为整道路封向。** R3 `[891–892]` 在 `central-south` 的 42.7cm 处遇 `front_clearance`，记录整条反向阻塞；`[965–966]` 又在 24.4cm 处记录整条正向阻塞。该道路长 64.9cm。第二次停止后，24.4→0cm 的原路退回不会穿过第一次的 42.7cm 停止边界，却被整方向记录拒绝；`[967]` 立即 `memory_graph_exhausted`，WM 距离 1.587m。纯记忆里程 `[968]` 为 1916.0cm，0 次抓取。R2 同一确认结果后经 `oil-south` 到达 WM 0.143m（`[936]`），道路里程 1311.9cm（`[937]`），第 2 次抓到。两轮确认事件 R2 `[752]` / R3 `[750]` 完全相同，WM 误差同为 5.4cm；修复对象因此是道路可达性表示，不是测距或确认。
- **02 gateway 入口与目标端点不一致。** R3 请求 `bailu-outer-arc@0.0`，`[759,766,768]` 三次实际落点都是 160.2cm，随后 `[769]` 拒绝重复状态；`lower-east@97.3` 的 `[896,898]` 都落在 25.0cm，`[899]` 拒绝；`lower-west@0.0` 的 `[929,931]` 都落在 51.9cm，`[932]` 拒绝。旧纯函数从 160.2cm 去未知 0cm gateway，选择另一端重入，成本 50.0cm，仍回到 160.2cm；真正沿本路到 0cm 的距离是 160.2cm。不能把前者当作到达该未知边界。
- **05 也出现同类循环，成功不等于该分支正确。** R2 `[516]` 拒绝重复 `parking-connector@12.4`，最后 2727.8cm 才到 WM 0.099m（`[604–605]`）。R3 `[330]` 拒绝重复 `bailu-outer-arc@0.0`；`[410]` 又在 `lower-east@46.7` 记整反向阻塞，之后仍到达 `oil-south`，WM 0.099m、里程 883.7cm（`[415–416]`）。
- **09 说明不得永久删掉目标入口，也不能把成功归因于尚未触发的封边。** R2 `[959]` 在过渡道路 `central-south@24.4` 遇阻后，将 `lower-east` 两个入口分别因过渡故障拒绝（`[962–963,974–975]`）；最终 3291.8cm、0 抓（`[1040]`）。R3 仍在 `[964]` 拒绝重复 `east-outer-south@0.0`，但 `[997–998]` 已到 `lower-east`、WM 0.242m、里程 473.4cm，之后第 4 次抓到。确认后至抓取间没有动态封向事件，因此其改善只支持探索顺序/入口影响，不证明旧封向正确。

02、05、09 是旧独立场景分组中的三个不同代表；04/05/08 没有重复计入。这里引用它们解释共享控制语义，**没有据此新增或拟合阈值**，也没有使用这些测试日志选择视觉过滤规则。

## 改动与不变项

1. `front_clearance` 现在记录运行时公开 `roadId + roadProgressCm + 实际方向`，事件为 `viewpoint_local_clearance_blocked`，作用是禁止越过该停止边界。全道路穿越仍不可行；在同一侧行驶、到边界停止和从来路退回仍可规划。当前路、目标路的部分路径、Dijkstra 全边和未知区间均按同一边界规则检查。方向来自实际 progress 变化或已测道路切线与实际 heading，不按道路前后半段猜测。
2. 未知端点 gateway 只能从其命名端点进入；保留公开 `take_exit` 的 25cm 落点成本。已有实际停止边界在其前时，成本使用已经测得的停止位置，后续仍根据真实 road_state 重规划。该 API 进入距离来源仍为平台 `competition-core.js:117,3896–3910`。
3. 若 gateway 的预期落点已经测过，不再重入后返回同一落点；由该实测位置朝尚未测量区间生成 frontier。没有为未知道路虚构坐标。已有“同状态、同路线且无新覆盖”的循环终止继续保留；局部阻塞集合的变化进入操作身份，允许同位姿换合法路线。
4. 清除未使用的 `mission_objects/target_anchors/distractor_anchors` 和 `_approach_graph_exit_fallback/_approach_choose_exit`。只把先经 `role == obstacle` 过滤的条目保存为 obstacle_anchors；目标项只读 role，不读其 roadId/progressCm。受保护字典回归覆盖该约束。

新增的 3 个辅助函数为 `_road_progress_limit`、`_road_progress_blocked`、`_vp_block_revision`。改动的 8 个旧函数为 `_turn_around_and_block`、`dijkstra`、`_vp_path`、`_vp_block_current_direction`、`_vp_travel`、`_vp_explore`、`_mag_frontiers`、`_approach_graph_navigation`。

未增加经验数值：继续用原 5cm 候选网格、10cm follow 小步、25cm API 进入距离及原有按 0.1cm 归一的状态精度。M5、WM ZIP、确认/抓取常数均相同；顶层已有赋值只改变 `PROGRAM_VERSION` 与 obstacle_anchors 的过滤表达式。`calibrate_reading`、`calibrated_detection`、`_update_wm`、`_record_hit`、`_confirmation_result`、`_try_enter_range_and_confirm`、`approach_target_with_world_model` AST 完全相同。

## 一次离线验证

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q programs/tests/test_opt1_planner.py
PYTHONPATH=/private/tmp/wm_bench_pylint PYLINTHOME=/private/tmp/wm_bench_pylint_cache python3 -m pylint --disable=all --enable=E1123,E1120,E1121,E0633,E0602 --additional-builtins=robot programs/world_model_opt1.py
```

结果：**15 passed，0.30s；指定 pylint 五类零错误**。测试使用合成公共道路，覆盖双侧局部障碍保留退路、不能越界、邻路绕行、实际方向、5cm 可达未知前缀、gateway 正确入口、已测落点不重入、首次未知入口继续可达、已知短入路停止、无进展终止、阻塞后同位姿换路，以及冻结测距/确认/抓取与目标锚点隔离。不运行仿真；不修改既有回归或评测脚本。

交还给根代理整合过滤器前的校验值：

| 文件 | SHA256 |
|---|---|
| 冻结 R3 program.py（未改） | `414b941ebc4c24fcf70a9384de90abc50c7e677e9f79103dc84b0861d567a69a` |
| 新 world_model_opt1.py | `be3b80220f996590c3e2ef2dac7d5cc5a6d551d1a24ee9eaa5e1d05e09fd7e3d` |
| 新 test_opt1_planner.py | `06483b5bb90d5c8fdefa0046bbff7dc5d777b6ead3e901e37f3512274592234f` |

以上新程序 SHA 仅对应规划修复交接点；过滤器整合后应重新冻结并记录最终 SHA，不复用本值。
