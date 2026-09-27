# P1：采样逆行链与动作内恢复

基线为 `10e3c879d2499d6f893151f24857c315f12fe2e7`；编辑前源码/AST 选择记录在 `raw/baseline/source-selection.json`。本项只修改 `autonomous_brain/confirmation_sampling.py`、`navigation.py` 的只读原观测窗口接口，并新增 `tests/test_brain_sampling_inverse_chain.py`。没有改平台、WM、动作抓放实现或旧测试夹具。采样协议由 `brain-confirmation-sampling/v2` 升为 **v3**。最终统一门和冻结后导出由主任务单独记录；以下是开发证据，不是正式局成绩。

## 连续共线证据，不按分段长短改变授权

`_reverse_support(actions,length,snapshot=None)` 保留旧签名，内部复用 `_recorded_translation_support`。后者从当前真实末端逆序取已有路段，校验每段实测弦长/行程、车身相关行进方向、全链垂向误差、真实端点连续性，再验证完整注册观测窗口。只对已经覆盖的共线区间求并集；折返重复的行程不会增加可走范围。

20 cm、10+10 cm、5×4 cm 的真实运动分别产生一、二、四条 RoadMemory 记录，均授权原 20 cm 路径。证据包含所有原 `segments`、`segment_ids`、完整 `observation_refs`、`motion_refs`、覆盖区间与新鲜道路净空。旧 `segment_id/before_observation/after_observation` 仍指基础历史段；新增 `last_motion_observation/current_observation_index` 明确链末端。

新只读 `RoadMemory.observation_records(first,last)` 返回注册的 observation_index、odometry、road、相机 frameId/tick、holding 和实际 motion；返回深拷贝，不导出对象、语义身份或场景内部状态。缺少的观测不补齐。额外静态新帧必须确实原地、里程与 tick 不变；任何实际动作必须有对应回执和完整观测。使用原 RoadEvidence 运动/新鲜度校验，另拒绝原地转向中无法解释的里程增长。

负例包括：断点、只有 .1/.2 cm 的未记录跳点、平行侧偏、多短段侧向容差累积、曲线、未处理的中途节点、位于旧段内部但无真实归路、缺帧/旧帧/tick 回退、缺运动/unknown 运动及请求超出实际覆盖范围。不会依据近邻位置补边。当前净空仍需独立通过，旧路径本身不是现在可安全执行的证明。

## 刚执行 backward 后的条件性 forward 恢复

`_restore_plan` 对刚完成的 forward/follow_road/backward 使用同一条实际路径核验：前两者可有据 backward，后者可有据 forward。恢复计划必须对应本动作刚执行的唯一 motion、正确 before/after 引用、原有效唯一视点及其相机帧；新鲜道路净空、原始观察距离/角度窗和动作剩余预算全部检查。转向恢复仍要求实际原地转向证据及平台合法最小角度。

采样执行后若关联身份已经变化，先拒绝，不再为旧身份发恢复动作。恢复后必须通过实测位置/方向、新鲜唯一目标与相同身份核验；回到旧视点不会增加独立命中。障碍、旧视角失效、目标未重现、出现另一个真实检测、部分位移、航向偏差或 unknown 回执都保留失败，不盲目重发。

真实感知组件正例：两个实际独立 hit → 有据 backward 失视 → 按刚执行路径 forward 回原视点（hit 仍为 2）→ 另一个合法独立视点 → 原 WM 三 hit 确认。反例保留持续遮挡或恢复后出现不同目标：最多一次恢复，仍不能宣布确认。所有 motor 调用经过实际冻结 `normalizeCommand`，没有手填 CONFIRMED。

## 原门和边界

原始入图门仍为 `40 <= raw_cm < 90`、`abs(raw_bearing)<=35°`、至少三个有效 hit、独立位姿至少 15 cm。规划仍保留 42–87 cm / 33° 和额外 .2 cm 分离裕量。每个采样动作最多 12 步、实际累计 120 cm，恢复占用同一预算且最多一次；合法最小转角仍为 1°。没有扩充正式轮数或运行时间，没有使 TENTATIVE 可以 go_to/pick。

前进/后退/转向均有真实原语正对照；.2 cm/.2° 的运动及几何容差没有放宽。路径是否已探索、节点全局身份是否解决与这里的局部可执行证据分开；本实现不会据此完成未解决节点或探索义务。

## 开发命令及原始记录

首次反例使用当时新增的十项测试，保存 `raw/sampling/first-red.txt`：**4 failed / 6 passed**。两个分段授权正例、backward→forward 直接恢复及真实感知恢复链失败；单段 20 cm 和原有拒绝边界通过。

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 -m pytest -q tests/test_brain_sampling_inverse_chain.py
```

首个实现输出 `first-implementation.txt` 为 14 failed / 37 passed：新接口保存相机 frameId/tick，而实现误把它与含图像框的完整 observation 字典全量比较，导致有效支持均被拒绝。修复为核对已注册的原字段，未改测试传感事实；`window-field-fixed.txt` 为 51 passed。之后扩充负边界，`boundary-first.txt` 为 74 passed，`inverse-boundaries.txt` 为 77 passed。

最后发现转向回执可夹带无法解释的里程增长，定向红测 `turn-window-red.txt` 为 **1 failed / 39 deselected**；deselect 只来自 `-k` 定向选择，不是完整回归排除用例：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 -m pytest -q tests/test_brain_sampling_inverse_chain.py -k stationary_turn_receipt
```

新增专属文件共 40 项。本项 15 文件开发合集保存 `raw/sampling/development-regression-final.txt`，**229 passed / 0 failed / 0 skipped / 0 deselected**。每个文件只列一次，未与前面的重叠运行数相加；最后的兼容字段补充仅保留既有基础段 after_observation 语义，随后 `compatibility-fields-final.txt` 为 **81 passed / 0 failed / 0 skipped / 0 deselected**，执行的是该合集前三个文件。

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 -m pytest -q tests/test_brain_sampling_inverse_chain.py tests/test_brain_sampling_viewpoint_comparison.py tests/test_brain_confirmation_sampling.py tests/test_brain_sampling_progress.py tests/test_brain_explore_sampling_handoff.py tests/test_brain_navigation_reposition.py tests/test_brain_route_evidence.py tests/test_brain_navigation_candidate_filter.py tests/test_brain_observed_routes.py tests/test_brain_semantic_road_evidence.py tests/test_brain_stage2_adversarial.py tests/test_brain_road_node_locator.py tests/test_brain_route_contract.py tests/test_brain_road_clearance.py tests/test_brain_visual_standoff.py
```

## 独立组件导出入口

从仓库根目录选择全新输出路径；脚本拒绝覆盖原件：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:vendor/wm_kit_opt2 python3 tests/test_brain_sampling_inverse_chain.py --output /tmp/new-sampling-inverse-chain.json
```

五个场景：三种 20 cm 分段形式、backward 失视后的 forward 恢复并确认、持续失视一次恢复后拒绝。导出保留全公开观测、实际运动、归一化命令、原路段及完整支持链、原/最终对象 hit，并逐 hit 复查实际帧、原窗与位姿分离。源文件及 WM/命令契约 SHA 在执行前后比较。已有开发快照为 `raw/sampling/inverse-chain-public-development.json`；该文件先于最后转向里程负例和兼容字段补充，不冒充最终冻结证据。

这些是固定公开传感输入上的真实 Perception/WM/控制组件联动，不启动模型或平台仿真。它们不能保证未知遮挡下目标重现，也不能排除传感器未报告的中途结构；无足够可执行证据时允许拒绝。最终冻结源码应另选新文件重新导出，不能覆盖上述开发记录。
