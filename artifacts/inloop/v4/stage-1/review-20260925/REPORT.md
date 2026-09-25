# v4 阶段 1 复核：FAIL / STOP

复核版本：`wm-v4-stage1-review-20260925-r1`。本次停在阶段 1，不继续阶段 2–5，也不宣称已完成 v4 map-05 demo。平台实现未修改，历史实验目录未覆盖。

## 阻塞原因

`robot-backend-runtime.js:42` 只接收 `item.source === "yolo"` 的物体检测。但 `vision.js:707–728` 在仿真模式禁用 YOLO，实际调用像素检测器；`vision-pixel-core.js:61` 将其来源固定为 `virtual-cv`。所以底层已检测到的红球、蓝球、障碍到不了外部大脑。

此外，桥用 `colorClass` 转换红/蓝球类别，而 `virtualPointDetection()` 没有该字段。只放宽来源过滤仍不足以接通红/蓝球。修复必须依据像素检测的外观类别输出，不允许用任务锚点、物体真值或布局角色来填检测。

绿色地面检测走独立路径；本次绿色像素 fixture 可以通过桥。因此不能笼统声称所有相机检测都失效，也不能把旧原生存放点标识检测等同于新的绿色地面检测。

## 原始六局记录直接证明断链

同一帧按 `frameId` 对齐，比较 `record.native.inputs` 中的 `vision_query/observe` 和 `record.calls` 中桥的 `observe` 返回：

| 布局 | 每次运行原生三帧检测数 | 每次运行桥三帧检测数 | 运行次数 |
|---|---|---|---|
| map-03 | 3、3、6 | 0、0、0 | 2 |
| map-05 | 4、4、6 | 0、0、0 | 2 |
| map-10 | 5、5、8 | 0、0、0 | 2 |

六局共 18 次观测：每帧原生检测非空，桥输出全部为空。map-05 第一帧的原生检测为 3 个障碍与 1 个蓝色物体（内部类别 `distractor`）。这些是原生**视觉检测日志**，不是用真值推断检测器应该看到了什么。桥的输入帧、内部检测与返回结果来自同一条保存记录。

逐帧结果、原始文件 SHA256 和复算检查见 [evidence-audit.json](evidence-audit.json)。历史 `acceptance-01/acceptance.json` 仍保留当时的通过结论；本报告更正当前阶段门禁，不重写旧结果。

## 最小离线复现

复现运行真实 `vision.js`、像素检测器和未修改的桥 `observe` 函数；只替换画布、已完成捕获的就绪返回及评测日志写入。输入是可由脚本重建的 RGBA 图形，不读取布局坐标。

| 像素 fixture | 底层检测有效 | 桥含期望类别 | 结果 |
|---|---|---|---|
| 红球 | 是 | 否 | FAIL |
| 蓝球 | 是 | 否 | FAIL |
| 障碍 | 是 | 否 | FAIL |
| 绿色地面 | 是 | 是 | PASS |

结果 1 通过、3 失败，脚本退出码为 1。完整像素参数、输入 SHA256、底层检测、桥输出在 [sensor-probe.json](sensor-probe.json)；源文件 SHA256 与函数摘要在 [manifest.json](manifest.json)。这是适配器边界复现，**不是新增的一局浏览器仿真验收**。

复算（仓库根目录，输出文件或目录必须尚不存在）：

```sh
node tools/v4_stage1_archive_review.js --out /tmp/v4-stage1-audit-new.json
node tools/v4_stage1_sensor_probe.js --out /tmp/v4-stage1-probe-new
```

归档审计成功写出诊断时退出码为 0，结论见 JSON 的 `stage1Decision`；相机探针当前应退出 1，并保存 `allPass: false`。不要把探针预期发现缺陷的退出码改成成功。

## 仍然成立的旧证据

- map-03、map-05、map-10 各两次完整 record 逐字节相同；不删字段、不放宽容差。
- 原验收 manifest 中的平台源文件 SHA256 仍匹配当前文件。
- 旧接口的拒绝记录仍保留；此次缺陷不是通过放宽白名单解决。

这些检查只能证明已有脚本的确定性与边界行为，不能证明非空相机检测已经接通。

## 版本与工作区状态

平台分支 `v4/robot-backend`，提交 `3817902b39ba0322fdcee80afb1fa57087c6b5eb`，本次未修改。接口文档和原 Git bundle 继续保留在上级目录；接口文档描述的是预期契约，当前实现存在上述缺陷。运行时文件 SHA256：`912306436ce285acc9195364f5250e1404d6edc6dc6c6b23a658b5bf2ecc6e16`。

主流程曾依据已有通过结论与 record/SHA 复算结果建立独立工作副本并启动阶段 2 分工；独立源码复核发现阻塞后立即中断。两个副本没有新增实现或未提交改动：

- `workspaces/octos_robots/`：`codex/v4-autonomous-loop`，基线 `dbc9fb2db36f8b459894951048598f8ae20598e8`。
- `workspaces/WorldModel/`：`codex/v4-perception-memory`，基线 `fef0ba9b754ce9652836fdb720d1162dcadbc5ef`。

没有进行 LLM 调用、阶段 2 验收、感知投影优化、技能实施或后续仿真。本次改动仅为复核脚本、新失败证据与当前状态文档，完整 SHA256 清单见 [revision-manifest.json](revision-manifest.json)。原 octos 工作目录的未提交改动保持原样。

## 恢复时的阶段 1 工作

在独立平台分支修复来源和外观类别适配，保留像素框与原始帧的一致性，增加非空红球、蓝球、障碍和绿色存放区的桥集成检查。之后在新目录重跑原三布局、各两次的完整验收；仍要求 record 逐条相同和白名单拒绝。通过之前不进入阶段 2。
