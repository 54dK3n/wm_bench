# Run15：首球有效交付，模型传输重试耗尽，正式 FAIL

本局采用正式200轮/1200仿真秒上限，冻结源码提交 `9b2cc8486ec9b870cf1219b977ea36387565331a`。独立v3评测确认实际有效交付1/2；第二球未抓取，没有成功的observed done。第69轮三次模型传输请求均失败，重试耗尽后未生成新动作。没有评测方停止记录，也未达到轮数或仿真时限。driver正常完成全部导出，进程退出码1表达任务失败，不是导出失败。该局不能作为十布局门票。

## 复算指标

| 项目 | 结果 |
|---|---:|
| round记录 / 有动作轮次 | 69 / 68 |
| 模型请求 / 观测 / motion / bridge调用 | 84 / 442 / 305 / 2,074 |
| 模型累计elapsed_s | 2915.470196454秒 |
| 另计传输重试等待 | 12秒 |
| brain墙钟 / driver进程墙钟 | 3121.358712292 / 3121.49秒 |
| 仿真时间 / 最终tick | 353.48秒 / 17674 |
| 成功动作 / 失败动作 / 终止模型执行错误 | 55 / 13 / 1 |
| explore / look_around / go_to / pick / place | 42 / 15 / 9 / 1 / 1 |
| grab / release | 3 / 1 |
| 模型传输错误 / 状态校验拒绝 | 11 / 5 |
| 外部停止导致错误 / 控制器错误 | 0 / 0 |
| 有效交付 / 要求 | 1 / 2 |
| 非白名单脑请求 / 非白名单已接受调用 | 0 / 0 |

模型累计耗时为原始 `llm.jsonl` 的elapsed_s之和，包含失败请求，不含另计的重试等待或动作耗时。69条round记录中仅68条有动作；不能将最后一轮模型错误写成第14次动作失败。可复算字段、输入SHA256、逐次抓放窗口和状态转换见 `run-metrics.json`；原始数据位于 `map-05-run-1/brain/`。

## 终止原因和此前失败

第69轮的calls82/83/84使用同一个决策输入、attempt1和同一个request SHA256 `66be4c655c71ab85c31a15ff5529389799441de3b33b012863797c2e42b05cff`。retry index为0/1/2，上限2；三个请求均没有raw_output或action，也没有进入JSON修正。

| 调用 | 传输错误 | elapsed_s | 调用前重试等待 |
|---|---|---:|---:|
| 82 | URLError | 33.911006416 | 0秒 |
| 83 | HTTP502 | 88.182164292 | 1秒 |
| 84 | URLError | 33.525844666 | 2秒 |

本轮模型请求耗时合计155.619015374秒，另有3秒等待。最终原因是 `LLMRequestError: LLM request failed: URLError; see transcript`。本轮不是对未确认对象的校验失败，也不是外部停止后的NOT_RUNNING。

全局11次传输错误为HTTP502五次(calls13/47/59/65/83)、RemoteDisconnected三次(6/28/34)、URLError三次(35/82/84)。此前8次均恢复，最后3次耗尽重试。5次状态校验拒绝发生在calls8/14/16/55/79，均为 `go_to requires a CONFIRMED object`，随后单次JSON修正成功；这些修正没有放宽确认条件。

| 失败动作原因 | 轮次 | 次数 |
|---|---|---:|
| road_blocked_returned_to_junction | 8、35、42、48、49、59 | 6 |
| visual_standoff_requires_road_reposition | 13、15、17、20 | 4 |
| known_route_exhausted_needs_exploration | 24、28、30 | 3 |

这些动作失败均有后续模型轮次；完整原始result保存在独立评测 `report/evaluation.json`。受阻与未发现新球的记录不足以证明所有物理道路不可达，也不能用之后的导航修复反写本局结果。

## 首球的传感确认、抓取和放置

WM `target_021` 首次入库为r6/obs32/17.50秒，r12/obs72/49.46秒达到CONFIRMED。其前3个有效hit来自obs32、59、72的不同位置，完整接受位置在 `run-metrics.json`。

r23只执行一次pick，共3次grab：obs123→124和125→126后holding为false，obs127→128后holding为true(86.30秒)。第三次抓取对应独立原生grab事件tick4301/86.02秒。随后obs133/89.50秒确认holding=true且old_position_matches=0，记为 `grasp_observed`，最终obs134。原生接触成功时间、holding观测时间和pick确认时间不同，均保留。该次归路状态为 `already_on_observed_road`，没有归路motion。

r34的release发生于obs230→231；obs231/187.24秒holding=false，release前已有候选ID为target_055。后退后的实际放置判断帧为obs232/189.92秒：candidate_witnesses=1，ball_track_id=null（允许的近场公开观测），红球框(282,208,78,64)，绿色存放区框(58,257,358,78)，WM据此记DELIVERED。随后沿记录轨迹4次forward归路，结果obs236/tick9697/193.94秒，final obs237。不能将189.92秒放置见证与193.94秒归路结果混同。

独立原生交付事件为tick9341/186.82秒。终端sample tick17674与record end tick完全相同：target-1不在夹爪中、保持有效交付事件且在存放区内；target-2无grab/delivery事件且终态在存放区外。因此实际有效交付是1/2，而不是仅凭WM的DELIVERED标签计数。

## 逐球时间线与记忆限制

下表的“原始看见”采用独立评测同帧、同类、真值投影中心落入精确检测框且双向唯一的几何对应；它不独立证明遮挡可见性。WM首次入库不是首次原始检测。

| 物理目标（仅离线评测使用） | 首次匹配原始检测 | 首次匹配WM / 确认 | 原生抓取 / 有效交付 |
|---|---|---|---|
| guangyang-target-1 | r2/obs5，2.76秒 | target_021，r6/obs32，17.50秒；r12/obs72，49.46秒确认 | 86.02 / 186.82秒 |
| guangyang-target-2 | r55/obs366，296.88秒 | 无可绑定的WM入库或确认记录 | 无 / 无 |

最终公开记忆中，021为DELIVERED；055曾未确认、现LOST并归类retired_unconfirmed_hypothesis；106为STALE、107为TENTATIVE，二者都仅一个有效hit、未曾CONFIRMED，仍pending。它们不是第二、第三个物理球的计数。独立几何对应将107匹配到已交付物理target-1，106没有可靠绑定；不能把106或107直接命名为未送达的target-2。最后一轮因网络错误未返回动作，因此不能推断模型原本会如何处理这些候选。

## Judge和WM误差

独立Judge仅判定能够绑定红球身份、持球状态、执行窗口和精确tick真值的pick/place：2次符合范围，2次一致，false-positive=0、false-negative=0、unverifiable=0；其余67轮不在本Judge范围，不能称全部行为均被真值验证。

WM位置误差按每条观测中可唯一绑定且具备同帧真值的CONFIRMED红球估计计样本，重复估计也各算一条。56个样本的均值8.839469cm、RMSE9.137277cm、最大12.479048cm；另外2条已确认样本未匹配，不纳入误差。原始红检测匹配69条唯一、22条未匹配，ambiguous_track_ids为空。精确坐标约定、各样本与限制见 `report/REPORT.md`、`report/evaluation.json`，没有以未匹配样本冒充零误差。

## 来源、完整性和严格离线回放

`source-commit.json`逐一比较冻结提交的7个brain文件和driver的Git blob SHA256、原始before/after manifest、brain summary中的源码SHA；8文件全部一致，driver记录sourcesUnchanged=true。平台与capture函数的记录前后也一致。证明不使用之后为新局修改的工作树源码。

`export-status.json`记录record、samples、sensorAudit、captures、envelope全部完成，failures=[]、partial={}。`archive-integrity.json`重新流式读取4个gzip至EOF，校验gzip CRC、压缩及展开SHA256和字节数，并校验envelope。

原始record为104,354,348字节，展开150,227,331字节；压缩SHA256为 `7f90184ea831d8288599c927aa6a896da71e54669cdc354ade6319ea99e1acff`。它低于100MiB阈值503,252字节，因此保留完整原gzip，无分片、无解压重压、无新增忽略规则。

严格LLM离线回放读取原历史state、prompt和响应/错误记录，69轮及84条请求完全匹配，消耗全部记录，除mode字段外完整记录一致；重现最后三次传输错误及相同终止异常。模型网络调用0、环境访问0，原始证据未变。它不重新运行物理场景，也不改变原局FAIL。

复算命令（仓库根目录；评测退出码1表示完整FAIL报告）：

```sh
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-15/map-05-run-1 --out artifacts/autonomous-brain/map05-run-15/recomputed-report
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/map05-run-15/map-05-run-1 --out artifacts/autonomous-brain/map05-run-15/recomputed-llm-replay
```

`archive-checks.json`记录原始文件SHA、前14局42份报告保持不变、索引仅追加、独立评测与回放结果；发布检查扫描本局全部普通文本及gzip展开内容，检查凭据格式和绝对用户路径，仅保存命中规则和文件名、不输出疑似敏感值。真值仅在本局结束后供独立离线评测使用，未传入模型或后续运行。
