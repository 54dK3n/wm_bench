# Run19：实际交付1/2，公开路口判定重复误报，正常外部停止，整体FAIL

本局目录：`artifacts/autonomous-brain/map05-run-19/map-05-run-1`。冻结提交：`609772040d00f35e3ec6e25cfa5433894be4e5a7`，driver v6、actions v18、runtime v10、LLM v12、navigation v4。正式上限为200轮／1200模拟秒，额外墙钟上限为0（关闭）。

独立 evaluator v4 同时核对原始record交付事件与末样本，确认**实际有效交付1/2，整体FAIL**。首球已送达，第二球末态仍被夹持，不能算送达；没有成功done，十布局成功门票未取得。

## 终止原因和计数边界

评测方根据公开日志中重复的 `next_junction_observed` 误报请求正常停止。`evaluator-stop.json` 保存 `stopRequested=true`、tick34583、原先false及当时仍running的返回值；与 `evaluator-stop-cdp.json/result/result/value` 逐字段相同，两个原文件及其原始字节均保留。

r163模型已返回合法 `look_around {}`，随后 `brain-004787` 的 `turn(45°)` 收到 `NOT_RUNNING`。因此该轮是**外部停止造成的执行错误**，不是Kimi输出错误或传输重试耗尽。子进程正常写出 `brain/summary.json`，状态failed、原因 `BridgeError: turn: NOT_RUNNING`。

driver最终 `status=complete`、`sourcesUnchanged=true`；process.code=1、signal=null、interrupted=null、wallTimeoutSeconds=0、wallSeconds=3093.077。这里的complete表示收尾及导出完成，不表示任务成功。本局没有Run18式的墙钟超时或SIGTERM，也未到200轮／1200秒预算。

原始 evaluator v4 读取到了停止记录，但不识别其 `wm-brain-evaluator-stop/v1` schema作为专用外停分类，因此保留 `execution_failures=1, external_stop_failures=0`。**自动评测输出未修改。** `run-metrics.json` 另以原stop/CDP、tick和NOT_RUNNING证据标注这1次外停影响，避免把它算成第27次原动作失败。

## 可复算指标

JSONL逐行计数、LLM耗时使用 `math.fsum`，并与原始child summary交叉核对。

| 指标 | 结果 |
|---|---:|
| 轮数／保存LLM调用 | 163／173 |
| LLM调用耗时合计 | 2679.6163993769987秒 |
| 已记录重试等待（另计） | 2秒 |
| brain墙钟／driver墙钟 | 3092.932563625／3093.077秒 |
| 模拟时间／末tick | 691.66秒／34583 |
| 观测／motion／bridge调用 | 1022／697／4787 |
| 日志自报success／false | 136／27 |
| 原动作失败／外停执行错误 | 26／1 |
| grab／release／done | 7／1／0 |
| 平台拒绝／非白名单成功调用 | 0／0 |

动作分布：explore 87、look_around 49、go_to 23、pick 3、place 1。运动分布：take_exit 61、turn 469、follow_road 124、forward 19、backward 16、grab 7、release 1。4786条bridge调用completed，末条turn为failed／NOT_RUNNING；失败运动未被伪补为成功motion。

136条自报成功中包含下节已定位的11条路口到达误报。没有把其余自报成功全部认定为独立验证通过，也没有改写原始round结果。末轮模型状态仍持有物体，保存道路记忆为36个节点、32条未探索出口；这些是公开记忆计数，不是独立物理道路数量。

## 11次explore路口到达声明缺少当前观测支持

对所有163轮进行额外的公开观测审计，筛选 `explore` 自报 `success=true, reason=next_junction_observed`，再核对对应after观测及其运动。以下11次均满足：

- 最后一条 `follow_road` 返回 `stoppedBy=junction, distanceCm=0, elapsedTicks=0`。
- 运动前后公开里程计位移为0。
- 新的 `local_road` 为 `onRoad=true, atNode=false, atJunction=false, exits=[]`。
- 位置始终为right=103.3cm、forward=31.9cm，heading=−171°，frontClearance=28.4cm。

| 轮 | motion前后obs | after tick／模拟秒 |
|---:|---|---|
| 140 | 925→926 | 33423／668.46 |
| 145 | 952→953 | 33887／677.74 |
| 146 | 955→956 | 33887／677.74 |
| 147 | 958→959 | 33887／677.74 |
| 150 | 973→974 | 34119／682.38 |
| 151 | 976→977 | 34119／682.38 |
| 154 | 991→992 | 34351／687.02 |
| 156 | 996→997 | 34351／687.02 |
| 157 | 999→1000 | 34351／687.02 |
| 160 | 1014→1015 | 34583／691.66 |
| 162 | 1019→1020 | 34583／691.66 |

完整motion、前后里程计、fresh road、round及final-observation引用在 `explore-observation-audit.json`。冻结源码 `autonomous_brain/actions.py:417–418` 使用 `atNode or stoppedBy == junction` 返回成功；零位移检查在其后419–421行。上述日志中后一个条件先成立，因此错误地以执行器停止标签代替“当前已观测路口”的依据。

这是可由公开传感器复算的**到达路口声明假阳性**，单独记录，不加入原 evaluator v4 的pick/place-only Judge，也不把零位移本身一概视为失败。此证据不证明道路永久不可达，不证明所有执行器junction返回都错误，也不改变本局done规则或历史结果。

第二球抓取后，go_to还先后经历route_no_progress、route_blocked、绿色目标未观测到及视觉停靠需要道路重定位。最后反复接近 `storage-zone_144` 与上述零进展explore交替出现；没有第二次place或release。这些动作与停止原因在原日志中分别保留，不能把根任务随后修复后的行为写成本局已执行。

## 两球时间线和抓取次数

独立时间线由同帧唯一检测框／真值投影匹配、WM历史及record事件建立，完整数据见 `report/evaluation.json` 和 `run-metrics.json`。

| 物理目标 | 首次原始看到 | 首次WM入库 | 首次CONFIRMED | record抓到 | record有效送达 |
|---|---|---|---|---|---|
| target-1 | r2／obs5，2.76秒 | r6／obs32，17.50秒，target_021 | r17／obs107，67.94秒，target_034 | 95.20秒／tick4760 | 206.58秒／tick10329 |
| target-2 | r11／obs68，45.92秒 | r82／obs526，381.24秒，target_102 | r121／obs782，570.10秒，target_136 | 590.38秒／tick29519 | 无 |

第一球r22执行一次pick、2次grab：obs137→138 holding=false（93.76秒），139→140 holding=true（95.48秒）。obs145／98.68秒完成 holding=true 与 old_position_matches=0 的抓取观测确认，obs146写出HELD。r40 release为266→267（207.00秒）；后退后的实际placement见证在obs268／209.68秒，candidate=1、ball_track_id=null为合法近场见证，obs269写出DELIVERED。record事件时间早于动作完成后的公开观测时间，二者没有混用。

第二球r125的三次grab均失败：801→802（579.28秒）、803→804（581.14秒）、805→806（583.00秒）。r128再执行一次pick，两次grab为821→822 false（588.94秒）、823→824 true（590.66秒）；obs829／593.86秒完成holding与原位置消失确认，obs830写出HELD。第二球合计5次grab，分布在两次pick内（3+2），不是一次pick五抓。

末样本tick34583严格等于仿真end tick。首球有未撤销delivery事件、末态未夹持且在存放区内，中心距离0.455175849374 world units小于半径0.95。第二球无delivery事件，末态held=true且不在存放区。真实结果为1/2，不因第二球已经抓到而计为2/2。

## 原动作失败、LLM错误与抓放Judge

26次原动作失败按原reason分组：

- road_blocked_returned_to_junction：r8、41、65、86、103、110、111，共7次。
- visual_standoff_requires_road_reposition：r18、122、137、138、142、143、148、152、155、158、161，共11次。
- known_route_exhausted_needs_exploration：r23、28、33、34，共4次。
- three_grab_attempts_failed：r125；route_no_progress：r129；route_blocked：r130；visual_standoff_target_not_observed：r135，各1次。

r163外停NOT_RUNNING单列。此前仅2次HTTP502（call78／decision74、call103／decision97），各次下一重试恢复；另8次go_to CONFIRMED前置校验拒绝均完成修正。保存调用的retry_limit=5、最大实际retry_index=1、timeout=180秒。没有终止性的模型错误，也没有因服务错误变更模型或动作判据。

原 evaluator v4 的4个可核验pick/place全为match：r22 pick成功、r40 place成功、r125 pick失败、r128 pick成功；false_positive=0、false_negative=0、unverifiable=0。其他159轮不在该Judge范围，因此这里的0误判不能推广为全脑判定无误，尤其不能覆盖上节11条公开路口到达误报。

WM位置误差基于75个可唯一绑定且同帧truth有效的CONFIRMED红轨迹观测：均值5.83252911229038cm、RMSE7.03387033597925cm、最大11.09313323775761cm。重复未更新估计仍按各观测计入。另3个target_136样本（obs824–826，已抓持后的590.66–591.94秒）因 `no_active_same_frame_truth` 排除；没有用最近距离补配。

## 来源、导出、分片和回放

归档开始前 `original-input-hashes.json` 保存27个原始文件的大小和SHA256。冻结6097720的七份brain源码加driver共8文件Git blob SHA全部匹配运行前后manifest，七份child-summary源码SHA也一致，两个manifest深相等，sourcesUnchanged=true。来源核验不使用之后工作树中的修复版本。

record、samples、sensorAudit、captures、envelope五项导出全部complete，failures=[]、partial={}。4个gzip逐流读至EOF验证CRC／trailer，压缩与展开字节数及SHA256全部匹配export-progress和evidence.json。child summary完整保存。

原record压缩241,903,595字节，展开346,341,072字节，压缩SHA256为：

`7119fb382ae5d3f7dbbf1457193470ffeca99ed5103111699f6425de20616591`

`record-chunks/` 保存五片原压缩字节，前四片各52,428,800字节、末片32,188,395字节；无解压重压。原gzip本机保留，`.gitignore`只精确追加其路径。已恢复至本局新临时文件、复核完整SHA并逐字节比较，完全一致；随后仅移除自建恢复副本，不移除原件。

严格离线LLM回放163/163轮、173/173调用全部通过，完整记录除mode外相同且全部耗尽；网络调用0、环境读取0。使用的LLM源码SHA与冻结manifest一致。合法模型动作之后的r163执行失败没有误算成模型输出失败。回放不执行仿真，不表示任务通过。

`archive-checks.json` 核对原始文件及旧报告／索引未变；`publication-checks.json` 扫描本局文本、4个gzip展开内容，并通过分片恢复证明覆盖原record。报告使用repo-relative路径，不读取环境或密钥文件。旧结果、LIVE索引、docs和生产源码不在本次修改范围内。

在仓库根目录复核，两个输出目录必须不存在：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/map05-run-19/record-chunks/manifest.json
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-19/map-05-run-1 --out artifacts/autonomous-brain/map05-run-19/recomputed-report
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/map05-run-19/map-05-run-1 --out artifacts/autonomous-brain/map05-run-19/recomputed-llm-replay
```

本局评测器版本为v4，原报告按该版本保存；后续分类兼容修复或不同版本复核须另存目录，不覆盖此处输出。自主完成、正式预算、独立record＋末态和源码完整性判据均未放宽。
