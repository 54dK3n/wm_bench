# Run14 失败分析 — 双球实际送达，第二次放置未获传感确认且未自主完成

本局独立评测为 **FAIL，实际有效交付2/2**。原生record中两球都有未撤销的交付事件，终端样本tick22795与record结束tick一致，两球最终均在存放区内且未被夹持。但大脑没有执行成功的observed done，第二次place把target_115保留为RELEASED_UNVERIFIED，评测方随后请求停止。物理送达不能代替完整自主任务验收。

driver v5正常结束并完整导出record、samples、sensorAudit、captures、envelope，failures为空。源码冻结提交为30d9b4ca734568d828646be7e302efc88169681f；七个brain文件和driver共8文件逐一匹配Git原始字节，前后manifest相等、sourcesUnchanged=true。导出成功、模型回放成功均不改变本局FAIL。

| 指标 | 从本局日志复算 |
|---|---:|
| 轮数 / 模型调用 | 77 / 93 |
| 模型请求累计耗时 | 3216.9288148789988秒 |
| brain墙钟 / driver子进程墙钟 | 3511.166486041 / 3511.317秒 |
| 仿真 / 观测 / motions记录 | 455.90秒 / 580 / 427 |
| 动作失败 / 模型执行错误 / 外部停止错误 | 15 / 0 / 1 |
| pick动作 / 实际grab调用 / release调用 | 3 / 8 / 2 |
| 大脑成功放置 / 独立有效交付 | 1 / 2 |
| 传输错误 / 状态校验错误 | 12 / 4，全部恢复 |
| 最终sample tick / record结束tick | 22795 / 22795 |
| 配置上限 | 200轮 / 1200仿真秒，均未达到 |

动作选择为40次explore、21次look_around、11次go_to、3次pick、2次place，没有done。93次调用连续且77轮最终都得到动作；模型错误为8次HTTP502、2次URLError、1次timeout和1次RemoteDisconnected，4次校验错误均为go_to requires a CONFIRMED object。模型累计耗时为llm.jsonl各elapsed_s之和，不含另计的15秒重试等待或动作用时。具体调用索引、重试、时间保存在run-metrics.json。

## 抓取与放置时间线

brain身份与真值身份分开报告。以下029/115是brain对象编号；原生事件只在对应grab/release的前后观测tick窗口内核对。该局029的全历史几何绑定存在冲突，不能用动作窗口的确定事件反推其每个历史视觉框都属于同一真值球。

| 事件 | 轮 / 观测 | 仿真秒 | 证据 |
|---|---|---:|---|
| target_029首次入库 | r13 / obs67 | 49.38 | TENTATIVE，1 hit |
| target_029首次确认 | r21 / obs125 | 81.98 | 3个合法不同位置命中；此前r17短段不足不等于永久无法确认 |
| target_029抓取 | r26 / obs153→156 | 103.24–105.86 | 两次grab，holding依次false、true；原生首球成功grab tick5279 / 105.58秒 |
| target_029抓取后验证 | r26 / obs161→162 | 109.06 | 5次6cm后退后原位置匹配0；标记HELD |
| 第一次release及真实交付 | r37 / obs266→267 | 220.44事件；220.86观测 | 原生首球release、delivery同tick11022 |
| 第一次传感放置验证 | r37 / obs268 | 223.54 | holding=false、candidate_witnesses=1；随后DELIVERED，归路成功 |
| target_115首次入库 | r63 / obs445 | 358.16 | TENTATIVE；raw66cm |
| target_115首次确认 | r65 / obs464 | 369.68 | obs445/463/464三个独立位置，raw66/55/40cm，3 hits |
| target_115第一轮抓取 | r70 / obs490→495 | 380.98–385.60 | 3次grab均holding=false，three_grab_attempts_failed |
| target_115第二轮抓取 | r73 / obs510→515 | 390.98–395.46 | 3次grab，holding依次false、false、true；原生第二球grab tick19759 / 395.18秒 |
| target_115抓取后验证 | r73 / obs520→521 | 398.66 | 5次6cm后退后原位置匹配0，HELD |
| 第二次release及真实交付 | r75 / obs555→556 | 435.56事件；435.98观测 | 原生第二球release、delivery同tick21778 |
| 第二次传感放置验证 | r75 / obs557 | 438.66 | holding=false，candidate_witnesses=0，placement=null；标记RELEASED_UNVERIFIED |
| 第二次归路与动作结束 | r75 / obs571→572 | 447.08 | road_return成功且on_road=true，但place结果仍失败 |
| 后续探索失败 | r76 / obs578→579 | 455.90 | road_blocked_returned_to_junction |
| 外部停止后的末轮 | r77 / obs580 | 455.90 | explore(exit_angle=68.2)内turn收到NOT_RUNNING |

029实际2次grab；115在r70和r73各3次，共6次。8次调用逐一对应原生交互事件：首球1次far后成功；第二球5次far后成功。完整窗口、holding和原生事件ID保存在run-metrics.json的manipulation_details，计数不是按成功pick动作数代替。

原生两球交付时间分别为220.44、435.56秒；最终两份有效交付均未撤销。首次原始视觉可唯一对应的时间分别为2.76、36.64秒。评测器对第一球的首次CONFIRMED保持“未能确定”：target_029的历史几何匹配出现两种真值候选，不能把brain的81.98秒确认记录强制填入真值身份时间线。第二球可唯一对应的首次确认是369.68秒。原始看到、WM入库、CONFIRMED、抓取事件和传感状态更新时间使用各自真实时刻。

## r75失败机制及停止边界

r75 place从obs545开始，放下前执行7次forward和3次turn；release后观测obs556时夹爪为空，后退25cm后obs557仍没有通过完整见证门控的候选，placement=null、candidate_witnesses=0。它返回released_ball_not_verified_in_storage。随后沿记录轨迹归路成功，不能把这一轮描述成持球未释放或归路失败。

obs557实际上有一个红框(256,156,72,108)与存放区056框(51,250,330,67)：球底点(292,264)满足内椭圆判据，归一化平方约0.550986，小于0.64。但感知将该红检测标为known_delivered_object_id=target_029、reason=matches_verified_placement，距已验证放置位置约0.0150053m，且029在本次release的preexisting列表中。因此冻结actions.py:948–952排除了它，最终见证数为0。不能把它描述成完全没看见红球或纯像素包含失败，也不能把该可能合并/邻近的红检测直接认定为115；动作所缺的是可区分本次释放对象的完整证据。可复算字段保存在run-metrics.json的r75_public_witness_diagnosis。

被冻结的perception.py:491–496只允许HELD进入mark_delivered；actions.py:907要求当前夹持且有held_object_id才能place，llm.py:140–141又要求go_to/pick对象当前CONFIRMED。RELEASED_UNVERIFIED继续阻止completion，但没有延后验证该次释放的通路。r77输入的pending_objects仅target_115；029为DELIVERED，两个从未确认的旧假设退役，resolved_reacquired_identities为空。最终还记录28个路口和34个未探索出口，因此即使补上放置确认也不能直接宣称本局当时已满足全部done条件。

“没有严格见证”不等于“没有实际送达”。离线原生事件与最终真值确认第二球已经有效交付；本次place因此是独立Judge假阴性。相反，真值不能倒灌给运行中的brain、替它将对象标为DELIVERED，也不能放宽原有确认与像素见证门槛。此归档不推断零见证的唯一光学原因，也不把后续探索道路受阻声称为所有物理道路均不可达。

评测方在tick22795请求stopRequested；原始CDP响应和规范化停止记录分别保存于evaluator-stop-cdp.json、evaluator-stop.json。r77模型正常返回explore动作后，turn收到NOT_RUNNING，envelope中同tick有1条对应控制错误。这属于外部停止后的错误，模型请求未耗尽、没有达到轮数/时间上限、也不是自主done。原生run_finished的reason=finished只表示记录结束，不是本任务验收PASS。

## 失败动作与独立Judge

| 轮 | 动作 | 原因 |
|---|---|---|
| 8、24、38、44、59、61、76 | explore | road_blocked_returned_to_junction |
| 22、23 | go_to(target_029) | visual_standoff_requires_road_reposition |
| 27、29、32 | go_to(storage-zone) | known_route_exhausted_needs_exploration |
| 66 | go_to(target_115) | visual_standoff_requires_road_reposition |
| 70 | pick(target_115) | three_grab_attempts_failed |
| 75 | place | released_ball_not_verified_in_storage |
| 77 | explore | turn: NOT_RUNNING，external_stop单列 |

Judge可对照范围5个pick/place：一致2（r70失败与r73成功）、假阳性0、假阴性1（r75）、无法核验2（r26与r37的target_029全历史几何身份歧义）；其余72轮不在对照范围。不能把无法核验算正确，也不能由零假阳性推断所有探索动作正确。动作窗口原生事件证明与评测器保守几何绑定口径并列保留，不静默改写Judge结果。

WorldModel位置误差只包含可唯一绑定的CONFIRMED轨迹观测：51个样本，均值8.050884221966674cm、RMSE8.05088422196668cm、最大8.050884221966683cm。51是状态保存次数，不是51个独立确认视角；另35个确认轨迹观测因身份限制未纳入，1个身份冲突轨迹。原始红球框对应126 unique、21 unmatched、20 ambiguous。误差仅报告，没有新增成功阈值。

brain共2749条bridge调用，非白名单请求0；record非白名单已接受调用0、拒绝调用0。原生记录另有5次off_road事件，本归档保留为诊断事实，不增设或删除既定任务成功条件。

## 原始证据、恢复与复算

record原gzip为133,111,051字节，超过100MiB，以50MiB原始压缩字节分成3片（52,428,800、52,428,800、28,253,451字节）。本机原gzip保持原样，只对该精确路径添加gitignore；提交的分片没有解压重压。完整SHA256：

```text
bbb00e1104264cf837fc05669ed711244929d2dfd5d75eecc0b2714674099235
```

仓库根目录执行：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/map05-run-14/record.chunks/manifest.json
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-14/map-05-run-1 --out artifacts/autonomous-brain/map05-run-14/recomputed-report
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/map05-run-14/map-05-run-1 --out artifacts/autonomous-brain/map05-run-14/recomputed-replay
```

复算输出目录须尚不存在；评测退出码1表示已完整生成FAIL报告。分片已在仓库外隔离临时目录恢复并逐字节及整体SHA比较，临时副本清理完毕。四份gzip读至EOF，CRC/长度/压缩及展开SHA与evidence.json匹配；envelope字节哈希匹配，最终sample=endtick。所有580份原始brain观测及导出原件字节保留。

严格离线LLM重放PASS：77/77轮、93/93调用完整耗尽，除mode外重放记录一致，网络调用0、环境读取尝试0、原始日志不变。重放涵盖恢复后的模型动作与其后的执行失败，并非全仿真重放。源证明仅比较冻结Git blob与前后manifest、brain自记SHA，不把修复后的工作树当成本局运行源码。

逐球真值、位置误差和失败原始依据见report/；完整动作窗口、传输错误及公开状态时间线见run-metrics.json；8文件证明见source-commit.json；压缩与分片恢复校验见archive-integrity.json；前13局索引条目、39份旧报告及原始文件保留证明见archive-checks.json。旧局结论不被本局两次实际交付替换。
