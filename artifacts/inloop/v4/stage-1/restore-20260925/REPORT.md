# v4 阶段 1 恢复验收：FAIL / STOP

报告版本 `wm-v4-stage1-restoration-report/v2`；所有数值来自保存日志。正式运行目录：`artifacts/inloop/v4/stage-1/restore-20260925/acceptance-02`。

此前 acceptance-01 的「record 确定性」和「经桥 observe」通过结论已作废，本轮没有沿用。旧文件原样保留，状态见上级目录的 `ACCEPTANCE_STATUS.json`。

平台已修复为放行并保留 `virtual-cv`；绿色地面原生来源为 `storage-ground-pixels`，未改标为 `yolo`。平台版本 `robot-backend-v4-stage1-r2`。

## 门禁结果

| 项目 | 本轮证据 | 结论 |
|---|---|---|
| 运行完整性 | 状态 complete；6 局；执行错误项 0；套件结构错误 0 | PASS |
| a 内容一致性（按公开类别/相机坐标转换后） | 1166 次 observe；内容/绑定/帧格式失败 0；四类检测数见下 | PASS |
| b 应见必见 | 漏检 50 次；真值证据格式失败 0；不排除遮挡或按实例另设门槛 | FAIL |
| c record | 3/3 布局对逐字段相同 | PASS |
| c 相机 RGBA8 | 583/583 对应观测帧像素 SHA256 相同；配对/绑定失败 0 | PASS |
| C-ENV-001 | 实际动画配对 583/583 相同；逐帧公式复算 1076/1166 通过；各级相位/时钟证据失败 90 | FAIL |
| d 白名单 | 120/120 个负向调用拒绝码为 METHOD_NOT_ALLOWED；各局 record 审计保留 | PASS |

没有放宽任何门限或删除失败帧。阶段 1 未通过，阶段 2 保持停止。

各级失败按日志条目统计，同一观测可能产生多个失败条目；b 与 C-ENV 错误不归入 a 的内容不一致。

| 日志层级 | 失败代码（配对字段） | 条数 |
|---|---|---:|
| 观测 | `C-ENV-001_PHASE_MISMATCH` | 90 |
| 观测 | `EXPECTED_CLASS_MISSING` | 50 |
| 单局 | 无 | 0 |
| 套件 | 无 | 0 |
| 配对 | 无 | 0 |

## 按类别统计

检测条数按每帧原样输出累加，不代表不同物体的数量。

| 类别 | 桥检测条数 | 应见次数 | 检出次数 | 漏检次数 |
|---|---:|---:|---:|---:|
| red-ball | 152 | 66 | 32 | 34 |
| blue-ball | 1030 | 40 | 38 | 2 |
| obstacle | 2898 | 52 | 38 | 14 |
| storage-zone | 284 | 不适用 | 不适用 | 不适用 |

应见条件：相机原点的平面距离 30–85cm（含边界），水平 |方位|≤30°；只由评测真值计算。检出按同帧是否出现对应类别，不宣称实例召回。

| 布局/运行 | 观测帧 | 红球/蓝球/障碍/存放区检测条数 | 红球检出/应见 | 蓝球检出/应见 | 障碍检出/应见 |
|---|---:|---|---|---|---|
| map-03 / 1 | 195 | 21/181/506/48 | 6/9 | 5/6 | 4/7 |
| map-03 / 2 | 195 | 21/181/506/48 | 6/9 | 5/6 | 4/7 |
| map-05 / 1 | 193 | 22/145/471/48 | 4/6 | 5/5 | 10/12 |
| map-05 / 2 | 193 | 22/145/471/48 | 4/6 | 5/5 | 10/12 |
| map-10 / 1 | 195 | 33/189/472/46 | 6/18 | 9/9 | 5/7 |
| map-10 / 2 | 195 | 33/189/472/46 | 6/18 | 9/9 | 5/7 |

## 相位与内容检查说明

相机渲染入口快照按 `tick × stepMs / 1000` 对每个 checkpoint 的相位、旋转、透明度和高度精确复算；未设置浮点容差。若有末位差异，本轮仍保留 FAIL，不能把差异自动归因于墙钟，也不能据此静默放宽门禁。独立时钟测试另覆盖同 tick 不同墙钟、tick 推进、相机采帧禁止墙钟读取。

[浮点诊断](checkpoint-diagnostic.json) 仅分析 `map-03 / run-1`：195 帧中 22 帧有差异，涉及 23 个信号、35 个字段；字段最大差异 1 ULP。相位常量与两项线性旋转差异合计 0，elapsed 时间差异 0。这些证据符合跨运行时浮点计算差异的特征；日志缺少浏览器原始 Math.sin 输入输出等信息，尚不能确证具体根因，也不能推断其他五局具有相同原因。该诊断不改变严格门禁结果。

外观类别与坐标的固定转换及旧标牌排除口径见 `docs/V4_STAGE1_ACCEPTANCE_RULES.md`。评测器独立复算原始检测，不把桥自己的输出当预期值。排除计数（全部逐项留存，不是漏检豁免）：

- `upright_sign_is_not_ground_storage_region`：564 条。

## 版本、日志与复算

平台提交：`0e30478`（检测适配）与 `54b36f8`（C-ENV-001 测试）。
平台分支：[v4/robot-backend](https://github.com/54dK3n/wm_bench/tree/v4/robot-backend)。
评测分支：[v4/autonomous-observation](https://github.com/54dK3n/wm_bench/tree/v4/autonomous-observation)。

- [正式总表](acceptance-02/acceptance.json)
- [内容、应见与相位逐帧判定](acceptance-02/content-audit.json)
- [冻结源码 SHA256](acceptance-02/manifest.json)
- [离线复算结果](acceptance-02/recomputed.json)
- [原始 PNG 独立解码后的 RGBA 哈希核对](acceptance-02/pixel-verification.json)
- [交付文件 SHA256](delivery-manifest.json)
- [平台完整测试（含 HTTP）](platform-full-unit-tests.txt) / [平台专项离线测试](platform-unit-tests.txt) / [评测器测试](evaluator-unit-tests.txt)

每局目录包含 record、samples、captures（原始检测、桥结果、相机矩阵、真值、RGBA 哈希、动画字段）、HTTP 往返、原生 PNG 索引与评测结果。PNG 原字节也在 record 内，独立 frames PNG 不重复上传。

```sh
node tools/v4_stage1_recompute.js --input artifacts/inloop/v4/stage-1/restore-20260925/acceptance-02 --out /tmp/v4-stage1-check.json
```

从 record 中的原始 PNG 独立解码并核对 RGBA 哈希：

```sh
python3 tools/v4_stage1_verify_pixels.py --input artifacts/inloop/v4/stage-1/restore-20260925/acceptance-02 --out /tmp/v4-stage1-pixels.json
```

恢复某局原始 PNG（逐文件校验原始 SHA256）：

```sh
python3 tools/v4_stage1_extract_frames.py --record artifacts/inloop/v4/stage-1/restore-20260925/acceptance-02/map-05-run-1/record.json --out /tmp/v4-stage1-frames
```

`contentExact`、`comparisonsExact`、`executionExact` 与 `matchesOriginalVerdict` 为 true 表示忠实复算，验收是否通过看 `allPass`。复算包括原 driver 的执行状态、试验数量、各局执行错误、重新配对的 record 与源码未变门禁；原运行错误及源码未变状态来自保存日志，离线复算不重新运行仿真。

短程联调单独保留为 preflight-smoke-02；preflight-smoke-01 因沙箱禁止监听端口，未启动仿真。联调不充当六局验收。早先独立 HTTP 单测重跑曾被中断，本轮现已补齐完整测试；d 的正式六局 HTTP 拒绝记录仍单独报告。

平台完整单测日志：28/28 通过，0 失败。
