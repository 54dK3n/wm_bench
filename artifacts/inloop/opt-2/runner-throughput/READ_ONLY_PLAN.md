# 下一轮并行批跑的只读方案

日期：2026-09-24（Australia/Brisbane）。本文件只调研下一轮入口；没有启动浏览器、服务、仿真或回放，没有修改当前 round-1 的程序、driver、helper、测试或账本。审查由 audit_confirmation 与 audit_batch 分工完成；所有数字来自已结束的 opt1 round-2。

结论：**可以设计为两个独立 driver 子进程并行，现有 driver 的浏览器和平台服务已按尝试隔离；不能直接同时启动两个现有批跑 runner。** 最小改动应落在下一轮的新中央调度器：一次预检与冻结、一个账本写入者、互斥布局集合、独立尝试输出。推荐先采用互斥集合，保留现有 driver 的运行与证据采集流程。是否获得接近两倍加速尚未实测，不能把物理固定步长等同于并行下所有图像逐字节一致。

## 现有隔离与共享点

| 项目 | 源码证据 | 并行判断 |
|---|---|---|
| 平台服务与数据库 | [inloop_driver.js:179](/Users/ken/Desktop/wm_bench/tools/inloop_driver.js:179) 每次 `mkdtemp(wm-inloop-)`，其下独立 `data`、`chrome-profile`；184–186 `createServer({dataDir})`、`listen(0,127.0.0.1)` | 每次独立目录和内核分配端口，没有固定 6178 冲突。 |
| Chrome / CDP | [inloop_driver.js:190](/Users/ken/Desktop/wm_bench/tools/inloop_driver.js:190) 独立 Chrome 进程、`remote-debugging-port=0`、独立 user-data-dir；84–100 从各自 profile 的 DevToolsActivePort 读取；199–204 只连接自己创建的 target/session | 不共用 9222，也不连接用户已有浏览器。保留这种粒度，不改成同一浏览器的普通双标签页。 |
| 登录与存储 | [server.js:1572](/Users/ken/Desktop/robot_competition-main/projects/car-python/server.js:1572)、1621、1648–1675、1680–1728：各 store 默认归属各自 dataRoot；1737–1745 登录尝试等 Map 在 createServer 闭包内 | 没发现默认跨实例可变登录/布局状态。不要注入共享 authStore/mapConfigStore，不要改成共享 dataDir。 |
| 数据目录锁 | [server.js:365](/Users/ken/Desktop/robot_competition-main/projects/car-python/server.js:365) 以 `wx` 创建 writer lock；411–416 拒绝仍存活的另一个写入者；4177–4179 关闭时释放 | 同一目录双开既不安全，也会被平台拒绝。独立临时目录已有保障。 |
| Cookie | [server.js:827](/Users/ken/Desktop/robot_competition-main/projects/car-python/server.js:827) 相同 cookie 名、`Path=/`；注册在各自 origin 页面执行 [driver:369](/Users/ken/Desktop/wm_bench/tools/inloop_driver.js:369) | 换端口不能代替 cookie 存储隔离。当前不同 profile 安全；若以后复用浏览器，至少需要独立 BrowserContext，但本方案不采用。 |
| 布局分配 | [guangyang-map-pool.js:135](/Users/ken/Desktop/robot_competition-main/projects/car-python/backend/guangyang-map-pool.js:135) 以 taskId、teamId 的 SHA256 取模；[auth-store.js:212](/Users/ken/Desktop/robot_competition-main/projects/car-python/backend/auth-store.js:212)、340–341 teamId 随机生成 | 两个注册流可能得到同一布局，不存在自动轮转或天然互斥。用户名相同也不能保证在新数据目录得到同一布局。 |
| 执行前筛图 | [driver:383](/Users/ken/Desktop/wm_bench/tools/inloop_driver.js:383) driver 使用离线真值识别分配布局；不在 want-maps 则390–394直接写 skipped 返回；418才点击 Run | 给同时运行的 driver 互斥 want-maps 集合，足以在不改 driver 的情况下防止同图双执行。筛图真值仍只在 driver。 |
| 输出文件 | [driver:217](/Users/ken/Desktop/wm_bench/tools/inloop_driver.js:217)、304、455–457、545–548、575–583、618–619：vision/demo/PNG目录、partial、samples、record、raw均由 `--out` stem派生 | `--out` 必须每次尝试唯一；仅换日志文件或 worker 名不够。PNG文件名 seq/tick 可相同，因为各尝试目录不同。 |
| hook / 证据缓存 | [vision_truth_hook.js:5](/Users/ken/Desktop/wm_bench/tools/vision_truth_hook.js:5) 与 [demo_keyframes_hook.js:5](/Users/ken/Desktop/wm_bench/tools/demo_keyframes_hook.js:5) 的 ledger 位于各页面 globalThis，绑定本页 runId | 独立页面/进程不会共享 ledger。保留现有 runId/frame/query/hash 检查，不把两局 frames 合并。 |
| 清理 | [driver:621](/Users/ken/Desktop/wm_bench/tools/inloop_driver.js:621) 只关闭本次 CDP、kill 本次 browserProcess、关闭本次 server、删除本次 tempRoot | 正常结束不会关掉其他 worker。强杀 driver 时不能假设 JS finally 已执行；孤儿 Chrome 和执行未知必须保留调查。 |
| 只读共享文件 | platform 静态源码、冻结 program/helper、WM_TRUTH_DIR | 可以共同读取；整个轮次保持哈希冻结。禁止并行发布平台资源、写共享真值目录或修改程序。 |

## 当前 runner 为什么不能直接双开

[run_opt2_batch.py:159](/Users/ken/Desktop/wm_bench/tools/run_opt2_batch.py:159) 只有一个 progress.json、一个 active 槽位。215–230 每次从 completed 计算所有 pending，再同步 `subprocess.run`。尝试序号和 `attempt-NNN` 路径由同一列表长度生成；两个进程读取相同旧状态会生成相同输出路径、持有重叠布局集合，并在各自已经点击 Run 后才发现重复。

[run_diagnostic_batch.py:37](/Users/ken/Desktop/wm_bench/tools/run_diagnostic_batch.py:37) 的保存通过固定 `progress.json.tmp` 再 replace 完成，属于单写入者的完整文件替换，**不是跨进程锁，也不是 compare-and-swap**。两个 runner 即使分别写入不同的尝试目录，仍会竞争 progress/preflight/manifest/归档与最终 map 文件。分别开两个完整 round 目录则会各跑十图，违反同轮每图一次。

## 推荐的最小下一轮改动

保留 `inloop_driver.js` 和两个证据 hook 原样，新建一个单进程中央调度器；子进程只调用 driver，不各自调用完整 runner。

1. 中央调度器只进行一次 preflight、冻结及 frozen_sources 归档。冻结并发参数、队列策略、driver/平台/浏览器版本与所有依赖。两个 worker 读取同一 frozen program。
2. 把剩余布局分成两个**互斥集合**，在 ledger 中先持久化 `{attempt_id, worker_id, allowed_maps, output_stem, state}` 再启动子进程。两个执行中的集合交集必须始终为空。集合仅含 map ID，不含目标坐标或程序分支。
3. 每个 worker 同时最多一个 driver。使用全局单调 attempt ID，以及例如 `attempts/worker-01/attempt-000001.json` 的唯一绝对路径。对应 log/partial/record/vision/demo都保留原位；最终 map-XX.json 只由中央调度器写一次。
4. 子进程结束后由中央调度器单线程分类并更新账本。executed（含程序失败/证据失败）立即消费实际地图且绝不重跑；明确 skipped/startup failure才可重新分配尝试。未确定是否执行时保留该尝试及其所有可能布局的所有权，不回收给另一个 worker。
5. 可在 worker 空闲且其旧尝试已结束、状态确定时，重新划分尚未分配的布局以均衡队列。不可更新已运行 driver 的 want-maps 视图；不可因墙钟超时认定旧进程已未执行而发重复任务。
6. freeze 检查仍由中央调度器执行，启动前与每次归档后检查。冻结变更/真实源码身份不符时停止发新任务；已执行的 worker尽力导出证据。普通任务失败与证据失败继续其他合法待跑地图。
7. resume 改为逐个 in-flight 尝试核验。若有未解决执行未知，相关集合继续被占用；有明确不相交的其他集合可完成，不能用恢复来绕过一次性规则。

最小方案无须让生产程序知道 worker、布局或真值，不需要改变观测次数、图像预算、仿真 tick、导航速度、物理核心或任务超时。不要在当前已冻结 round-1 内实现。

进一步提升分配效率的可选方案：driver 在383–397识别地图后、418点击Run前，向中央调度器发送 READY(map,attempt,program_sha)，等待独占 RUN 许可；同图冲突得到SKIP。中央调度器必须先落盘 reservation 再许可，且 ACK丢失/driver消失均按执行未知保留。这个握手可以让多个分配流共享 pending，同时阻止重复执行，但需要改 driver、增加协议与崩溃恢复测试，变更面大于互斥集合，暂不推荐作为第一步。

## 确定性与资源风险

固定步长提供较强的物理隔离依据：[app.js:11630](/Users/ken/Desktop/robot_competition-main/projects/car-python/app.js:11630) 每次调用 simulator.step 后按固定 stepMs 播放；[app.js:11987](/Users/ken/Desktop/robot_competition-main/projects/car-python/app.js:11987) 道路动作先由 competitionSession.runNavigationControl 计算，再于11890–11935播放已经算出的 frames。并行调度不应改变固定步长与种子，通常首先影响墙钟耗时。

仍有四项不能只靠静态阅读证明：

- **CPU、内存及软件渲染争用。** 当前Chrome使用SwiftShader（driver196），独立进程会争用同一台机器。并发数2是保守的基础设施选择，不是已测最优值；不可宣称线性加速。
- **后台渲染及截图。** [app.js:14291](/Users/ken/Desktop/robot_competition-main/projects/car-python/app.js:14291) 在document.hidden时停止主画面render；keyframe hook只观察已有主render，截图可能延迟或缺失。独立浏览器比同一浏览器的后台双标签页更可靠，未来仍须记录每页hidden/renderer状态。不得额外render、额外observe或放松截图门以补救。
- **墙钟看门狗。** driver使用120秒无输出/无进展与默认900秒整局墙钟上限（422、445–480）；平台Python watchdog为5秒无动作/识别/输出（app12796–12808），另有基于任务timeLimitSeconds×2000的客户端watchdog（5822–5832）。资源争用可以触发真实基础设施失败，不能把这些失败从分母中删除，也不能为提速偷偷调整平台计时规则。
- **渲染不是已证明的逐字节并发确定性。** 虚拟相机在[app7952](/Users/ken/Desktop/robot_competition-main/projects/car-python/app.js:7952)中显式render/readPixels/analyze并记录证据；但主场景动画使用performance时间（14329–14347），事件后截图时刻也受调度影响。保留原生tick/stateRevision/PNG/query绑定与实际结果，不以“物理确定性”推导所有PNG SHA必然相同。

取消/崩溃处理也必须单独设计：不能用全局pkill chrome；优先让各driver完成导出。若确需停止，只针对有记录的PID/进程树，并将Run是否已点击不确定的尝试保留为unknown；不能依赖端口消失判断“从未执行”。

## 已结束批次给出的墙钟参考

仅离线读取 [opt1 round-2 progress.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/progress.json) 的 started_at/finished_at，与十个 raw 的 wallSeconds：

| 项目 | 数值 |
|---|---:|
| 尝试 / 已执行 / 执行前跳过 | 29 / 10 / 19 |
| 全部尝试墙钟时长之和 | 2786.424 秒（46.44 分钟） |
| 十次已执行尝试墙钟之和 | 2766.716 秒 |
| 19次跳过墙钟之和 | 19.708 秒 |
| 最长已执行尝试 | 441.787 秒 |
| 假设资源零争用、两worker完美均衡时的执行时长下界 | max(2766.716/2,441.787) = 1383.358 秒 |

这个下界是数学估计，不是并行实测，也不是对阶段2的速度承诺。旧批次跳过开销不到总尝试时长1%，因此优先选择协议简单、互斥可证明的集合方案，比为减少随机分配而改动平台分配逻辑更合适。

若把每次随机分配近似为十图独立均匀，串行全pending预计分配次数为10×H10≈29.29；两个固定五图集合合计预计20×H5≈45.67，更多跳过但可并行。此概率模型仅说明分区代价，不作为运行次数或通过率统计依据；实际失败和跳过仍逐次保留。

## 实施前的验证范围（本次未执行）

先用完全合成、替换subprocess的离线测试验证：同图同时获配只允许一份执行许可；互斥集合不重叠；attempt路径不复用；中央ledger可恢复；执行后失败仍消费地图；未知执行不回收；共享文件变动阻止新任务；某worker完成不终止另一个；源码与全部证据按runId隔离。冻结策略后，下一完整轮次的前两个不同布局即可自然形成并发观测，仍属于各自唯一正式一局，不为调度验证额外重跑正式布局。

实际实施若暴露资源或证据问题，只记录本轮失败并完成可明确执行的其他布局；全部结束后统一决定下一轮，不在运行中改变并发策略、程序或driver。若要求严格证明相同程序在串行/并行下逐帧一致，需要单独定义离线/受控验证范围，不能假称本只读审查已经证明。
