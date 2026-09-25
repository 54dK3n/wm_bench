# Run18：实际交付2/2，驱动墙钟超时，整体FAIL

本局目录：`artifacts/autonomous-brain/map05-run-18/map-05-run-1`。冻结源码提交：`258ebab8555344805eabd1c5b2fe4773d97d7df2`。正式任务配置为最多200轮、1200模拟秒。

独立离线 evaluator v3 对原始 record 事件和终点样本复算，确认两个目标均有未撤销的有效交付事件，末态均在存放区且未被夹持：**实际交付2/2**。但本局整体仍为 **FAIL**，不是正式map05成功门票，不能据此开启十布局验收。

## 终止、缺失证据与预算

原始父级 `summary.json` 记录 `status=complete`、`sourcesUnchanged=true`，但 trial 的 `success=false`，进程 `code=null`、`signal=SIGTERM`、`interrupted=driver_wall_timeout`、`wallSeconds=7200.663`。这里的 complete 表示驱动已完成收尾和平台导出，不表示机器人任务成功。

冻结 driver 的 `tools/autonomous_brain_driver.js:67` 默认设置7200秒墙钟保护；第500、507行负责超时分类及SIGTERM。这是独立于200轮／1200模拟秒的驱动墙钟限制。本局最后模拟时间855.94秒，完成167轮，尚未触及两项正式任务预算。没有保存的 `evaluator-stop.json`，不能写成评测员主动请求停止，也不能把驱动超时写成模型传输重试耗尽。

`brain/rounds.jsonl` 保存连续r1–r167；r167为成功的 `explore(exit_angle=-81)`，结果 `next_junction_observed`，after obs1114、final obs1115，tick42797。`brain/observations.jsonl` 最后一行是r168起始obs1116，同为tick42797／855.94秒。`llm.jsonl` 最后一条是call200／decision167，对应r167；没有r168的保存调用记录、模型输出、动作或完成轮。未完成请求是否已经发出、消耗多久及最终结果不能由这些保存记录重建，相关指标保留为null。

**`map-05-run-1/brain/summary.json` 缺失，原样保留缺失；没有补造子进程summary、终止轮或未完成请求。** 本报告和 `run-metrics.json` 是离线派生审计结果，不替代该缺失原始文件。全部167个保存动作均非 `done`，没有 observed done 及正常完成的终点佐证。

## 可复算指标

计数直接来自原JSONL；耗时以 `math.fsum` 累加每条保存LLM记录。

| 指标 | 本局记录 |
|---|---:|
| 完成轮／已开始但未完成轮 | 167／r168 |
| 保存LLM调用 | 200 |
| 保存LLM elapsed合计 | 6663.330369920001秒 |
| 保存重试等待合计（另计） | 27秒 |
| 驱动墙钟时间 | 7200.663秒 |
| 模拟时间／末tick | 855.94秒／42797 |
| 观测／运动／bridge调用 | 1116／781／5246 |
| 动作成功／动作失败 | 144／23 |
| grab／release次数 | 8／2 |
| done动作 | 0 |
| 平台拒绝／非白名单成功调用 | 0／0 |

动作分布：explore 102、look_around 48、go_to 12、pick 3、place 2。运动分布：take_exit 83、turn 500、follow_road 151、forward 24、backward 13、grab 8、release 2。5246条brain bridge调用terminal均为completed，末次公开观测完整；没有保存的NOT_RUNNING动作失败。

最后一个保存模型请求状态（r167之前）含36个节点、26条未探索出口。离线使用冻结navigation v4对全部1116帧和运动重建，167份保存道路状态全部一致；obs1116对应36个节点、121条保存出口、25条未完成且未阻塞出口。此重建只是公开道路记忆，不是物理路口真值数量。

末观测中两条红轨迹 `target_032`、`target_114` 为DELIVERED，18条未确认历史假设为retired；另有 `target_166` 为STALE／pending，hit_count=1、ever_confirmed=false。不能把这个感知假设当作第三个物理红球，也不能把2/2离线真值交付倒灌给运行时来提前完成任务。

## 抓放与交付时间线

脑内观测结论与独立record事件分列；物理目标交付计数不依赖将每条WM轨迹强制绑定到一个真值身份。

| 记录 | 脑内公开观测证据 | 独立record事件 |
|---|---|---|
| target_032确认 | r20／obs123，81.98秒；初见r13／obs75，54.02秒 | 不把WM确认当作真值交付 |
| r24 pick成功 | 两次grab：149→150 false，151→152 true（105.86秒）；obs157／109.06秒 holding=true、old_position_matches=0 | 首个物理目标package_grabbed，105.58秒／tick5279 |
| r36 place成功 | release 258→259（220.52秒）；实际placement obs260／223.20秒，candidate=1、ball_track_id=null为合法近场见证；生命周期在obs261首次记录DELIVERED | 首个物理目标package_delivered，220.10秒／tick11005 |
| target_114确认 | r80／obs527，400.62秒；初见r79／obs518，393.74秒 | 不把WM确认当作真值交付 |
| r87 pick失败 | grab 565→566、567→568、569→570，三次holding均false；421.18秒结束 | 没有该轮成功抓取事件 |
| r89 pick成功 | grab 575→576 false、577→578 false、579→580 true（426.40秒）；obs585／429.60秒 holding=true、old_position_matches=0 | 第二个物理目标package_grabbed，426.12秒／tick21306 |
| r92 place成功 | release 622→623（471.30秒）；实际placement obs624／473.98秒，candidate=1、ball_track_id=null；生命周期在obs625首次记录DELIVERED | 第二个物理目标package_delivered，470.88秒／tick23544 |

target_032总计2次grab；target_114总计6次grab，分布在两次pick中，各3次，不能写成一次pick六次尝试。两次place的见证bbox、release边界、归路结果和每次grab前后holding已保存在 `run-metrics.json`。

末truth样本tick42797严格等于导出终点tick42797。两个物理目标到存放区中心的距离分别为0.367917859923、0.538224702579 world units，均小于半径0.95；末态holding=false，两个delivery事件仍有效。详细逐目标事件见 `report/evaluation.json`。

## 失败与模型调用

23次保存动作失败分为：

- 道路受阻后成功退回路口15次：r8、22、62、71、94、113、122、123、127、128、130、135、142、143、166。
- visual_standoff_requires_road_reposition 3次：r21、81、83。
- known_route_exhausted_needs_exploration 3次：r25、28、31。
- three_grab_attempts_failed：r87；route_no_progress：r90。

驱动SIGTERM是独立的进程终止事件，未产生一个保存的失败动作轮；不能将其凑成第24次动作失败，也不能将r168算作已完成轮。

保存调用中有20次传输错误（HTTP502 17次、RemoteDisconnected 3次）和13次验证拒绝（全部为 `go_to requires a CONFIRMED object`）。这些均在相应保存轮中恢复，最终167个轮次都有合法动作。记录的transport_retry_limit=5，最大实际retry_index=3，timeout=180秒；不把历史其他版本的重试上限套入本局。各call／decision／attempt／retry位置保存在 `run-metrics.json`。

模型已经观测两次放置成功，但后续探索并未收敛至done。最终仍有待探索道路记忆与一个活跃STALE假设；这些是终止时的公开状态，不构成“所有未探索道路永久不可达”的证明。本局确定的终止机制是驱动墙钟保护，而不是上述状态的某一唯一物理成因。

## Judge、WM误差与评测限制

独立v3保留FAIL，具体failures为：`missing_input:brain/summary.json`、`source_proof_brain_summary_hash_mismatch`、`brain_did_not_finish_with_observed_done`、`terminal_done_not_corroborated`、`execution_or_controller_error`。

其几何绑定按全记录要求同一track身份一致；`target_032`和`target_114`均累积到两个不同真值候选，故保守标为ambiguous。5个pick/place动作全部 **unverifiable**，其余162个动作不在Judge范围内；match=0、false_positive=0、false_negative=0不表示已经证明零误判。没有给explore等动作套用真值成功判决。

WM位置误差有效样本 **0**，86个CONFIRMED样本因身份歧义未匹配；mean／RMSE／max均为null，不能写成0cm，也没有用最近距离补配。该限制与独立record＋末样本确认2/2有效交付并不冲突。

评测器的 `source_proof_brain_summary_hash_mismatch` 来自缺失子summary后的严格门禁，**不是八份源码实际不一致的证据**。原始自动报告未修改；下面的额外Git字节证明独立记录可验证的来源范围，不能用来伪造缺失的子summary或将FAIL改为PASS。

## 来源、导出与发布

归档开始前先生成 `original-input-hashes.json`，保存24个原始文件大小与SHA256。`source-commit.json` 对七份brain源码和driver共8文件逐一核验冻结Git blob：其字节SHA256全部与运行前manifest、运行后manifest相同；完整before/after manifest深相等，driver sourcesUnchanged=true。证明依据是冻结Git对象及保存的运行manifest，不使用之后工作树修复作为本局源码。

record、samples、sensorAudit、captures、envelope五项平台导出全部complete，failures=[]、partial={}。4个gzip流式读至EOF，CRC／trailer通过；压缩和展开大小、SHA256均与export-progress及evidence.json一致。缺失的是child summary，不是这五项平台导出。

原record压缩文件262,553,008字节，展开377,330,166字节，压缩SHA256：

`7f7fd954b493410c95670f19d3d2b6e1f29e3a43cfb889398ba622d6a381fad3`

原gzip完整保留本机，并仅对这一精确路径追加.gitignore。`record-chunks/` 保存原压缩字节的六片：前五片各52,428,800字节，末片409,008字节，无解压重压。已恢复到本局临时新文件并逐字节比较及复核SHA256，完全相同；核验后仅移除自建的恢复副本。不能把原大gzip加入Git。

`archive-checks.json` 核对原始证据与旧报告／索引未变；`publication-checks.json` 扫描本局文本和4个gzip展开内容，并验证分片对应扫描过的原gzip。所有报告使用repo-relative路径，不读取环境或密钥文件。发布扫描不输出疑似敏感值。

## 复核命令

在仓库根目录执行；两个评测输出目录必须尚不存在。

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/map05-run-18/record-chunks/manifest.json
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-18/map-05-run-1 --out artifacts/autonomous-brain/map05-run-18/recomputed-report
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/map05-run-18/map-05-run-1 --out artifacts/autonomous-brain/map05-run-18/recomputed-llm-replay
```

严格离线LLM重放已经PASS：167/167轮、200/200条保存记录全部耗尽，除mode外完整记录一致，网络调用0、环境读取0、输入证据未改。它只重放已保存的模型记录，不执行仿真，也不重建r168未记录请求；重放成功不改变本局FAIL。
