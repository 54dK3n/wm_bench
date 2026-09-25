# map-05 新实跑平台门禁

平台两项门禁：**PASS**。

输入来自两次独立启动的真实平台、外部 Python 大脑和机器人桥，执行固定 `explore → look_around` 脚本。模型是本机诊断替身 `diagnostic-stub`；这份报告只验证平台接口，不是自主任务验收，也不是实际大模型验收。

必过项：每次桥检测与内部原始检测经独立固定转换后完全一致；红球、蓝球、障碍、存放区均至少出现一次。应见检出与重复检测一致性仅报告。

| 运行目录 | observe | 完全一致 | 红球 | 蓝球 | 障碍 | 存放区 |
|---|---:|---:|---:|---:|---:|---:|
| `artifacts/autonomous-brain/transport-smoke-02` | 10 | 10 | 1 | 3 | 34 | 2 |
| `artifacts/autonomous-brain/transport-smoke-03` | 10 | 10 | 1 | 3 | 34 | 2 |

独立转换复用 `tools/v4_stage1_content_audit.js`，不导入平台检测适配器：640×640 letterbox 框固定移除 80 像素上下边框并裁切，外观类别 target/distractor 映射为 red-ball/blue-ball；保留原始 source 和置信度。旧直立标牌不代表地面存放区，排除原因逐条保存；绿色区域使用独立地面像素检测输出。桥、内部规范化输出、原始检测、HTTP 调用、record 和相机帧逐条绑定。

| 类别 | 应见 | 对应类别检出 | 未检出 |
|---|---:|---:|---:|
| red-ball | 0 | 0 | 0 |
| blue-ball | 0 | 0 | 0 |
| obstacle | 0 | 0 | 0 |

应见范围：相机平面距离 30–85cm（含端点），绝对方位≤30°。统计单位为（帧，真值物体），检出只表示该帧有对应类别；同类多物体不声称已完成实例匹配。零应见类别明确表示本短脚本未验证该类召回，不另设门槛。

两次检测比较：10 对，完全相同 10 对；总体 相同（只报告）。

每项数字可从 `gate.json` 的逐帧检测、投影映射和真值几何复算，原始压缩与解压文件 SHA256 均已核对。真值仅由此离线评测器读取。原有严格验收 FAIL 和诊断失败局保持不动。

复核：

```sh
node tools/fresh_map05_platform_gate.js --inputs artifacts/autonomous-brain/transport-smoke-02,artifacts/autonomous-brain/transport-smoke-03 --out artifacts/autonomous-brain/fresh-map05-gate-20260925 --check
```
