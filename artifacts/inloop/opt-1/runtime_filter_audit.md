# 运行时检测链路只读审计

审计快照：2026-09-23T14:42:29.424975+00:00。全部审计检查：PASS。只覆盖 progress.completed 已完成局；未运行仿真、未改 program/tools/code_manifest、未做阶段2优化或评测。

|轮次|已完成局|observe / native查询|原始红蓝|窗外红蓝|100cm+红蓝|窗外被过滤|WM输入|链路异常|
|---|---|---:|---:|---:|---:|---:|---:|---:|
|r1|map-01|7 / 7|13|7|2|1|3|0|
|r1|map-02|7 / 7|9|6|6|1|3|0|
|r1|map-03|7 / 7|10|5|4|1|3|0|
|r1|map-04|8 / 8|8|4|1|0|3|0|
|r1|map-05|9 / 9|8|3|2|0|3|0|
|r1|map-06|10 / 10|14|8|2|1|3|0|
|r1|map-07|52 / 52|54|39|21|4|0|0|
|r1|map-08|9 / 9|5|1|1|0|3|0|
|r1|map-09|14 / 14|17|11|8|2|4|0|
|r1|map-10|8 / 8|18|14|10|2|3|0|
|r2|map-01|7 / 7|14|8|2|0|3|0|
|r2|map-05|9 / 9|8|3|1|0|3|0|

原始红蓝日志与每条原生 observe 查询的四字段投影逐项相等，query参数均为None/0；过滤索引按完整原生返回数组（含其它类别）复放，完整且不重复。requested confidence/category 后的返回数组由记录重建，与真实 WM items、seen、outside_window 及 associations 对齐。存放点专用查询不调用 WM，这是预期用途，不是检测丢失。

r1 的 v1 会过滤部分窗外低置信度检测；r2 的 v2 对窗外弃权保留。两轮实际 WM 输入均限制在40≤d<90；三个调用点都显式memory_phase=True。`_update_wm` 的旧注释“40–95”与实际90上限不符，但本轮未修改源码。

100cm+且无旧WM时 `_planning_goal` 只产生ray_x/ray_z/ux/uz；点坐标与M5调用只在<100分支。射线候选只检查方向，不以100cm生成目标点。有旧WM则使用其先前合法观测位置。孤立纯函数回放也验证100不会调用标定。

源码检查未发现固定布局ID分支、目标位置查表或target anchors读取。mission.objects仅在role==obstacle白名单后用于避障，mission.storage用于送货。坐标扫描包含主程序及嵌入14个Python模块；详见JSON中的static_checks与源码片段。

三条独立r1 exact raw示例：
- map-01 / S01: raw lines[9], filter lines[10], WM lines[11], tick 675; 原生query seq 181, frameId 9, exactRender绑定通过。WM距离/方位=[(46, 28.74)].
- map-02 / S02: raw lines[13], filter lines[14], WM lines[15], tick 1785; 原生query seq 455, frameId 10, exactRender绑定通过。WM距离/方位=[(63, -7.4)].
- map-09 / S08: raw lines[32], filter lines[33], WM lines[34], tick 3453; 原生query seq 867, frameId 15, exactRender绑定通过。WM距离/方位=[(66, 35.18)].

三组完整目标相关轨迹按既有容差逐对不等价；没有以三个布局名称代替独立性。所有原始数组、decision、原图路径、行索引、逐对差异以及审计前后manifest文件SHA检查保存在 runtime_filter_audit.json。

复跑：`PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-1/reproduce_runtime_filter_audit.py`。复跑将审查届时已完成局并更新快照。
