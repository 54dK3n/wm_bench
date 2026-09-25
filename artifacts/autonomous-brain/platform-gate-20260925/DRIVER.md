# 外部大脑仿真 driver

版本：`wm-autonomous-brain-driver/v3`。实现：`tools/autonomous_brain_driver.js`。

默认只跑 map-05 一局，使用平台本地服务及无界面 Chrome。运行前通过 `tools/fresh_map05_platform_gate.js` 独立核对 smoke02 原始证据中的两项平台门禁，再将 `--platform-root` 或 `GUANGYANG_PLATFORM_ROOT` 指定的平台源码与已记录 SHA256 比较。固定预检见 `artifacts/autonomous-brain/fresh-map05-gate-20260925/preflight-gate.json`。旧的召回、record 确定性和动画相位不再作为新门槛。

```sh
node tools/autonomous_brain_driver.js --out artifacts/autonomous-brain/map05-run-01
```

Python 解释器可由 `--python` 或 `BRAIN_PYTHON` 指定。需配置 `WORLD_MODEL_ROOT`、`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`；driver 不把环境变量值写入清单。回放可传 `--replay <已有 llm.jsonl>`；是否离线由 Python 客户端执行。

Python 子进程实际入口：

```sh
python3 -m autonomous_brain.run --out <本局目录>/brain
```

子进程 stdin 只传一次如下 JSON；实际 capability token 不落盘：

```json
{
  "schema": "autonomous-brain-robot-config/v1",
  "origin": "http://127.0.0.1:<port>",
  "bridge_id": "<limited robot capability>",
  "client_token": "<limited robot token>",
  "task": "把地图上的红球都送到绿色存放区",
  "simulation_step_ms": 20,
  "max_rounds": 200,
  "max_simulation_seconds": 1200
}
```

大脑接收不到 map 身份、球数量、布局、truth、页面会话及 controller token。地图选择和 CDP 页面控制仅由评测进程执行；真值文件在大脑退出后才写入该局目录。平台自身硬上限也设置为 1200 仿真秒；视觉证据数量及大小默认无限制。driver 另设 7200 秒墙钟保护，可由 `--wall-timeout-seconds` 指定；`--max-rounds` 和 `--max-simulation-seconds` 可降低上限以调试，不允许提高到超过 200 轮或 1200 秒。

输出每局目录 `<out>/map-05-run-1`：

- `brain/`：Python 原生逐轮状态、动作、结果、观测及 LLM 日志。
- `record.json.gz`：原始完整 record 的无损 gzip，包含原始 PNG 证据。
- `samples.json.gz`、`sensor-audit.json.gz`、`captures.json.gz`：仅供评测的原始采样、内部检测及真值相机帧绑定。
- `evidence.json`：压缩文件和解压内容分别记录 SHA256、字节数。
- `evaluation-map.json`、`envelope.json`、`evaluation.json`：布局归属、平台状态和实际送达结论。
- `brain-stdout.txt`、`brain-stderr.txt`：Python 进程诊断。

`captures` 每条含 `frameId`、`tick`、`stateRevision`、`stepMs`，相机矩阵/内参，机器人真实位姿 `robotWorldPose`、里程计原点 `odometryOrigin`，`worldUnitsToMeters=0.125`，持物真值及每个物体的世界坐标。它在相机真实渲染边界同步采样，供离线 WM 误差计算；不参与大脑动作。

独立送达判定要求每个评测红球都有尚未撤销的 `package_delivered` 事件，且最后真值采样位置位于绿色存放区半径内、夹爪未持有。到时间上限、未完成日志、桥越权、进程/控制器错误均失败；不使用旧比赛分数。

map-05 成功前其他布局不启动。成功后可运行 10 个布局（以下成功证明文件需确实通过，driver 会解压记录重算真值及 SHA256）：

```sh
node tools/autonomous_brain_driver.js \
  --out artifacts/autonomous-brain/ten-layouts-01 \
  --map05-success artifacts/autonomous-brain/map05-run-01/map-05-run-1/evaluation.json \
  --maps map-01,map-02,map-03,map-04,map-05,map-06,map-07,map-08,map-09,map-10
```

这份文档描述 driver 契约。当前门禁 PASS 不等于自主任务已成功，需以正式脑运行产出的真值验收为准。
