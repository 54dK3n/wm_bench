# 嘲风 WorldModel × 广阳岛 v4

本轮以自主观测闭环为目标。机器人只接收自然语言指令和传感器信息，外部大脑由 WorldModel、octos 编排与确定性技能组成。旧比赛专用规则作废；历史结果不覆盖。

执行顺序：平台后端 → 外部大脑与大模型记录/回放 → 感知与自建环境记忆 → 六个技能及观测 Judge → octos 全链路与 map-05 demo。每一阶段验收失败即停止，不进入后续阶段。

阶段 1 平台工作副本在 `workspaces/guangyang-platform/`，分支 `v4/robot-backend`。原始平台文件夹不是 Git 仓库；工作副本的 `V4_SOURCE.json` 记录来源文件摘要。用户在恢复验收时指定平台也推送到 `54dK3n/wm_bench`，故平台源码与评测分别交付在同一 GitHub 仓库的两个独立分支。工作目录与缓存不进入评测分支；旧 Git bundle 保留原样，当前源码见 [平台分支](https://github.com/54dK3n/wm_bench/tree/v4/robot-backend)。

平台只暴露相机像素检测及相机参数、里程计、局部道路感知、夹爪状态和基础运动。桥的客户端不能取得 mission、map_graph、task_state、release_preview、approach、全局道路标识或布局真值。浏览器控制端与评测 driver 单独持有初始化/导出权限；真值仅由评测保存。

阶段 1 验收使用同一个外部脚本，在三个布局分别运行两次，比较完整 v4 record；运行管理标识和主机墙钟在数据模型中单独放入 envelope，不能靠比较时删字段掩盖差异。拒绝调用也写入记录。传感器读取本身不推进物理时钟。默认不设运行时间及视觉证据总量限制，可显式配置。

当前状态（2026-09-25）：**阶段 1 恢复验收 FAIL / STOP**。`virtual-cv` 过滤断链已修复，来源未改标；旧空检测下的「record 确定性」和「经桥 observe」通过结论均已作废。新验收增加非空四类内容核对、30–85cm/±30° 应见统计、RGBA 像素摘要与 C-ENV-001 专项检查。应见漏检仍存在，严格动画公式复算也有末位数值差异，未改门限。见 [恢复验收报告](../artifacts/inloop/v4/stage-1/restore-20260925/REPORT.md)、[判定口径](V4_STAGE1_ACCEPTANCE_RULES.md) 和 [机器可读状态](../artifacts/inloop/v4/stage-1/ACCEPTANCE_STATUS.json)。不进入阶段 2–5。以下保留 2026-09-24 的历史结果，其原始日志不改写。

GitHub 的 `54dK3n/octos_robots` 已核实为未归档状态；若用户指的是其他 octos 仓库，待其补充准确地址。现有本机 octos 工作目录包含未提交改动，后续开发不得覆盖这些文件。

## 2026-09-24 阶段 1 历史验收结果（当时判为通过）

以下表格记录当时结论，不代表当前有效验收。其中「record 逐字段相同」和「经桥行驶 + observe + 里程计」两项通过结论已由用户作废，必须以恢复验收重新判定。

证据：`artifacts/inloop/v4/stage-1/acceptance-01/`（`acceptance.json` 为总表；每局目录含 record、envelope、samples、HTTP 往返记录、评测侧地图选择；PNG 帧只留本地，按 SHA256 索引）。复跑：

```
node tools/v4_stage1_acceptance.js --out <新目录>
```

| 验收项 | 结果 |
| --- | --- |
| 同一脚本在 map-03、map-05、map-10 各跑 2 次，record 逐字段相同 | 3/3 相同；record SHA256 前 16 位：map-03 `73d585556e7d98cf`、map-05 `56e9a3563d3cbaaa`、map-10 `87f3f8f8f14d391b` |
| 白名单外调用全部拒绝并记录 | 旧 Robot API 中 20 个非白名单方法每局均返回 `METHOD_NOT_ALLOWED`，服务器 trace 逐条记录方法名；被拒调用前后 tick 不变 |
| 外部脚本经桥完成沿路行驶 + observe + 里程计 | 每局 18 次调用全部完成；`follow_road` 30cm 在路口停于 27.4cm（147 tick），终点 tick 215 |
| 传感器读取与墙钟暂停不推进仿真 | 读取前后与 500ms 暂停前后 tick 均为 0 |
| 限定凭证不能访问地图配置、成绩记录、控制端 trace | 3 条路由均 403 `CLIENT_CAPABILITY_SCOPE` |

版本与 SHA256 前 16 位（全值见 `acceptance-01/manifest.json`）：驱动 `tools/v4_stage1_acceptance.js` `8ce347a8f280138d`；脑脚本 `b48d39e60fcf2644`；平台 `competition-core.js` `2b9c86e56043b0c6`、`robot-record.js` `1b43cb787b0a0530`、`robot-backend-runtime.js` `912306436ce285ac`、`robot-bridge-contract.js` `aa6e49f2c8f4c1e8`、`backend/robot-bridge.js` `3c3d93599d94763e`、`server.js` `41100f4245b8c6ca`、`app.js` `55acd2843d202f83`、`vision.js` `62274a407a689c8e`、`vision-pixel-core.js` `7627c0429e338f48`、`python-worker.js` `da03874afeb165e3`。运行前后源文件未变。

平台分支 `v4/robot-backend`（工作副本 `workspaces/guangyang-platform/`，不进 wm_bench）。交付件：`artifacts/inloop/v4/stage-1/guangyang-platform-v4-robot-backend.bundle`（基线 `99756da` 之后的 7 个提交，SHA256 `55c15c12b81df2bd`；前置基线由 `platform-baseline-source.json` 的逐文件摘要确定）；接口白名单文档 `robot-backend-bridge.md`。

平台改动清单：
1. `713588d` 视觉动画、帧编号、采样调度改按仿真 tick。
2. `285c479` 运行时间与视觉证据上限可配置，机器人模式默认不限；确定性 record。
3. `d2736a8` 本地机器人桥（仅回环、同源、控制端/客户端凭证分离、12 个白名单方法）。
4. `45eeb14` 机器人模式下绿色存放区地面可见，新增 storage-zone 像素检测。
5. `5403411` 检测类别改为外观类（red-ball、blue-ball、obstacle、storage-zone），不再输出任务角色；夹爪只报 `{holding}`；被拒方法名含数字（left_90/right_90）时 trace 不再丢名。
6. `124a7c5` 页面侧机器人后端运行时接入并由服务器提供；机器人模式不再自动结束任务、不因连续受阻暂停、不受旧动作次数上限。
7. `3817902` 发布包清单纳入新文件。

说明与已知限制：
- `smoke-01` 失败是 Codex 沙箱禁止监听端口（`listen EPERM`），未跑任何局；`smoke-02` 暴露 left_90/right_90 拒绝记录丢名，已由改动 5 修复；`smoke-03` 通过。三者均保留。
- 验收脚本的 observe 在出发点和前行 27cm 处均无检测，因此红球/蓝球/存放区检测经桥的输出尚未在仿真中实测；阶段 3 开始前需先确认。
- 平台测试 637 项中 3 项失败（注册/管理员登录，`LOCAL_LOGIN_ADMIN_ONLY`），在未改动的基线 `99756da` 上同样失败，与 v4 无关。
