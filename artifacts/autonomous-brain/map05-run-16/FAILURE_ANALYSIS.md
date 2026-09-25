# Run16：已确认首球，模型连续HTTP502终止，正式 FAIL

本局采用正式200轮/1200仿真秒上限，冻结源码提交 `17e3e311b3b74136bed72933c0a3925c4296d12c`。独立v3评测确认0/2有效交付，没有grab、release或成功的observed done。第20轮三次模型请求均返回HTTP502，耗尽两次重试后未生成动作。没有评测方停止记录，也未达到轮数或仿真时限。driver正常完成全部5项导出；进程退出码1表达任务失败，不是导出失败。该局不能作为十布局门票。

## 复算指标

| 项目 | 结果 |
|---|---:|
| round记录 / 有动作轮次 | 20 / 19 |
| 模型请求 / 观测 / motion / bridge调用 | 22 / 117 / 78 / 547 |
| 模型累计elapsed_s | 576.579307251秒 |
| 另计传输重试等待 | 3秒 |
| brain墙钟 / driver进程墙钟 | 628.178939833 / 628.288秒 |
| 仿真时间 / 最终tick | 73.96秒 / 3698 |
| 成功动作 / 失败动作 / 终止模型执行错误 | 15 / 4 / 1 |
| explore / look_around / go_to / pick / place | 10 / 6 / 3 / 0 / 0 |
| take_exit / turn / follow_road / forward | 5 / 57 / 13 / 3 |
| grab / release | 0 / 0 |
| 模型传输错误 / 状态校验拒绝 | 3 / 0 |
| 外部停止导致错误 / 控制器错误 | 0 / 0 |
| 有效交付 / 要求 | 0 / 2 |
| 非白名单脑请求 / 非白名单已接受调用 | 0 / 0 |

模型累计耗时为原始 `llm.jsonl` 的elapsed_s之和，包含失败请求，不含另计的重试等待或动作耗时。20条round记录中仅19条有动作；不能将最后一轮模型错误写成第5次动作失败。可复算字段、原始失败result、接受位点、状态转换和输入SHA256见 `run-metrics.json`；原始数据位于 `map-05-run-1/brain/`。

## 终止请求及此前动作失败

第20轮的calls20/21/22使用相同决策输入、attempt1和request SHA256 `e2a52f511c2226a7611d6ad004cea9fbcaee36a69f007dfb644ce31e41d37555`。retry index为0/1/2，上限2。三个请求均无raw_output、无action、无validation_error，也未进入JSON修正；本轮没有motion。

| 调用 | 传输错误 | elapsed_s | 调用前重试等待 |
|---|---|---:|---:|
| 20 | HTTP502 | 63.099973000 | 0秒 |
| 21 | HTTP502 | 68.061330625 | 1秒 |
| 22 | HTTP502 | 64.576503708 | 2秒 |

本轮请求耗时合计195.737807333秒，另有3秒等待。最终原因是 `LLMRequestError: LLM request failed: HTTPError HTTP 502; see transcript`。前19次模型请求没有传输错误或状态校验拒绝；现有日志仅证明终止请求发生HTTP502，不能据此将原因指定为模型参数不兼容、服务端配置或某个动作实现。

| 失败动作原因 | 轮次及仿真时间 | 观测证据 |
|---|---|---|
| road_blocked_returned_to_junction | r9，38.82秒 | obs48→56，front_clearance停止13.8cm；3步恢复返回路口，final57 |
| visual_standoff_requires_road_reposition | r14，57.26秒 | obs86→88，fresh距离51.119910cm、bearing−8.474177°，final89 |
| visual_standoff_requires_road_reposition | r16，63.04秒 | obs94→97，fresh距离53.640304cm、bearing+0.253088°，final98 |
| visual_standoff_requires_road_reposition | r18，69.32秒 | obs103→105，fresh距离51.769811cm、bearing−4.700858°，final106 |

三次go_to均请求再前进10cm，但道路朝向误差分别为85.7°、−83.6°、73.6°，对应侧净空均为0.1cm，公开安全计算返回permitted_cm=0。它们不是抓取失败，因为没有调用grab。之后r19完成扫描，obs115/73.96秒仍holding=false，final116。r20末观测117仍onRoad=true，不能据这些受阻动作声称车辆已经离路、全部物理路径不可达或永久阻塞；本局实际终止原因是模型传输重试耗尽。

## 首球确认与逐球时间线

WM `target_021` 首次入库为r6/obs32/17.50秒，r13/obs82/54.10秒达到CONFIRMED。前三个接受位点为obs32、69、82：里程计位置分别为(−0.730,0.274)、(−1.090,0.121)、(−1.458,0.552)米，两两间距39.116365、77.927402、56.673186cm，均超过15cm；第四个位点为obs95/61.98秒。最终该目标仍CONFIRMED、hit_count=4、pending，未出现picked_s或delivered_s。

末obs117的fresh红球检测为raw44cm/−5.22°，M5距离51.769811cm/bearing−4.700858°；WM记忆距离约43.338cm是另一项估计。没有达到抓取/送达结果，不能用更近的记忆距离替代fresh距离宣称已到达目标。最终completion仅有pending target_021，已观测路口7、未探索出口11；没有done请求。

下表的“原始看见”采用独立评测同帧、同类、真值投影中心落入精确检测框且双向唯一的几何对应。它不独立证明遮挡可见性，WM首次入库也不等于首次原始检测。

| 物理目标（仅离线评测使用） | 首次匹配原始检测 | 首次匹配WM / 确认 | 原生抓取 / 有效交付 |
|---|---|---|---|
| guangyang-target-1 | r2/obs5，2.76秒 | target_021，r6/obs32，17.50秒；r13/obs82，54.10秒确认 | 无 / 无 |
| guangyang-target-2 | 无可匹配记录 | 无可绑定的WM入库或确认记录 | 无 / 无 |

终端sample tick3698与record end tick完全相同；两球均没有有效交付事件，且终态不在存放区内。因此实际有效交付是0/2。第二球没有可匹配原始检测不等于证明物理上不可见；本归档不推断未绑定检测的身份。

## Judge和WM误差

独立Judge只判定能够绑定红球身份、持球状态、执行窗口和精确tick真值的pick/place。本局没有pick/place，eligible_actions=0、match=0、false-positive=0、false-negative=0、unverifiable=0，20轮均not_evaluated。这里的零误判计数没有可判定动作样本，不能解释为所有动作的正确率100%。

WM位置误差按每条观测中可唯一绑定且具备同帧真值的CONFIRMED红球估计计样本，重复估计也各算一条。36个样本的均值10.039856cm、RMSE10.205957cm、最大12.479048cm；已确认但未匹配的样本为0。原始红检测匹配24条唯一、6条未匹配，ambiguous_track_ids为空。精确坐标约定、每条样本及限制见 `report/REPORT.md`、`report/evaluation.json`。

## 来源、完整性和严格离线回放

`source-commit.json`逐一比较冻结提交的7个brain文件和driver的Git blob SHA256、原始before/after manifest、brain summary源码SHA；8文件全部一致，driver记录sourcesUnchanged=true。平台与capture函数记录前后也一致。证明使用本局冻结字节，不依赖之后可能修改的工作树版本。

`export-status.json`记录record、samples、sensorAudit、captures、envelope全部完成，failures=[]、partial={}。`archive-integrity.json`重新流式读取4个gzip至EOF，校验gzip CRC、压缩及展开SHA256和字节数，并校验envelope。

原始record为30,599,585字节，展开43,510,699字节；压缩SHA256为 `5d2652af8c49f678a6768195b150cd9ced07aae4cbfa879ed070d3ecffe2e4ec`。它低于100MiB阈值，因此保留完整原gzip，无分片、无解压重压、无新增忽略规则。

严格LLM离线回放读取原历史state、prompt及响应/错误记录，20轮及22条请求完全匹配，消耗全部记录，除mode字段外完整记录一致；重现最后三次HTTP502及相同终止异常。模型网络调用0、环境访问0，原始证据未变。它不重新运行物理场景，也不改变原局FAIL。

复算命令（仓库根目录；评测退出码1表示完整FAIL报告）：

```sh
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-16/map-05-run-1 --out artifacts/autonomous-brain/map05-run-16/recomputed-report
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/map05-run-16/map-05-run-1 --out artifacts/autonomous-brain/map05-run-16/recomputed-llm-replay
```

`archive-checks.json`记录原始文件SHA、前15局45份报告保持不变、索引仅追加、独立评测与回放结果；发布检查扫描本局全部普通文本及gzip展开内容，检查凭据格式和绝对用户路径，仅保存命中规则和文件名、不输出疑似敏感值。真值仅在本局结束后供独立离线评测使用，未传入模型或后续运行。
