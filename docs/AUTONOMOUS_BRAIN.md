# WorldModel + 单动作大模型自主小车

[第二十局](../artifacts/autonomous-brain/map05-run-20/FAILURE_ANALYSIS.md)已结束：**整体FAIL，实际有效交付2/2**。200轮、216次模型调用、1376次观测，仿真1077.68秒；模型耗时2591.529288086秒，另有1秒重试等待。两次原生交付分别在234.04秒和564.44秒，终态都在存放区且未持有；白名单外调用为0。结束原因是round_limit，未自主done；末态仍有13个未探索出口和一个待确认红球假设，没有外部停止、墙钟超时或未恢复模型错误。

原评测器v4的全局身份绑定有歧义：4次抓放unverifiable，WM误差0有效/96未匹配，均值和RMSE为null；不能解释成零误差。[另列的时间前缀诊断](../artifacts/autonomous-brain/run20-binding-review-20260926/REPORT.md)使用每次动作当时全部已有观测，4次抓放均match；首次标签冲突前94个有效样本，平均误差5.091221cm、RMSE5.709667cm，另2个持物后样本仍排除。该诊断不替代原全局结果或正式FAIL。

此前状态：[第十九局](../artifacts/autonomous-brain/map05-run-19/FAILURE_ANALYSIS.md)已完整归档，**整体FAIL，实际有效交付1/2，第二球仍持有，未自主done**。冻结提交`609772040d00f35e3ec6e25cfa5433894be4e5a7`；163轮、173次模型调用、1022次观测、691.66仿真秒，模型请求累计2679.6163993769987秒，另有2秒重试等待。11次explore在零进展且新观测无节点/出口时自报到达，评测方正常停止；末轮NOT_RUNNING是外停错误，不是墙钟超时或模型终止。

第二十局已完整结束，生产内容冻结于`6ee4abf464504eb297242df98dc9fadaaf7debfa`，启动时HEAD为仅更新文档的`44247e0`，正式200轮/1200仿真秒上限保持；没有自主done，整体FAIL。actions v19的140轮原记录仿真诊断已完成：前139轮结果及前926条观测完全一致，到原故障点后仅依据公开传感新增转向和4cm前进请求，新观测真实出现节点与三个出口，定向恢复PASS。诊断整体因140轮上限仍为FAIL，不作正式成功门票。done旧条件未修改，用户对完成范围的澄清仍待答复；十布局未开始。

driver v6默认`--wall-timeout-seconds 0`，表示关闭额外墙钟限制；显式正值仍可用于诊断，并写入运行元数据。200轮/1200仿真秒上限和成功判据不变。评测器v4仅增加driver v6来源格式兼容，[修复与验证](../artifacts/autonomous-brain/driver-wall-limit-fix-20260926/REPORT.md)已保存。此前第十八局独立确认实际有效交付2/2，但额外两小时墙钟限制终止进程、缺大脑摘要且未自主done，整体FAIL。

本轮按用户新的范围执行：平台够用即可，外部 Python 大脑每轮观测、调用大模型选择一个动作、确定性执行、再观测。octos 编排、技能契约和逐条确定性验收暂缓。历史 v4 严格 FAIL 报告保留，其召回率与跨运行时浮点复算不再阻挡本轮开发。

平台够用门禁已通过，Kimi K2.6已配置为用户批准的非思考模式、温度0.6。当前尚无正式自主完成的map-05成功局，十布局未开始。第十九局使用上述冻结提交完成正式运行，FAIL结论保留；第十八局冻结提交`258ebab8555344805eabd1c5b2fe4773d97d7df2`的完整证据与FAIL结论保留。第十七局从冻结提交`33b16ca7ea5c849bfecb080353cdd4f28d8bcd62`运行完毕，仍为FAIL：实际交付1/2，但首次放置的观测判定漏判并进入当前实现无法恢复的释放未验证状态。

此前第十六局实际有效交付0/2，第十五局1/2，均因连续模型服务错误耗尽当时的重试上限而失败。第十四局及后续诊断的物理交付2/2也未满足完整自主完成条件，保留FAIL。全部历史日志和结论保持不变；当前状态见[CURRENT_REPORT.md](../artifacts/autonomous-brain/CURRENT_REPORT.md)，正式运行索引见[LIVE_RUNS.md](../artifacts/autonomous-brain/LIVE_RUNS.md)。

## 平台入口

[新运行的够用门禁](../artifacts/autonomous-brain/fresh-map05-gate-20260925/REPORT.md) 使用两次固定 explore、look_around 脚本，经外部大脑和真实机器人桥执行。逐条桥检测一致性和四类非空均通过；模型端是固定诊断桩，不是正式任务验收。短路线的指定距离窗应见数为零，不能用它评价召回；[历史长路线复算](../artifacts/autonomous-brain/platform-gate-20260925/REPORT.md) 另保留非零应见统计。召回率和两次检测比较只报告，全部旧日志不变。

平台分支为 [v4/robot-backend](https://github.com/54dK3n/wm_bench/tree/v4/robot-backend)，接口文档在该分支的 `projects/car-python/docs/robot-backend-bridge.md`。`virtual-cv` 来源保留，不改标成 YOLO。外部脑只取得桥客户端凭证，不取得页面、控制端、地图、任务真值或 record 访问能力。

## 运行

检出平台分支到 `workspaces/guangyang-platform`，或用 `GUANGYANG_PLATFORM_ROOT` 指定其 `projects/car-python` 目录。需要 Python、Node.js 和 Chrome；沿用本仓库已有的依赖与浏览器驱动环境。

driver v6 默认读取仓库根目录的 `.env.local`，无需每次手工 `export`。首次配置可复制无密钥的 [`.env.example`](../.env.example) 为 `.env.local`，填入 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`。以下为第二十局实际启动命令，前置定向诊断已通过；重跑须改用尚不存在的新输出目录：

```sh
node tools/autonomous_brain_driver.js --out artifacts/autonomous-brain/map05-run-20
```

`.env.local` 已被 Git 忽略，不应提交或放入运行报告。读取器接受上述三个必需键，以及可选的 `LLM_TEMPERATURE` 和 `LLM_THINKING`，忽略其他键；进程环境中已存在的同名变量优先（包括空值）。支持简单 `KEY=value`、单引号或双引号值、空行和 `#` 注释，未加引号的行尾注释前需留空格。不执行 shell、变量替换或转义展开。配置错误只报告行号或配置键，不输出值或文件内容。离线模型回放不读取此文件，也不要求模型凭据。

输出目录必须不存在。driver 在平台外启动 `python3 -m autonomous_brain.run`，通过 stdin 仅传客户端能力、自然语言指令和运行上限。布局选择、真值捕获和成绩核验全在评测侧。决策状态不包含地图名称或球的总数。

WorldModel 依赖来自官方 main，当前锁定 `fef0ba9b754ce9652836fdb720d1162dcadbc5ef`；默认使用仓库已保存的 `vendor/wm_kit_opt2`，也可设置 `WORLD_MODEL_ROOT` 指向同一版本。明确调用 `guangyang_static_world_model(max_range_m=0.9)`，不修改上游状态阈值。

上限为 200 轮和仿真 1200 秒，到限失败。driver 同时给平台设置 1200 秒硬上限。`--max-rounds`、`--max-simulation-seconds` 只允许降低上限，供联调使用；联调结果不充当正式成功局。

大模型请求为兼容 Chat Completions 的 HTTP 请求，temperature 默认 0，要求 JSON 对象。`LLM_TEMPERATURE` 允许显式设置有限的 0–2 数值；`LLM_THINKING` 可设 `enabled` 或 `disabled`，未设置时不向服务商发送该参数。用户已批准本机 Kimi K2.6 非思考模式、温度 0.6；程序不会按服务错误自动改模型或温度。完整但不合法的输出最多修复一次，仍非法就停止。

客户端默认网络重试为0；runtime v9正式设为5，仅对列明的瞬态连接错误重发相同请求，最多初次加五次，等待1、2、4、8、16秒。每次失败和重试均完整记录，永久错误立即停止，耗尽后整局失败。非法JSON仍只允许修正一次；网络恢复不改变模型、温度、动作或成功判据。连接/读取等待参数仍为180秒，记入`transport_timeout_s`，不是整次请求耗时的硬上限；调用耗时与重试等待分别保存。见[有限网络恢复验证](../artifacts/autonomous-brain/llm-recovery-fix-20260926/REPORT.md)。

历史runtime v7–v8使用的最多两次网络重试及1/2秒等待仍可按原记录回放；更早缺失重试字段时按0处理，不补写字段、不联网或等待。LLM v12新增阶段、已捕获响应字节数及URLError底层类型/数值errno等安全诊断，不记录异常文本、URL或凭据。HTTP错误在打开请求时发生但随后读到错误正文，主失败阶段仍为open；读取错误正文自身失败则为read_body。旧v1–v11记录保持原结构，新增诊断不会倒填进旧日志。原[连接重试报告](../artifacts/autonomous-brain/llm-retry-fix-20260925/REPORT.md)保持不变。

## 大脑模块

- `autonomous_brain/run.py`：观测循环、紧凑状态、最近五轮结果和全量日志。
- `autonomous_brain/bridge.py`：12 个白名单方法，单个确定性 requestId 不重复执行，调用日志立即写盘。
- `autonomous_brain/perception.py`：bbox 恢复原检测器测距、原版 M5、WorldModel 更新与动作证据归档。
- `autonomous_brain/navigation.py`：只用里程计与当前相对出口建立道路采样点和路口记录；区分选择过的出口与已走通的路段。
- `autonomous_brain/actions.py`：explore、look_around、go_to、pick、place、done。go_to/pick 开始前必须 CONFIRMED；抓取最多三次；每次运动后有新观测。环视使用八个45°方向，原地旋转不增加独立位置命中。
- `autonomous_brain/llm.py`：单动作 JSON 校验、完整调用输入输出、耗时和严格输入匹配的离线模型回放。

navigation v4统一路口更新、当前出口读取和出口选择的节点定位：均使用严格小于15cm范围内的最近节点，完全等距时保留插入顺序。原v3在更新时选最近节点、读取和选择时却选首个符合范围的节点，会把相邻路口的出口状态读错或写错。修复不扩大距离/角度门限、不合并或删除节点，不直接关闭探索义务。原传感日志复现、失败基线和[正式修复验证](../artifacts/autonomous-brain/road-node-locator-fix-20260926/REPORT.md)均保留；全套567项brain测试通过。

红蓝球使用旧 demo 的 M5 参数和有效测距窗口，不以近距重复帧增加确认次数；静态配置要求三次独立视点，间距至少 15cm。已确认轨迹在近距被双向唯一匹配时，仅刷新看见时刻与帧信息，不修改位置、置信度、状态或命中数；实际未见和匹配歧义仍正常衰减。近距框用于视觉对准，最终接近用已确认位置与里程计控制，采用 demo 的 22cm 记忆停点及失败后 6cm 小步，最多三抓；不把 M5 的近场外推值当精确抓距。绿色地面不是旧立式标牌，使用相机内外参作地面投影。障碍条纹框经过扩框，反演位置明确标为近似。

Perception v7保留曾确认的LOST身份与新轨迹的独立历史。新红球轨迹自己满足原三位置确认后，才可在原30cm同类门控内，与历史身份建立双向唯一的重获绑定；竞争集合包含暂定、陈旧及其他历史轨迹，操作生命周期不能充当历史重获来源。绑定是数据关联假设，不能独立证明物理身份。`go_to/pick`仍只接受当前CONFIRMED身份；完成判定仅在完整无歧义绑定链的后继具有原抓放证据、状态为DELIVERED后，解除对应历史义务。旧LOST状态、位置与时间线不改写，证据缺失、循环或未验证释放仍待处理。

[感知离线复放](../artifacts/autonomous-brain/perception-replay/v4-map05-run1/REPORT.md) 核对了全部红蓝球读数，并明确列出旧日志缺少同 tick 里程计而无法喂给 WorldModel 的帧；没有用真值补齐输入。长期未重见的轨迹仍按上游配置衰减，不能绕过 CONFIRMED 前置条件。 从未确认且已归档的 LOST 红球可按完整历史标记为退役假设，保留原轨迹与证据；它不表示真实球不存在或已送达。已确认 LOST、持物、释放未验证及历史缺失的对象仍待处理。

pick 使用 holding 和原位置再次观测；持物但身份不明时保留待核验状态。place 需空夹爪和新球相对绿色检测框的包含证据；旧的已送达球不能充当新球证据。当前相机只给绿色区域 bbox，框内椭圆检查是几何估计，并非逐像素掩码证明；遮挡仍可能导致判定错误。动作程序的推断须由独立record/真值评测核对，不能把动作自报成功或两球物理送达当作完整自主任务成功。

actions v16增加同次place内的有限复观测：仅在释放后夹爪为空、合格见证数为0、且非空红检测全部属于旧已送达身份时，先按原放置轨迹归路；归路成功且onRoad后，最多尝试2个各16cm的沿路视点。每个视点最多4次前进，每步请求不超过4cm，转向后的新观测和每步新的道路方向、出口与净空证据授权下一步；受阻、离路或里程计运动不符时停止。已观察绿色区域的唯一最大完整分量仅用于瞄准相机，其记忆位置不参与交付判定。

复观测成功必须在同一新帧中仍识别原先那些已送达球，并额外得到唯一新球/完整绿色区域像素见证；旧球消失后出现一个未知框不够。沿用原夹爪、像素内椭圆、预存身份排除、释放帧/时间和身份校验，不降低M5有效窗口、三位置确认或CONFIRMED前置条件。两个视点仍无独立见证或其他证据不足时，place失败并保留RELEASED_UNVERIFIED；这不是跨轮任意恢复全部未验证释放的接口。完整日志保存初始判断和各视点证据；runtime v8在最近动作紧凑状态中保留最终判断、复观测原因及视点数、旧球重见身份和归路依据，供下一次模型决策读取。

v16修复的[严格75轮仿真诊断](../artifacts/autonomous-brain/placement-reobservation-replay-01/DIAGNOSTIC.md)已完成，90条原调用全部输入匹配、无新模型调用，但仅完成一个15.940812099cm视点，仍只识别旧球，诊断FAIL。离线堆叠分析不能作为脑的状态输入或补判依据。

actions v17在place开始观察到旧已送达红球时，从完整绿色分量内选择避开当前球和障碍框的候选释放瞄准点，使用相机参数投影并以里程计保持地面目标固定。候选仅用于接近；不改原19cm/3°对准预算，不将框内空白推断等同于真实无物，也不替代放后原像素见证。无候选/无有效投影则持物失败，源代码不读取平台堆叠阈值。见[选位修复报告](../artifacts/autonomous-brain/release-free-point-fix-20260925/REPORT.md)。新增36项回归，当时全部[556项brain测试通过](../artifacts/autonomous-brain/release-free-point-fix-20260925/integrated-tests-v1.txt)；严格仿真诊断取得第二球的独立像素见证及2/2真实交付，但按75轮诊断上限结束，不能视为正式自主成功。正式第十五局实际交付1/2，第十六局0/2；两局均因连续模型服务错误耗尽旧重试而结束，完整导出与失败结论保留。后续navigation v4、LLM v12/runtime v9加入了有限网络恢复，相关历史证据保留。

actions v18把固定地面瞄准点扩展到首次放置：当前完整、面积唯一最大的绿色框中心经公开相机参数和里程计投影后保持不变；中心落入当前球/障碍的既有扩展占用框则持物失败。有已送达旧球可见时保留v17左右候选规则。每步仍须新绿色检测，19cm/3°、8次平移、放后唯一新球见证均不变。全套632项brain测试通过；旧Run17的放置假阴性不回写。见[first-release-fixed-aim-fix-20260926](../artifacts/autonomous-brain/first-release-fixed-aim-fix-20260926/REPORT.md)。runtime v10另修复最后允许轮成功done误判round_limit，未增加轮数上限。

actions v19纠正执行器`stoppedBy=junction`与新观测不一致时的到达误判：成功必须来自新观测`onRoad=true / atNode=true`，take_exit还须实际位移至少0.2cm。仅执行器报告junction不构成到达或阻挡记账。此时先按公开`headingErrorDeg`对准道路切线，再以新道路方向、净空和里程计授权恢复，最多请求五次、每次不超过4cm、总请求不超过20cm。每次转向和短步后须新编号/新帧观测；无进展、几何缺失、异常运动、离路、净空不足或预算耗尽即失败。受阻返程也须真实节点观测才可声称已返回。

原道路、确认、抓放、done及200轮/1200秒门槛保持。新增38项回归通过（冻结v18基线36失败/2通过），完整671项brain测试通过；见[修复验证](../artifacts/autonomous-brain/unobserved-junction-fix-20260926/REPORT.md)和[公共输入只读反例](../artifacts/autonomous-brain/unobserved-junction-review-20260926/REPORT.md)。原Run19决策1–140的150条调用按完整原字节完成严格仿真诊断，无新模型请求；140个状态和动作、150条调用除mode外完全相同。第140轮恢复实际移动3.9824615503479683cm，观测928确认真实节点与三个出口，定向PASS。整体因140轮诊断上限仍FAIL，不作为正式成功门票；第140轮改动后的后续旧状态不得继续套用。证据见`unobserved-junction-replay-01/prefix-replay-proof.json`及`boundary-recovery-proof.json`。

## 日志与复算

每局 `brain/` 保存：

- `rounds.jsonl`：每轮状态、大模型输出、动作及观测判定。
- `llm.jsonl`：每次调用完整请求、响应、模型、耗时、校验或错误；包括修复尝试。
- `observations.jsonl`：原始桥检测、同 tick 里程计、局部道路、夹爪、转换依据与物体表。
- `motions.jsonl`、`bridge-calls.jsonl`：小动作及执行前后观测引用、HTTP 往返。
- `summary.json`：轮数、调用次数和耗时、仿真用时、轨迹时间线、最终状态、源码摘要。

driver 保存 `record.json.gz`、`samples.json.gz`、`sensor-audit.json.gz` 和 `captures.json.gz`。gzip 为无损压缩，原 PNG 字节仍在 record；`evidence.json` 给出压缩前后的 SHA256。真值文件只在脑退出后落盘，不传给脑。driver v6沿用v5的分块导出：每次传输至多65536个UTF-16字符，逐块压缩并校验序号、累计长度和结束标记；完整数据单独落盘，失败前缀保留为 `.part`，`export-status.json` 明确完整性。平台内部停止/复制仍可能失败，分块传输不等于保证验收。

第二十局已使用兼容driver v6的评测器v4完成独立评测。复算时使用尚不存在的新输出目录：

```sh
python3 tools/evaluate_autonomous_brain.py \
  --input artifacts/autonomous-brain/map05-run-20/map-05-run-1 \
  --out artifacts/autonomous-brain/map05-run-20/recomputed-report
```

评测同时核对未撤销的 package_delivered 事件和最终存放区内位置，报告原始首次看到、WM 首次入库、确认、抓到、送达与位置误差。身份只能由同帧真值投影与检测框唯一匹配建立；歧义明确报告，不能按 WM id 猜球的真实身份。

LLM 自 v6 起使用流式传输，收到 `[DONE]` 后才校验单个动作；原始 SSE 和中断时的部分响应保存在 `llm.jsonl`。旧记录仍保留原非流式请求。见[流式修复报告](../artifacts/autonomous-brain/llm-streaming-fix-20260925/REPORT.md)。

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

只有 map-05 正式成功、独立评测通过（driver v6使用兼容评测器v4）且确认正式200轮/1200秒配置与完整来源后，才可凭保存的成功局运行十布局。门票为该正式局原始trial的`evaluation.json`，同目录必须有`evidence.json`；不是独立报告目录的同名文件。每个布局使用独立driver目录，避免后续导出失败影响先前完整局的来源核验：

```sh
brain_proof='<已通过独立评测的正式局>/map-05-run-1/evaluation.json'
brain_batch=artifacts/autonomous-brain/ten-layouts-01
for brain_layout in map-01 map-02 map-03 map-04 map-05 map-06 map-07 map-08 map-09 map-10; do
  if node tools/autonomous_brain_driver.js \
    --map05-success "$brain_proof" --maps "$brain_layout" --runs 1 \
    --max-rounds 200 --max-simulation-seconds 1200 \
    --out "$brain_batch/$brain_layout"; then
    :
  fi
  brain_trial="$brain_batch/$brain_layout/$brain_layout-run-1"
  if [ -d "$brain_trial" ]; then
    if python3 tools/evaluate_autonomous_brain.py \
      --input "$brain_trial" --out "$brain_batch/$brain_layout/report"; then
      :
    fi
  fi
done
```

十布局各运行一次，失败继续下一局，只报告成败与原因；缺少运行或评测明确列为NOT_RUN/缺失，不能从历史门票的`map05Passed`推断当前图成功。当前是否存在正式成功局，以最新交付报告为准；单测和假模型联调不代表任务通过。
