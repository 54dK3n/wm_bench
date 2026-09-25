# WorldModel + 单动作大模型自主小车

本轮按用户新的范围执行：平台够用即可，外部 Python 大脑每轮观测、调用大模型选择一个动作、确定性执行、再观测。octos 编排、技能契约和逐条确定性验收暂缓。历史 v4 严格 FAIL 报告保留，其召回率与跨运行时浮点复算不再阻挡本轮开发。

## 平台入口

[新运行的够用门禁](../artifacts/autonomous-brain/fresh-map05-gate-20260925/REPORT.md) 使用两次固定 explore、look_around 脚本，经外部大脑和真实机器人桥执行。逐条桥检测一致性和四类非空均通过；模型端是固定诊断桩，不是正式任务验收。短路线的指定距离窗应见数为零，不能用它评价召回；[历史长路线复算](../artifacts/autonomous-brain/platform-gate-20260925/REPORT.md) 另保留非零应见统计。召回率和两次检测比较只报告，全部旧日志不变。

平台分支为 [v4/robot-backend](https://github.com/54dK3n/wm_bench/tree/v4/robot-backend)，接口文档在该分支的 `projects/car-python/docs/robot-backend-bridge.md`。`virtual-cv` 来源保留，不改标成 YOLO。外部脑只取得桥客户端凭证，不取得页面、控制端、地图、任务真值或 record 访问能力。

## 运行

检出平台分支到 `workspaces/guangyang-platform`，或用 `GUANGYANG_PLATFORM_ROOT` 指定其 `projects/car-python` 目录。需要 Python、Node.js 和 Chrome；沿用本仓库已有的依赖与浏览器驱动环境。

driver v4 默认读取仓库根目录的 `.env.local`，无需每次手工 `export`。首次配置可复制无密钥的 [`.env.example`](../.env.example) 为 `.env.local`，填入 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，随后运行：

```sh
node tools/autonomous_brain_driver.js --out artifacts/autonomous-brain/map05-run-01
```

`.env.local` 已被 Git 忽略，不应提交或放入运行报告。读取器接受上述三个必需键，以及可选的 `LLM_TEMPERATURE` 和 `LLM_THINKING`，忽略其他键；进程环境中已存在的同名变量优先（包括空值）。支持简单 `KEY=value`、单引号或双引号值、空行和 `#` 注释，未加引号的行尾注释前需留空格。不执行 shell、变量替换或转义展开。配置错误只报告行号或配置键，不输出值或文件内容。离线模型回放不读取此文件，也不要求模型凭据。

输出目录必须不存在。driver 在平台外启动 `python3 -m autonomous_brain.run`，通过 stdin 仅传客户端能力、自然语言指令和运行上限。布局选择、真值捕获和成绩核验全在评测侧。大脑不接收地图名称或球的总数。

WorldModel 依赖来自官方 main，当前锁定 `fef0ba9b754ce9652836fdb720d1162dcadbc5ef`；默认使用仓库已保存的 `vendor/wm_kit_opt2`，也可设置 `WORLD_MODEL_ROOT` 指向同一版本。明确调用 `guangyang_static_world_model(max_range_m=0.9)`，不修改上游状态阈值。

上限为 200 轮和仿真 1200 秒，到限失败。driver 同时给平台设置 1200 秒硬上限。`--max-rounds`、`--max-simulation-seconds` 只允许降低上限，供联调使用；联调结果不充当正式成功局。

大模型请求为兼容 Chat Completions 的 HTTP 请求，temperature 默认 0，要求 JSON 对象。`LLM_TEMPERATURE` 允许显式设置有限的 0–2 数值；`LLM_THINKING` 可设 `enabled` 或 `disabled`，未设置时不向服务商发送该参数。任务要求仍以用户最新授权为准，模型不接受原参数时不能自动换温度。仅不合法输出重试一次，仍非法停止；网络或 HTTP 错误立即停止，不自动降级模型、温度或输出格式。日志记录实际请求参数，不记录 API 密钥或机器人凭证；回放从记录恢复采样参数。客户端 v5 将默认单次网络等待上限设为 180 秒，并在新调用日志的 `transport_timeout_s` 记录实际值；这不改变 1200 秒仿真上限，网络错误仍立即停止。旧版本记录回放不补写新字段。

## 大脑模块

- `autonomous_brain/run.py`：观测循环、紧凑状态、最近五轮结果和全量日志。
- `autonomous_brain/bridge.py`：12 个白名单方法，单个确定性 requestId 不重复执行，调用日志立即写盘。
- `autonomous_brain/perception.py`：bbox 恢复原检测器测距、原版 M5、WorldModel 更新与动作证据归档。
- `autonomous_brain/navigation.py`：只用里程计与当前相对出口建立道路采样点和路口记录；区分选择过的出口与已走通的路段。
- `autonomous_brain/actions.py`：explore、look_around、go_to、pick、place、done。go_to/pick 开始前必须 CONFIRMED；抓取最多三次；每次运动后有新观测。
- `autonomous_brain/llm.py`：单动作 JSON 校验、完整调用输入输出、耗时和严格输入匹配的离线模型回放。

红蓝球使用旧 demo 的 M5 参数和有效测距窗口，不以近距重复帧增加确认次数；静态配置要求三次独立视点，间距至少 15cm。已确认轨迹在近距被双向唯一匹配时，仅刷新看见时刻与帧信息，不修改位置、置信度、状态或命中数；实际未见和匹配歧义仍正常衰减。近距框用于视觉对准，最终接近用已确认位置与里程计控制，采用 demo 的 22cm 记忆停点及失败后 6cm 小步，最多三抓；不把 M5 的近场外推值当精确抓距。绿色地面不是旧立式标牌，使用相机内外参作地面投影。障碍条纹框经过扩框，反演位置明确标为近似。

[感知离线复放](../artifacts/autonomous-brain/perception-replay/v4-map05-run1/REPORT.md) 核对了全部红蓝球读数，并明确列出旧日志缺少同 tick 里程计而无法喂给 WorldModel 的帧；没有用真值补齐输入。长期未重见的轨迹仍按上游配置衰减，不能绕过 CONFIRMED 前置条件。

pick 使用 holding 和原位置再次观测；持物但身份不明时保留待核验状态。place 需空夹爪和新球相对绿色检测框的包含证据；旧的已送达球不能充当新球证据。当前相机只给绿色区域 bbox，框内椭圆检查是几何估计，并非逐像素掩码证明；遮挡仍可能导致判定错误。落点歧义或证据不足报失败，未验证释放会保留未解决状态，当前没有完整恢复路径。动作程序的推断须由独立 record/真值评测核对，不能把动作自报成功当任务成功；抓放流程尚未取得本轮真实任务成功证据。

## 日志与复算

每局 `brain/` 保存：

- `rounds.jsonl`：每轮状态、大模型输出、动作及观测判定。
- `llm.jsonl`：每次调用完整请求、响应、模型、耗时、校验或错误；包括修复尝试。
- `observations.jsonl`：原始桥检测、同 tick 里程计、局部道路、夹爪、转换依据与物体表。
- `motions.jsonl`、`bridge-calls.jsonl`：小动作及执行前后观测引用、HTTP 往返。
- `summary.json`：轮数、调用次数和耗时、仿真用时、轨迹时间线、最终状态、源码摘要。

driver 保存 `record.json.gz`、`samples.json.gz`、`sensor-audit.json.gz` 和 `captures.json.gz`。gzip 为无损压缩，原 PNG 字节仍在 record；`evidence.json` 给出压缩前后的 SHA256。真值文件只在脑退出后落盘，不传给脑。

独立评测：

```sh
python3 tools/evaluate_autonomous_brain.py \
  --input artifacts/autonomous-brain/map05-run-01/map-05-run-1 \
  --out artifacts/autonomous-brain/map05-run-01/report
```

评测同时核对未撤销的 package_delivered 事件和最终存放区内位置，报告原始首次看到、WM 首次入库、确认、抓到、送达与位置误差。身份只能由同帧真值投影与检测框唯一匹配建立；歧义明确报告，不能按 WM id 猜球的真实身份。

LLM v6 uses streaming transport and waits for `[DONE]` before validating a single action. Raw SSE and partial responses remain in `llm.jsonl`. No transport retry is added; legacy recordings retain their original non-streaming requests. See `artifacts/autonomous-brain/llm-streaming-fix-20260925/REPORT.md`.

模型回放调试（不访问模型 API，仍使用本地机器人桥）：

```sh
node tools/autonomous_brain_driver.js \
  --replay artifacts/autonomous-brain/map05-run-01/map-05-run-1/brain/llm.jsonl \
  --out artifacts/autonomous-brain/map05-replay-01
```

全仿真调试必须使用原局冻结源码；输入状态不匹配时停止并报告，不伪造对应输出。本轮不要求逐条 record 确定性作为门禁。

仅复核已保存的状态与模型决策，不运行机器人、禁止网络和环境读取：

```sh
python3 tools/replay_brain_llm.py \
  --input artifacts/autonomous-brain/map05-run-01/map-05-run-1/brain \
  --out artifacts/autonomous-brain/map05-llm-replay-new
```

它要求调用记录全部耗尽、除 `mode` 外完整记录相同；动作执行失败不会被误计为模型输出失败。这项核验不代表全仿真复跑或任务成功。

只有 map-05 正式成功后，才可凭保存的成功局运行十布局：

```sh
node tools/autonomous_brain_driver.js \
  --map05-success artifacts/autonomous-brain/map05-run-01/map-05-run-1/evaluation.json \
  --maps map-01,map-02,map-03,map-04,map-05,map-06,map-07,map-08,map-09,map-10 \
  --out artifacts/autonomous-brain/ten-layouts-01
```

十布局只报告成败与原因。当前是否存在正式成功局，以最新交付报告为准；单测和假模型联调不代表任务通过。
