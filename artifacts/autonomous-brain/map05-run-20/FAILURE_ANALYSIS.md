# map-05第二十局：两球实际交付，200轮上限FAIL

**整体FAIL，独立有效交付2/2。** 原生record中两球均有未撤销的交付事件，最终真值sample确认都在存放区内且未被持有；脑的target_031与target_111也各有公开放置见证并标为DELIVERED。但运行没有请求或完成done，按原冻结规则在第200轮结束后以round_limit失败。十布局门禁仍未通过，物理2/2不改写为正式成功。

这次没有评测方主动停止，没有墙钟超时，没有终止性模型错误。driver status=complete、sourcesUnchanged=true；child code=1，signal/interrupted=null，额外wallTimeoutSeconds=0。五项平台导出完整。第200轮explore本身成功观察到新蓝球假设，随后触发200轮上限；不是该动作抛出异常。

## 指标与来源

| 项目 | 复算结果 |
|---|---:|
| 完成轮次 / 模型请求 | 200 / 216 |
| 观测 / motion / bridge请求 | 1376 / 976 / 6481 |
| 模型请求elapsed总和 | 2591.529288086秒 |
| 重试等待（单列） | 1秒 |
| brain / driver墙钟 | 3187.758110666 / 3187.926秒 |
| 仿真时间 / 最终tick | 1077.68秒 / 53884 |
| 正式上限 | 200轮 / 1200仿真秒 |
| 自报成功 / 动作失败 | 173 / 27 |
| 执行异常 / 控制器错误 / 外停错误 | 0 / 0 / 0 |
| 网络错误 / 输出状态校验修正 | 1次HTTP502 / 15次 |
| grab / release | 4 / 2 |
| 自主done / 独立有效交付 | 0 / 2 of 2 |

216条为本次真实模型调用，包含重试及修正，不是216个决策。唯一HTTP502在call84/decision78，后续call85恢复，等待1秒。15次状态校验错误全部为go_to requires a CONFIRMED object：call12/46/52/70/72/76/91/94/97/120/131/134/140/149/159，均通过当轮唯一修正完成，未生成终止性模型错误。完整映射和elapsed字段见`run-metrics.json`。

动作分布：explore122、look_around62、go_to12、pick2、place2。小动作分布：turn638、follow_road192、take_exit102、forward26、backward12、grab4、release2。6481次桥调用终态均completed，非白名单请求和拒绝调用均为0；不能因此推断所有动作成功。

冻结生产提交为`6ee4abf464504eb297242df98dc9fadaaf7debfa`，启动HEAD为仅文档更新的`44247e0c64f42a37f90ea85c634b09375069d8fb`。`source-commit.json`逐项比较8个Git blob：7份brain及driver同时匹配生产提交、启动HEAD、运行前后manifest；7份brain还匹配child summary SHA。完整manifest前后相同，平台/capture记录指纹不变。版本为actions v19、perception v7、navigation v4、LLM v12、runtime v10、driver v6、独立评测v4；后续工作树不参与本局来源证明。

严格离线LLM回放200轮/216条全部匹配，完整记录除mode外相同并全部耗尽；使用的LLM源码与冻结版本SHA相同，网络调用0、环境读取0，原件哈希不变。该离线检查验证已保存模型输入输出，不把它当作重新完成机器人任务。

## 每球时间线：原生事实与脑内身份分列

以下原生真值时间线来自独立评测，单位均为仿真秒：

| 原生目标 | 首次原始看到 | 全局可绑定的首次WM记忆 | 抓到事件 | 有效交付事件 | 终态 |
|---|---|---|---:|---:|---|
| guangyang-target-1 | obs5/r2，2.76 | target_025，obs61/r11，39.22 | 114.86 / tick5743 | 234.04 / tick11702 | 存放区内，未持有，事件有效 |
| guangyang-target-2 | obs70/r12，45.92 | target_056，obs225/r31，187.10 | 481.92 / tick24096 | 564.44 / tick28222 | 存放区内，未持有，事件有效 |

两球最终sample tick均为53884，与record end tick相同；到存放区中心距离分别0.3679178599、0.5382247026（平台世界单位），均在原0.95半径内，无交付撤销事件。全局身份歧义使原评测两球first_confirmed保留null，不按动作编号偷偷填补。

脑内实际操作的身份时间线另列，不把下表自动等同于全局唯一真值绑定：

| 公开记忆身份 | 首次WM记忆 | 首次CONFIRMED | 抓取后验 | 放置后验 | 次数 |
|---|---|---|---|---|---|
| target_031 | obs89/r16，58.66 | obs137/r23，86.62 | obs181/r28，118.34；obs182进入HELD | obs294/r41，237.14；obs295进入DELIVERED | 2抓、1放 |
| target_111 | obs551/r85，413.48 | obs604/r93，449.44 | obs664/r101，485.40；obs665进入HELD | obs723/r105，567.54；obs724进入DELIVERED | 2抓、1放 |

031的grab为173→174失败、175→176持物成功（obs176@115.14秒）；111为656→657失败、658→659持物成功（obs659@482.20秒）。每次pick均少于三次抓取上限，并完成5×6cm退后确认；持物和原位置15cm内无同类检测共同支持抓取。公开确认时间不能替代更早的原生grab事件时间，放置后验也不能替代原生交付事件时间。

## 公开抓放证据

独立公共日志核验保存在`public-observation-proofs.json`，与真值Judge分开。 `public-execution-audit.json`另核验全部49次next_junction_observed都有新帧、onRoad/atNode、当前出口及真实位移，未发现原Run19那种零进展且无节点的假PASS；全部14次go_to/pick满足CONFIRMED前置，4次成功go_to均符合当帧25–40cm/10°门槛。1376次观测的相机/里程计/道路tick和976次motion引用、200个动作after/final引用均一致。

r28从CONFIRMED/hit4、空夹爪且在路上开始；两次抓前WM距离复算22.007732474cm、16.008596810cm，fresh bearing为0.666279238°、1.807662669°。r101从CONFIRMED/hit7开始，对应22.088411308cm、16.145731221cm与0.891176466°、1.737859721°。近场检测只刷新可见信息，没有借此增加确认hits。两次抓取后都holding=true，原位置同类检测重算为0。

r41首次放置固定obs288完整绿色框(159,252,365,90)中心像素(341.5,297)的地面点；obs292最终18.055987943690138cm、−0.3082142900920246°，满足19cm/3°。release后的obs293@234.46秒夹爪为空，退后后obs294@237.14秒在路上；唯一新红框(282,210,72,60)底点(318,270)相对于完整绿框(182,239,269,49)，内椭圆q=0.0705117149995101≤0.64。

r105放置前obs717仍识别旧031。完整绿框(147,247,325,72)的左四分点被旧球扩展框占用，选择未占用的右四分点(390.75,283)，固定地面点(0.9935198007258171,−0.10293494869487282)米。obs721最终17.991907745203036cm、0.05400154039105587°；释放后的obs722@564.86秒夹爪为空。

后验帧obs723@567.54秒同时有两个分离红框：旧031为(160,212,92,64)，新球为(276,210,88,62)，水平间隔24像素。完整绿框(96,248,290,48)内，旧球q=0.08604174924032237但被known_delivered与preexisting身份排除；新球底点(320,272)的q=0.2968370986920333≤0.64，重算仅一个合格配对。新球track_id=null、raw31cm，是原近场规则允许的独立像素见证，未假造新的CONFIRMED身份。placement类别、位置、双bbox、frame及释放边界逐项相符。obs724/725两轨迹均为DELIVERED。

两次place均为3次前进、1次对准转向，未超过8平移预算；退后25cm已在观测道路上，不需额外归路或有限复观测。成功来自放后原像素见证，并非仅因空夹爪或回到道路。

## 原始全局Judge、WM误差及补充时间前缀诊断

**原始冻结v4评测保持不变：4次抓放全部unverifiable，match=0，false_positive=0，false_negative=0；其余196轮不在抓放对照范围。** 这不代表零误判或100%正确。全局target_031、target_111、target_152分别出现两个真值候选，原评测按全局唯一身份规则拒绝绑定。96个确认轨迹观测均无法计入位置误差，有效样本0，mean/RMSE/max全部null，不能写成零误差。

另行完成的[时间前缀诊断](../run20-binding-review-20260926/REPORT.md)使用原冻结v4和既有完整记录，没有改本局brain、原评测或门限。该诊断先逐字段重现原全局perception与Judge，再仅使用每次动作当时的完整观测前缀：r28/41/101/105四次抓放均match。这是有明确时间范围的补充结果，不替代上段原全局结论，也不改变正式FAIL。

同一诊断另存`causal-target-timeline.json`（SHA256 `9cb946203a7a1ccf247f5bd974ed621e1e2c9ddb903b2f77d7dd06e3364f8204`），用各动作当时的完整前缀把031/111分别唯一关联到原生目标1/2，补充以下有范围的时间线；原全局first_confirmed仍为null，不覆盖：

| 时间前缀关联 | 首次看到 / 确认 | 原生抓到 / 交付 | 脑内抓取 / 放置后验 |
|---|---|---|---|
| target1 ↔ 031 | 2.76 / 86.62（obs137/r23） | 114.86 / 234.04 | 118.34 / 237.14 |
| target2 ↔ 111 | 45.92 / 449.44（obs604/r93） | 481.92 / 564.44 | 485.40 / 567.54 |

该诊断最早冲突前obs1–721含94个有效位置样本，mean5.091220654684154cm、RMSE5.7096671963272cm、max8.458884590269527cm；另2个持物后no_active_same_frame_truth仍未匹配。全局冲突帧为722/867/1063/1064/1065/1073/1074/1075/1089/1147/1161，既有送达身份抑制的贪心匹配逐项原样复现。`diagnostic-v2.json` SHA256为`719433c51897f882acf79176d0208c4544f4bca3f0c52f188e4357e37809af9a`。首版诊断因漏传既有summary而出现timeline比较失败，原失败保留；v2补上传入该原摘要后通过，没有算法或门槛变化。

## 未完成原因与动作失败

冻结done规则仍要求：空夹爪、没有待处理红球义务、存在道路节点，且未完成/未阻挡出口计数U=0。本局未改变这一旧条件，用户对未来完成范围的澄清在归档时仍待答复，不能据两球物理交付直接回写成功。

第106轮开始时两轨迹已DELIVERED，pending_objects=[]、空夹爪，但U=25。随后95个决策状态的U范围13–29，始终没有达到0；末轮决策U=13、36个节点，并有未确认假设target_193待处理。最终summary道路表仍为36节点/U13，193为TENTATIVE；这些记忆数字不能证明还存在第三个物理目标或某条道路永久不可达。期间未确认假设反复产生和退役，模型继续探索/扫描，没有发出done。公共执行与循环审计见`public-execution-audit.json`。 其中r155–156构成一个有证据的有限回路：obs1079→1091回到相同里程计姿态，走过176.1cm、20.52秒，模型选择的出口原本已标completed；本例没有证明出口完成记账遗漏。r160以后U从27降到13，不能将这一局概括为永久循环或永久不可达。

27次原动作失败，均保留原结果：

| 原因 | 轮次 |
|---|---|
| road_blocked_returned_to_junction | 10,26,45,46,83,89,107,116,130,133,146,148,149,168,170,185,191,198,199 |
| visual_standoff_requires_road_reposition | 24,94,96 |
| known_route_exhausted_needs_exploration | 29,33,35,39 |
| route_no_progress | 102 |

最终r200的explore成功只表示新对象distractor_194被观察到，不表示红球任务自主结束。最后obs1376@1077.68秒夹爪为空且在道路上；200轮上限先于1200秒上限结束运行。评测器通用execution_or_controller_error来自brain failed/round_limit，实际执行异常、controllerErrors和外停错误均为0，不误归因于Kimi终止、外停或driver墙钟限制。

## 完整归档与复核

`archive-integrity.json`对全部五项导出独立核对压缩/展开SHA256和大小，4份gzip读至EOF通过CRC。record原压缩322,036,353字节、展开463,181,160字节，SHA256为`c2295736ba0744639d85780586be0dbb040979a421ee1e6134a0b4ec661cb7bf`。按原gzip字节切为七片（六片50MiB及末片7,463,553字节），实际恢复新临时文件后核对总SHA，仅删除该临时副本；原文件保留本机，精确忽略路径，不解压重压或删帧。恢复见[record-chunks/README.md](record-chunks/README.md)。

`original-input-hashes.json`保留25份原始证据哈希，`archive-checks.json`复核原件及前19局51份历史报告未变。`publication-checks.json`扫描当前归档文字和gzip展开内容；七分片由原gzip扫描和恢复身份校验覆盖。源码、旧结果、docs和正式索引未由本归档修改。所有记录保留相对仓库路径，真值只用于运行结束后的独立评测。

从仓库根目录复核（另选新输出目录；评测exit1表示生成完整FAIL报告）：

```sh
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-20/map-05-run-1 --out artifacts/autonomous-brain/map05-run-20/recomputed-report
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/map05-run-20/map-05-run-1 --out artifacts/autonomous-brain/map05-run-20/recomputed-llm-replay
```
