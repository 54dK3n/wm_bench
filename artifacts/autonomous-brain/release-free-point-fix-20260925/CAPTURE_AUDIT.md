# Run14 指定帧与历史 Judge 绑定差异独立核对

结论：没有发现所怀疑的过期相机矩阵。Run14 的 r26/r37 与诊断重放之间确实存在 Judge 结果差异，但可以由原运行后来新增的一条冲突身份绑定完整解释。不是归档摘要误读，也不是评测源码版本差异。此核对不改变任何历史结果，不把离线诊断记为正式运行成功。

只读输入为指定平台/driver/evaluator 源码、相关 manifest、指定 brain 观测及相关评测字段。captures 按数组流式扫描，到所需最后 frame268 即停止，只提取相机矩阵、机器人位姿、tick、stateRevision；未检查其 truthObjects 或读取 record/layout，未接触正在运行的 Run15。唯一新增文件为本报告。

## 相机矩阵核对

三个结束运行：

- `artifacts/autonomous-brain/map05-run-14/map-05-run-1/`
- `artifacts/autonomous-brain/placement-reobservation-replay-01/map-05-run-1/`
- `artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1/`

比较各目录 `captures.json.gz` 的以下 frameId，并与对应 `brain/observations.jsonl` 的 observation_index/tick 核对：

| frame / observation | round | tick | stateRevision | 原运行与两个诊断的 matrixWorld 最大逐元素差 |
|---|---:|---:|---:|---:|
| 158 | 26 | 5357 | 2 | 0 |
| 161 | 26 | 5453 | 2 | 0 |
| 268 | 37 | 11177 | 3 | 0 |

三个运行的这三帧不仅16个矩阵元素完全一致，cameraPose 中的尺度/内参、robotWorldPose、tick、stateRevision 也完全一致。各帧 capture tick 与 brain observation tick 一致。

`workspaces/guangyang-platform/projects/car-python/app.js:8058` 先执行 `scene.updateMatrixWorld(true)`；8059 调用 `updateVirtualCameraPose()`，后者在7995–7996更新 robotGroup 和 virtualCamera。随后8067才调用 `renderer.render(scene, virtualCamera)`，进入 `tools/autonomous_brain_driver.js:105` 的包装器，在118读取 matrixWorld，最后才调用 originalRender。因此包装器读取前已有显式更新。app.js:8102–8109还在异步 vision 返回后检查 captureContext 未变；driver 捕获绑定另外检查 tick/stateRevision。

相机局部位置在 app.js:7966 为 `(0, .54, -.43)`，父机器人位姿在11016–11017设置。以当前 robotWorldPose 计算 `camera.x = robot.x - .43*sin(heading)`、`camera.z = robot.z - .43*cos(heading)`、`camera.y = .105 + .54`，与三帧矩阵平移的最大误差依次为0、1.1102230246251565e-16、0。这也未显示“三次运行同样使用上帧平移”的现象。

三份 manifest 的 capture-hook SHA256 均为 `a4b0552e8e162c9d0d90ed2414e69a733dec83accefedbf247904fb6ebe161f5`；app.js SHA256 均为 `55acd2843d202f83c83549d4a2640f1d995358bc654546732cbaca500ae28c83`，与所审查当前平台文件一致。

## 两份 evaluation.json 的具体差异

比较：

- `artifacts/autonomous-brain/map05-run-14/report/evaluation.json`
- `artifacts/autonomous-brain/placement-reobservation-replay-01/report/evaluation.json`

两份 `evaluator_sha256` 以及当前 `tools/evaluate_autonomous_brain.py` SHA256 都是 `f65cf386055dff76a3b8d59547bca8b9009657581310957add58bc1f495b914f`。

原 Run14 记录到r77，诊断重放在r75结束（`brain_reason=round_limit`），所以诊断没有原运行r76的这条后续冲突输入。下面的差异来自运行后缀与整局关联集合不同，不是评测被调优。保留现有保守全局评测、原历史结果与所有门槛，不因本审查修改它们。

| 字段 | 原 Run14 | placement-reobservation-replay-01 |
|---|---|---|
| target_029 的 target-1 binding_evidence | 59条 | 完全相同的59条 |
| target_029 的 target-2 binding_evidence | 1条，obs576 | 无 |
| ambiguous_track_ids.target_029 | `[guangyang-target-1, guangyang-target-2]` | 无 |
| track_truth_bindings.target_029 | 无 | `guangyang-target-1` |
| r26 pick Judge | unverifiable / missing_or_ambiguous_truth_binding | match / independent_success=true |
| r37 place Judge | unverifiable / missing_or_ambiguous_truth_binding | match / independent_success=true |

`perception.binding_evidence` 中 target_029 的两份列表，唯一差异是原 Run14 多出的：

```json
{"observation_index":576,"round":76,"frame_id":"576","tick":22609,"simulation_seconds":452.18,"track_id":"target_029","truth_id":"guangyang-target-2","bbox":{"x":46,"y":0,"w":594,"h":480},"method":"unique_same_frame_projected_center_in_exact_bbox"}
```

原 `brain/observations.jsonl` 第576帧有这一红色大框；其转换结果为 `track_id=target_029`、`known_delivered_object_id=target_029`、`reason=matches_verified_placement`，raw distance9cm、raw bearing3.17°、delivered_match_distance_m=.05982438073985326。这里仅记录感知与离线几何匹配输出之间发生冲突，不据此另行断言该框可见的是哪个物理球。

`evaluate_perception()` 在 evaluator:305–311先扫描整局观测，把每条同帧几何对应加入 `bindings[track_id]` 集合；仅集合大小为1的轨迹进入最终 resolved 表。`evaluate_judge()` 在514–517对所有历史动作统一查询该最终表。因此 r76 的新冲突会使早先 r26/r37 的 target_029 也变为 unverifiable。它不是只使用动作结束时已经可用的身份依据。

可复算的时间前缀：target_029 在 obs162（r26结果结束）之前有33条 target-1 绑定；obs273（r37结果结束）之前有38条；obs555和575之前有59条，均无第二身份。到obs576才成为60条、两个身份。诊断的r26动作窗口是obs150–162/tick5097–5453，r37为obs254–273/tick10851–11378。

因此现有整局保守身份汇总规则足以解释这一差异。它并未证明原早期动作失败，也没有在这两条动作上给出 false_positive；它给出的是缺乏整局一致绑定而无法核验。不能把晚期大框产生的第二身份对应表述成“早先的正确对应已被证明错误”。本报告仅补充动作时间前缀与晚期冲突来源的作用域说明，保留原全局歧义标记，不改写历史评测，也不以多数票替代唯一性。
