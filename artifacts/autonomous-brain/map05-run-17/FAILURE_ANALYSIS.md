# Run17：首球实际交付、放置漏判，评测方停止，正式 FAIL

本局采用正式200轮/1200仿真秒上限，冻结源码提交 `33b16ca7ea5c849bfecb080353cdd4f28d8bcd62`。独立v3评测确认实际有效交付1/2；第二球未抓取，没有成功的observed done。r33放下首球后夹爪为空，但没有符合原像素门控的放置见证，记忆转为RELEASED_UNVERIFIED且无法在该冻结版本中恢复。评测方依据这一公开状态问题正常请求停止。r37模型正常返回look_around，随后turn收到NOT_RUNNING；它属于外部停止影响，不是模型传输失败。driver完整导出后exit1，本局保留正式FAIL，不能作为十布局门票。

## 复算指标

| 项目 | 结果 |
|---|---:|
| round记录 / 已产生动作 | 37 / 37 |
| 模型请求 / 观测 / motion / bridge调用 | 43 / 250 / 177 / 1,179 |
| 模型累计elapsed_s / 另计重试等待 | 895.006531623 / 5秒 |
| brain墙钟 / driver进程墙钟 | 998.536689875 / 998.633秒 |
| 仿真时间 / 最终tick | 205.62秒 / 10281 |
| 成功动作 / 原动作失败 / 外停错误 | 29 / 7 / 1 |
| 模型执行终止错误 | 0 |
| explore / look_around / go_to / pick / place | 22 / 8 / 5 / 1 / 1 |
| take_exit / turn / follow_road / forward / backward | 25 / 95 / 29 / 19 / 6 |
| grab / release | 2 / 1 |
| 模型传输错误 / 状态校验拒绝 | 5 / 1，均恢复 |
| 有效交付 / 要求 | 1 / 2 |
| 非白名单脑请求 / 非白名单已接受调用 | 0 / 0 |

模型累计耗时是原始 `llm.jsonl` 的elapsed_s之和，包含失败请求，不含另计的重试等待或动作耗时。37条round均有动作；r37的失败执行请求属于177条motion记录之一，不代表外部停止后车辆实际转动。8条失败round分为7条原动作失败与1条外停错误，不能合并称为8次自主动作失败。数据和输入SHA见 `run-metrics.json`，原始证据位于 `map-05-run-1/brain/`。

## 动作失败、模型重试与外部停止

| 分类 | 轮次 | 结果 |
|---|---|---|
| 原动作失败 | r9 | road_blocked_returned_to_junction |
| 原动作失败 | r23、26、28 | known_route_exhausted_needs_exploration |
| 原动作失败 | r33 | released_ball_not_verified_in_storage |
| 原动作失败 | r35、36 | road_blocked_at_junction |
| 外部停止影响 | r37 | 模型返回look_around后，turn: NOT_RUNNING |

5次传输错误为call12 URLError、call16 RemoteDisconnected、calls21/30/34 HTTP502，均在下一次传输重试恢复；全局额外等待5秒，没有重试耗尽。call11曾输出未确认目标的go_to，被 `go_to requires a CONFIRMED object` 拒绝；同一决策的唯一修正请求先发生call12传输错误，call13重试后成功。全部37个决策最终产生动作。记录中的LLM为v12，transport_retry_limit=5，实际temperature=0.6；本局不包含参数回退或终止模型错误。

`evaluator-stop.json`记录2026-09-25T15:38:40.188Z于tick10281设置 `stopRequested=true`，原因是r33已释放但未验证的身份持续pending。原始CDP响应保存在 `evaluator-stop-cdp.json`，其status value与规范化停止记录的result相同；两个原件均保留，哈希与对应关系见 `run-metrics.json`。停止时没有从动作结果预判物理送达。

r37的call43耗时92.676519417秒，无传输或状态校验错误，返回合法 `look_around {}`；随后brain-001179的turn在tick10281收到NOT_RUNNING。唯一controllerError与此对应，pageErrors为空。最终driver status=complete，process.interrupted=null，stopError/exportError均为空。没有达到轮数或仿真上限，也不能将后续外停错误当成导致r33漏判的原因。

## 首球抓取与放置时间线

WM `target_031` 首次入库为r13/obs74/49.46秒；接受位点obs74、89、113后，在r20/obs113/75.48秒CONFIRMED。r22执行一次pick、共两次grab：obs131→132在89.34秒holding=false；obs133→134在91.06秒holding=true。独立原生抓取事件为tick4539/90.78秒。之后5次各6cm后退，obs139/94.26秒holding=true且old_position_matches=0，记 `grasp_observed`，final140；pick结束时已经在观测道路上，额外road_return为空。不能把原生抓取、holding观测和pick证实的时间混为一项。

r33从obs211开始，release为obs224→225；obs225/188.82秒holding=false，release前已有其他红球记忆ID为025、052。后退25cm后的实际判断帧为obs226/191.50秒，candidate_witnesses=0、placement=null，于此记为RELEASED_UNVERIFIED。随后归路成功，4次forward为7、7、7、4.002499219cm，结果obs230/tick9776/195.52秒，final231。不得用归路后帧代替实际判定帧，也不得用归路成功代替送达证据。

独立原生记录中，首球交付事件为tick9420/188.40秒，且未撤销。终端sample tick10281与record end tick完全相同：target-1已释放、有效交付事件仍在、终态位于存放区内；target-2无grab/delivery事件且在区外。因此实际有效交付为1/2，r33为一次place false-negative。

## r33为何缺少合法传感见证

obs226有且仅有一个红框(282,208,78,64)，不是完全没有看见红球。球底点为(321,272)，最大完整绿色框storage-zone_053为(45,258,374,86)。冻结 `autonomous_brain/actions.py:184–195` 要求球底点落在绿色框内椭圆，归一化平方必须≤0.64；本帧为0.6813553675084635，未通过。其他绿色分量的最小值为29.523341049，或尺寸本身不满足完整区域要求；因此合法像素见证数确为0。逐区域计算保存在 `run-metrics.json` 的 `r33_public_witness_diagnosis`。

该红检测raw距离35cm、M5距离42.434193cm、track_id=null，未被标记known_delivered_object_id。近场无track ID本身允许成为合法释放见证，不能把失败归因于缺少track ID。这里失败的是原内椭圆像素门控。

冻结版本在 `actions.py:1164–1165` 仅对“当前红检测全部标记为已送达旧球”的零见证情况进入有界换位重观察。本帧不满足该条件，结果没有reobservation字段，未执行额外视点。随后mark_release_unverified保留公开状态；最终031仍RELEASED_UNVERIFIED/pending、052仍STALE/pending，025作为从未确认的LOST假设退休。没有后续成功done。

这一结论与独立物理送达并存：本局证明传感判定漏掉了实际交付，不能据此放宽像素门限或声称所有放置问题均来自同一种原因。放前动态瞄准点漂移的纯传感诊断和后续修复资料单独保存在 [first-release-fixed-aim-fix-20260926](../first-release-fixed-aim-fix-20260926/)。目标漂移不等于物理送达缺失，也不保证修复成功；后续工作不改变本局冻结记录及FAIL结论。

## 逐球时间线、Judge及WM误差

下表仅供结束后的独立评测。原始检测匹配采用同帧、同类、真值投影中心落入精确检测框且双向唯一的几何对应；不独立证明遮挡可见性，WM首次入库也不是首次原始检测。

| 物理目标 | 首次匹配原始检测 | 首次匹配WM / 确认 | 原生抓取 / 有效交付 |
|---|---|---|---|
| guangyang-target-1 | r2/obs5，2.76秒 | 025于r10/obs51，34.58秒首次入库；031于r20/obs113，75.48秒确认 | 90.78 / 188.40秒 |
| guangyang-target-2 | r11/obs60，41.28秒 | 无可绑定的WM入库或确认记录 | 无 / 无 |

025与031的同类几何匹配来自独立评测；不能将它们算成两个物理红球。052没有可靠真值绑定，不能直接称为第二物理球。

独立Judge仅对能够绑定身份、持球状态、执行窗口和精确tick真值的pick/place给出结论：eligible=2，r22 pick一致1次，r33 place漏判1次，false-positive=0、unverifiable=0，其余35轮not_evaluated。这里没有给explore/look_around/go_to/done套用真值成功判定。

WM误差按每条观测中可唯一绑定且具备同帧真值的CONFIRMED红球估计计样本，重复估计也各算一条。本局21个样本均来自同一保持不变的已确认估计，均值、RMSE和最大误差约1.514426cm，不能把21条重复估计解释为21次独立位置测量。未匹配confirmed样本0；原始红检测48条唯一匹配、36条未匹配，ambiguous_track_ids为空。全部样本及限制见 `report/evaluation.json`、`report/REPORT.md`。

## 来源、完整性与严格离线回放

`source-commit.json`在解除源码冻结前锁定7个brain文件及driver的Git blob SHA256、运行before/after manifest及brain summary SHA，8项全部匹配冻结提交。driver sourcesUnchanged=true，平台及capture函数前后一致。证明不使用之后改变的工作树版本。

record、samples、sensorAudit、captures、envelope五项正式导出complete，failures=[]、partial={}。`archive-integrity.json`流式读取4个gzip至EOF，核验CRC、压缩与展开字节数及SHA256，并验证envelope。原record为58,279,635字节、展开84,201,746字节；压缩SHA256为 `32b946f7c77d8d33f4a09967ec1fa21bec0bfb18975edb464fb03d7de5e7bfef`，低于100MiB，无分片、重压或新增忽略规则。

严格LLM回放使用原历史state/prompt和响应/错误，37轮、43条调用全部匹配，除mode外完整记录一致，network=0、environment_access=0，原始证据不变。最后一轮成功模型返回与之后记录的外停执行失败分别保留；此回放不重跑物理仿真，也不改变本局FAIL。

复算命令（仓库根目录；评测退出码1代表完整FAIL报告）：

```sh
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-17/map-05-run-1 --out artifacts/autonomous-brain/map05-run-17/recomputed-report
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/map05-run-17/map-05-run-1 --out artifacts/autonomous-brain/map05-run-17/recomputed-llm-replay
```

`archive-checks.json`保留原始文件哈希，验证前16局48份报告与索引历史不变；发布检查包含全部普通文本及4个gzip展开内容，不输出任何疑似敏感值。真值只用于本局结束后的独立评测，未传入运行中的大脑或后续模型状态。
