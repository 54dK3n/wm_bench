# v3 opt-1：阶段1数值门通过；过滤test已污染

两轮各完整执行map-01…map-10一次，均为9/10布局确认并抓到对应真球，合并map-01/map-03重复目标轨迹后为**8/9个独立场景（88.89%）**。第二轮满足全部15项数值门：map-02成功、幻影首次CONFIRMED为0、程序错误为0、原地重复observe为0、固定规则无违规、无捕获回归。

过滤器第二轮是在首轮test失败反馈后修改，因此其同一测试集数值PASS只是**已污染测试回放**，不是独立泛化测试通过。首轮失败保留。实际送达两轮均只有4/10，map-04从旧R3成功退化为失败且未恢复；本报告不宣称总体送货稳定，也不宣称后续阶段完成。

| 项目 | round-1 | round-2 |
|---|---|---|
| 程序版本 | wm-opt1-r1-20260923 | wm-opt1-r2-20260924 |
| 执行布局 | 10/10，各一次 | 10/10，各一次 |
| 确认且抓到 | 9/10布局；8/9独立场景 | 9/10布局；8/9独立场景 |
| map-02 | C；WM误差5.4cm；95.02s抓到 | C；WM误差5.4cm；95.02s抓到 |
| 唯一未确认/抓取布局 | map-07 | map-07 |
| 幻影首次CONFIRMED／无法绑定真值 | 0／0 | 0／0 |
| program_error／原地重复／运动守卫违规 | 0／0／0 | 0／0／0 |
| 捕获回归场景 | 0 | 0 |
| 实际observe总数／单局最大 | 131／52≤92 | 132／52≤92 |
| 每局最大全部视觉证据 | 10,781,831≤20,971,520 bytes | 10,776,801≤20,971,520 bytes |
| 平台实际目标送达 | 4/10：02、03、05、08 | 4/10：02、03、05、08 |
| E位置精度样本 | 1局/1独立场景，8.6cm | 同一场景1局，10.3cm |
| G位置精度样本 | 0 | 0 |
| 预检 | 175测试通过；指定pylint零错误 | 178测试通过；指定pylint零错误 |
| 批跑冻结检查 | 22/22源码SHA一致 | 22/22源码SHA一致 |
| 所有数值门 | FAIL，仅过滤test门未通过 | PASS，15/15；test污染限制保留 |

阶段1独立场景为S01=(map-01,map-03)，其余S02…S09分别为02、04、05、06、07、08、09、10，仅S06/map-07失败。两轮是确定性布局的重复评估，不能合并声称16/18个独立测试场景。E也不能把两轮重复计成两个独立泛化样本；G无覆盖，B/C/D仅作已参与开发位置的报告。

第一轮从冻结stage-1 R3复制单球程序，修复两项规划语义：局部front_clearance只记实际测得道路停止边界，不封掉整条道路方向；未知frontier入口绑定指定端点，避免反复回到已测落点。沿用已有5cm/15cm规则，没有新增经验距离阈值；并删除未使用target锚点读取。修复数值、旧R2/R3因果和针对性回归见[planner_change.md](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/planner_change.md)。同时接入独立dev选择的红<.84、蓝<.80置信度过滤，完整raw日志先输出，M5/WM/确认核心不改。

首轮冻结过滤test的四个性能子门全部失败。第二轮仅把既有confidence过滤限定在**40≤原始距离<90cm**的原WM窗口；窗外、封顶或数值缺失时保留。版本与filter之外，M5、WM融合、确认、规划、approach/grab/delivery及运动守卫与opt1第一轮不变。[直接源码diff](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/round1_to_round2_review.diff)和[24项独立静态审查](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/pre_run_review.json)证明该变更范围。

| 封存test性能，红蓝分别计数 | v1首次冻结测试 | v2同集回放（已污染） |
|---|---|---|
| 红原始真/假 | 40/19 | 40/19 |
| 红过滤真/假 | 1/10 | 0/2 |
| 红误杀≤2% | 1/40=2.50%，FAIL | 0/40=0%，数值PASS |
| 红过滤precision≥95% | 10/11=90.91%，FAIL | 2/2=100%，数值PASS |
| 红残余假占比 | 9/48=18.75% | 17/57=29.82% |
| 蓝原始真/假 | 11/98 | 11/98 |
| 蓝过滤真/假 | 2/10 | 0/4 |
| 蓝误杀≤2% | 2/11=18.18%，FAIL | 0/11=0%，数值PASS |
| 蓝过滤precision≥95% | 10/12=83.33%，FAIL | 4/4=100%，数值PASS |
| 蓝残余假占比 | 88/97=90.72% | 94/105=89.52% |

该test来自旧stage-1 round-3的133次observe、168条检测（红59、蓝109），标签unknown=0、ambiguity=0，不能与两轮新跑的131/132次observe混为一组。v2仅过滤6条已标假检测，precision分母红2/蓝4；大量假检测仍保留，不能据数值100%作强泛化结论。首次误杀逐条raw/PNG证据见[v1测试报告](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/filter-test-v1/TEST_REPORT.md)。[v2 evaluation_record](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/filter-test-v2/evaluation_record.json)明确污染=true、held_out_generalization_claim=false。

新增confidence阈值的依据来自原始标定采集和v28r1开发集，红/蓝均有至少三个完整相关类别轨迹在旧分组容差下两两不等价；v2的40/90仅复用原合同，没有新拟合阈值。具体支持行、完整轨迹和unknown计数见[v1开发依据](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/filter-candidate-v1/DEVELOPMENT.md)、[v2开发依据](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/filter-candidate-v2/DEVELOPMENT.md)及各轮正式SUMMARY。dev的10条v2过滤unknown不能冒充伪检测；开发支持也不能消除已经发生的test污染。

**送达退化单列。** 旧R3 map-04在127.58s抓取、201.54s实际送达（原始E3/E6，L403成功）。opt1两轮均在110.50s更早抓取同一个C位置球，但没有送达；在392.88s以“多次重规划后仍无法抵达节点”结束，holding仍为目标物，导航查询/控制468/177，未触及1000/300配额，program_error为0。两轮L600–622均反复于central-north progress34.1→22.8→43.5，front_clearance余量0.3cm。捕获回归门截止delivery_phase_start前，所以“capture回归0”不能用来抹去这项退化。详见[r2逐局送达证据](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/SUMMARY.md)及[旧R3原始局](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/map-04.json)。

两轮9个已抓球的首见、确认、抓取、道路/直线距离及比值、抓取真值前/侧向和视线夹角均完整。首见仅指同次原生图像/真值下唯一关联的最早未封顶raw，不是物理首次可见；时间使用精确tick/平台事件，里程使用精确端点或里程相同的静止括区，不在运动区间插值。未进入抓取或未送达一律保留未到达/null，不填0。每局原精度和原始L/E索引见[r1正式报告](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/SUMMARY.md)、[r2正式报告](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/SUMMARY.md)；两份数字审计分别98项全通过。

| 实际执行身份 | round-1 | round-2 |
|---|---|---|
| 原文件SHA256 | `a6527ca62bcbd643ca0a16842409834269ac292815a947ea9af25ae6404a28cd` | `6cc3479d55051161f2c451226bda3a61a578c8fd9f84d020848c902c2c5d35cc` |
| 原生sourceCode/执行SHA256 | `7aa429495b06a6696abcc2f74f32266610fd46c06ed21c0b4c44f10822ec2c02` | `25590162d87b90c4dcb6c1d9766d7e62a115bfc07f68c709c8a61fb75fd78e34` |
| filter SHA256 | `fe953d2e4f63db981e5eea33ff95dbedf524ed8f9a965046c12b830479c43659` | `57ea75300c330bea5b4ecdb7a529cdc802e617a76572c75f4f76fe6d319f7322` |

两轮wm_kit提交均为`ad237a143f0d35e100a28c15567d4b75bd56cccf`，嵌入ZIP SHA256均为`651a89967b41aad583b70e5f5095c5fc35f6babc950d8ab878748cb69e9f66e3`。各局L0四字段一致；执行快照直接导出完整原生record.sourceCode，未重新格式化，原文件只多末尾一个newline。[r1执行快照](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/EXECUTED_SNAPSHOT.md)、[r2执行快照](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/EXECUTED_SNAPSHOT.md)分别核对十局字节完全相同，附原生导出SHA和可重跑离线工具。各轮manifest的22份源文件均已原样归档，坐标扫描违规0、target锚点未重新读取；批跑期间未改代码。

本次在第二轮达到阶段1数值门后停止该阶段批跑；不把已污染过滤测试当独立留出验证，不追加仿真或事后隐藏失败。
