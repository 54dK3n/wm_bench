# opt-1 round-2：阶段1数值门通过（过滤test已污染）

判定：**阶段1数值门PASS，15/15门通过**。9/10布局确认并抓到对应真球，独立场景8/9=88.89%，捕获回归0组。过滤器v2在已暴露测试上的数值达标，但v1测试反馈参与了v2范围选择，**不能宣称独立测试泛化通过**。实际送达仍4/10，map-04旧R3送达成功→opt1失败的退化未恢复；不宣称总体送货稳定。

| 退出条件 | 判定 |
|---|---|
| complete_ten_layouts | PASS |
| program_errors_zero | PASS |
| stationary_repeat_observes_zero | PASS |
| observe_motion_guard_violations_zero | PASS |
| observe_budget_92 | PASS |
| vision_budget_20mib | PASS |
| independent_confirmed_and_grabbed_at_least_80_percent | PASS |
| fixed_rules_no_failures_all_runs | PASS |
| fixed_rules_all_pass_for_confirmed_and_grabbed | PASS |
| no_regression_from_previous_successful_scenarios | PASS |
| map_02_confirmed_and_grabbed | PASS |
| phantom_CONFIRMED_zero | PASS |
| all_visual_evidence_at_most_20mib | PASS |
| frozen_filter_test_identity_matches_round | PASS |
| frozen_filter_test_metrics_pass | PASS |

| 布局 | WM对应球/标定 | 确认且抓到 | 误差cm | grab次数 | 前向/侧向cm | mission | 失败数值 |
|---|---|---|---|---|---|---|---|
| map-01 | B/已用于模型选择 | True | 2.5 | 3 | 11.4/1.2 | 0/13 | {"event": "flow_end", "success": false, "stage": "delivery", "reason": "未找到可确认的目标物存放姿态", "one_target_released": false, "navigation_queries": 140, "navigation_controls": 38, "full_targetDelivered": false, "holding": "目标物"} |
| map-02 | C/已标定 | True | 5.4 | 3 | 11.1/-3.6 | 1/13 | {"event": "flow_end", "success": true, "stage": "delivery", "reason": null, "one_target_released": true, "navigation_queries": 200, "navigation_controls": 69, "full_targetDelivered": false, "holding": null} |
| map-03 | B/已用于模型选择 | True | 2.5 | 3 | 11.4/1.2 | 1/13 | {"event": "flow_end", "success": true, "stage": "delivery", "reason": null, "one_target_released": true, "navigation_queries": 127, "navigation_controls": 34, "full_targetDelivered": false, "holding": null} |
| map-04 | C/已标定 | True | 2.7 | 2 | 13.3/-1.9 | 0/13 | {"event": "flow_end", "success": false, "stage": "constraint", "reason": "多次重规划后仍无法抵达节点", "one_target_released": false, "navigation_queries": 468, "navigation_controls": 177, "full_targetDelivered": false, "holding": "目标物"} |
| map-05 | C/已标定 | True | 2.4 | 2 | 13.5/-1.6 | 1/13 | {"event": "flow_end", "success": true, "stage": "delivery", "reason": null, "one_target_released": true, "navigation_queries": 192, "navigation_controls": 66, "full_targetDelivered": false, "holding": null} |
| map-06 | D/已标定 | True | 8.2 | 2 | 11.8/-4.7 | 3/13 | {"event": "flow_end", "success": false, "stage": "constraint", "reason": "多次重规划后仍无法抵达节点", "one_target_released": false, "navigation_queries": 411, "navigation_controls": 158, "full_targetDelivered": false, "holding": "目标物"} |
| map-07 | 无对应真球/None | False | None | 0 | None/None | 0/13 | {"event": "flow_end", "success": false, "stage": "confirmation", "reason": "WorldModel 未通过 observe() 确认目标物", "one_target_released": false, "navigation_queries": 505, "navigation_controls": 123, "full_targetDelivered": false, "holding": null} |
| map-08 | C/已标定 | True | 2.6 | 2 | 13.2/-1.5 | 1/13 | {"event": "flow_end", "success": true, "stage": "delivery", "reason": null, "one_target_released": true, "navigation_queries": 182, "navigation_controls": 62, "full_targetDelivered": false, "holding": null} |
| map-09 | E/未见过 | True | 10.3 | 4 | 13.1/3.9 | 0/13 | {"event": "flow_end", "success": false, "stage": "constraint", "reason": "多次重规划后仍无法抵达节点", "one_target_released": false, "navigation_queries": 492, "navigation_controls": 181, "full_targetDelivered": false, "holding": "目标物"} |
| map-10 | D/已标定 | True | 3.7 | 2 | 13.5/2.1 | 0/13 | {"event": "flow_end", "success": false, "stage": "constraint", "reason": "多次重规划后仍无法抵达节点", "one_target_released": false, "navigation_queries": 381, "navigation_controls": 151, "full_targetDelivered": false, "holding": "目标物"} |

| 布局 | observe | 原生图像bytes | 全部图像bytes | program_error |
|---|---|---|---|---|
| map-01 | 7 | 2164975 | 2338775 | 0 |
| map-02 | 7 | 2321004 | 2668850 | 0 |
| map-03 | 7 | 2211044 | 2559241 | 0 |
| map-04 | 8 | 2483356 | 2657332 | 0 |
| map-05 | 9 | 2844512 | 3192355 | 0 |
| map-06 | 10 | 3043867 | 3217767 | 0 |
| map-07 | 52 | 10776801 | 10776801 | 0 |
| map-08 | 9 | 2847220 | 3195141 | 0 |
| map-09 | 15 | 4034377 | 4208254 | 0 |
| map-10 | 8 | 2437501 | 2611550 | 0 |

| 独立场景 | 成员 | 通过 |
|---|---|---|
| S01 | map-01,map-03 | True |
| S02 | map-02 | True |
| S03 | map-04 | True |
| S04 | map-05 | True |
| S05 | map-06 | True |
| S06 | map-07 | False |
| S07 | map-08 | True |
| S08 | map-09 | True |
| S09 | map-10 | True |

| 布局/球 | 首见→确认→抓取→送达(s) | 道路/直线cm；比值 | 真值前/侧cm；视线夹角 | observe；全部图像bytes |
|---|---|---|---|---|
| map-01/guangyang-target-2 | 13.5→42.92→52.14→None | 59.5/48.71075787657443；1.2214960841045392 | 11.441710023297091/1.2054196467679519；-40.2 | 7；2338775 |
| map-02/guangyang-target-1 | 35.7→65.16→95.02→128.98 | 186.8/63.09658759875432；2.9605404524869727 | 11.12767389914409/-3.638502579478267；121.6 | 7；2668850 |
| map-03/guangyang-target-2 | 13.5→42.92→52.14→85.04 | 59.5/48.71075787657443；1.2214960841045392 | 11.441710023297091/1.2054196467679519；-40.2 | 7；2559241 |
| map-04/guangyang-target-2 | 34.36→52.96→110.5→None | 398.79999999999995/93.60394098520656；4.260504374094969 | 13.32924345481743/-1.8983448900919155；164.4 | 8；2657332 |
| map-05/guangyang-target-1 | 34.36→56.92→96.26→130.22 | 270.9/60.4921056806799；4.47827029579697 | 13.45472807353618/-1.6100412498628507；103.3 | 9；3192355 |
| map-06/guangyang-target-2 | 38.34→58.4→76.24→None | 129.3/71.70158209458491；1.8033074894977121 | 11.822737339374896/-4.736757967012536；116.6 | 10；3217767 |
| map-07/未抓到 | 首次确认 None；其余见原始轨迹 | 未到抓取，未知 | 未抓取，未知 | 见布局审计 |
| map-08/guangyang-target-1 | 34.36→56.92→88.94→122.88 | 221.20000000000005/60.44587473397491；3.659472229883536 | 13.167799290067798/-1.5167037803313224；102.7 | 9；3195141 |
| map-09/guangyang-target-2 | 69.06→89.78→122.88→None | 206.5/73.81779580662212；2.7974284214738785 | 13.082338802934665/3.9005496218175755；-45.8 | 15；4208254 |
| map-10/guangyang-target-1 | 41.28→48.94→56.12→None | 48.099999999999966/41.48449543116431；1.1594693270359968 | 13.531146202681683/2.1005145533141207；17 | 8；2611550 |

None 为未到达或证据未知，不能视为零。原始行、事件索引、里程边界与精确tick证据见 opt_report.json。定位测试结论仅E/G；其余球位只报告。分组方法/容差与旧stage-1一致。

| 未见位置 | 关联布局样本数 | 独立场景样本数 | 最终误差cm（逐样本） |
|---|---|---|---|
| E | 1 | 1 | [{"map": "map-09", "final_error_cm": 10.3}] |
| G | 0 | 0 | [] |

回归证据：

```json
[]
```

以下L为原始JSON `lines`、E为`record.events`的**零起始数组下标**，不是物理文本行号。[numbers_audit.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/numbers_audit.json)保留逐局事件/观测索引、固定规则证据及单球原精度数值；[audit_numbers.py](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/audit_numbers.py)只读现有记录复算，98项一致性检查全部通过。

| 验收门 | 具体数值与证据 |
|---|---|
| 十布局各一局 | [progress.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/progress.json)：10 executed、各图恰一次；19次重复分配在执行前跳过；unknown执行0。 |
| program_error=0 | 10局完整平台events中合计0；全部有run_finished。正常flow_end=false保留，不误记异常。 |
| 原地重复observe=0 | 132次实际observe，重复0；完整L索引与逐次原证据见数字审计。 |
| observe运动守卫违规=0 | 违规0/10局；原≥5cm或≥10°规则保留。所有132次query=null/confidence=0，红蓝raw字段完整且附tick。 |
| 每局observe≤92 | 最大52，map-07 L6375/tick13774，其余7–15。 |
| 每局原生图像≤20MiB | 最大10,776,801/20,971,520 bytes，map-07。 |
| 独立确认且抓到≥80% | 8/9=88.89%，要求至少8个；map-01/03合并S01，只有map-07/S06失败。 |
| 所有局固定规则无fail | 12项规则fail合计0；map-07前9项未达确认/抓取阶段为unknown，后3项pass。 |
| 已抓局固定规则全pass | 9/9已抓局，每局12项全pass；边界数值见后表。 |
| 已成功场景无捕获回归 | regressions=[]、0组；回归终点在delivery_phase_start之前，不包括送达。 |
| map-02确认并抓到 | C、WM最终误差5.4cm；L756确认，L844 approach，L848成功grab；E3在95.02s。 |
| 幻影首次CONFIRMED=0 | 全量WM日志9个首次CONFIRMED target track，幻影0、真值绑定unknown0；不是只数主流程memory_confirmed。 |
| 每局全部视觉证据≤20MiB | 原生图像加补充截图，最大仍为map-07的10,776,801 bytes。 |
| 冻结过滤器测试身份一致 | test完整10图、133次observe、168检测；runtime/evaluator SHA匹配本轮manifest。 |
| 冻结过滤器性能数值 | 红误杀0/40=0%，precision2/2=100%；蓝误杀0/11=0%，precision4/4=100%，满足≤2%/≥95%。**此为已污染测试回放数值。** |

v2 test仍是旧stage-1 round-3同一份168条观测，不是本轮132次observe。红原真/假=40/19，过滤真/假=0/2，保留真/假=40/17；蓝原真/假=11/98，过滤真/假=0/4，保留真/假=11/94。unknown=0、ambiguity=0。红/蓝残余假占比分别17/57=29.82%、94/105=89.52%，假检测存活率17/19=89.47%、94/98=95.92%；小分母precision=100%不表示大量伪检测已消除。v1反馈影响了v2规则选择，[evaluation_record.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/filter-test-v2/evaluation_record.json)明确`test_contaminated_by_post_evaluation_rule_change=true`、`held_out_generalization_claim=false`。首次v1失败保持有效，未被v2覆盖。

| 保留固定约束 | 本轮数值与原始证据 |
|---|---|
| 同track恰好3次命中、40–90cm窗 | 9局各3次；最小42cm/最大87cm均为map-10 L463 hit[2]/hit[0]；WM实际hit增长与preceding observe/association逐条核对见opt_report.actual_WM_hit_audit。 |
| 任意两命中位置≥15cm | 最小15.073486657cm：map-10 L463 hit[0,1]；最大65.292266004cm：map-02 L756 hit[1,2]。 |
| 最后采样WM距离≥0.5m | 最小0.553380336m：map-01 L292；最大0.787448020m：map-04 L277。 |
| 最后observe后纯记忆≥30cm再approach | 最小38.7cm：map-10 L501、最后observe L455；最大392.1cm：map-04 L499、最后observe L269。 |
| approach开始WM距离≤0.25m | 范围0.220–0.221m；最大map-06 L639。 |
| approach max_steps=1，每球≤3次 | 9个已抓局均一次approach，max_steps均为1；grab调用次数另列，不能混为approach次数。 |
| 全程onRoad | 10个平台完整run_finished摘要均off_road episodes=0、durationMs=0、maxSeverity=0，不仅凭稀疏onRoad=true判断。 |

9个已抓球的首见、确认、抓取、道路距离、直线距离、道路/直线比、精确抓取tick真值前/侧向及夹角均无关键数值缺失。首见指同次渲染真值下唯一关联的最早**未封顶**raw，不等价于物理首次可见；确认取最后确认observe tick×0.02，抓取/送达取平台事件t/1000。道路距离为最后确认observe至成功grab的累计里程差，包含精靠近，不同于“approach前纯记忆里程”；只用精确tick或里程相同的静止括区，无运动区间插值。原精度和端点query序号见[opt_report.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/opt_report.json)。5个已抓未送达球的delivered_seconds=null是未送达，不是0秒；map-07没有进入确认/抓取阶段。

**map-04送达退化未恢复。** [旧R3 map-04](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/map-04.json) E3在127.58s抓取guangyang-target-2，E6在201.54s送达，L403成功且holding=null。opt1两轮都在110.50s抓取同球，本轮[map-04](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-04.json) E2抓取、没有package_delivered，L623仍holding=目标物并以“多次重规划后仍无法抵达节点”失败，E3于392.88s结束。Q/C=468/177低于1000/300配额、program_error=0。L600–602仍为central-north progress34.1→22.8→43.5：take_exit40.6cm，follow11.3cm因front_clearance停止且余量0.3cm，node_state20.7cm回路口；同型段重复至L622。该送达退化不属于本阶段capture gate，但必须保留，不能称总体送货稳定。

E/G精度范围：E仅1个布局/1个独立场景（map-09/S08），本轮最终WM误差**10.3cm**，L961确认、E4在122.88s抓取；r1同场景为8.6cm，不能将两轮重复场景计成两个独立泛化样本。G没有合格样本；B/C/D仅报告，不作新位置泛化结论。map-07无WM真球关联，不能强行算入E/G。

| 版本／哈希 | 冻结值 |
|---|---|
| PROGRAM_VERSION，10局L0一致 | `wm-opt1-r2-20260924` |
| 原始冻结program.py SHA256 | `6cc3479d55051161f2c451226bda3a61a578c8fd9f84d020848c902c2c5d35cc` |
| 原生record.sourceCode／执行快照SHA256 | `25590162d87b90c4dcb6c1d9766d7e62a115bfc07f68c709c8a61fb75fd78e34` |
| wm_kit commit | `ad237a143f0d35e100a28c15567d4b75bd56cccf` |
| 嵌入WM ZIP SHA256 | `651a89967b41aad583b70e5f5095c5fc35f6babc950d8ab878748cb69e9f66e3` |
| v2 filter SHA256 | `57ea75300c330bea5b4ecdb7a529cdc802e617a76572c75f4f76fe6d319f7322` |
| 已污染test_evaluation.json SHA256 | `c17418f4361fb58f096d1d7100f3fbc664895774daa2c368839e54cb63895101` |

[executed_program.py](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/executed_program.py)直接从完整原生record.sourceCode导出，169,192 bytes，不补换行；10局字节完全一致，均匹配identity和版本日志四字段。原program.py为169,193 bytes，仅多末尾newline；平台trim解释两种SHA，不替换原文件。逐局原生记录哈希及导出方法见[EXECUTED_SNAPSHOT.md](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/EXECUTED_SNAPSHOT.md)与[JSON审计](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/executed_snapshot_audit.json)。

开跑前[preflight.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/preflight.json)全通过：[tests.txt](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/tests.txt)为**178 passed**；[pylint.txt](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/pylint.txt)指定E1123/E1120/E1121/E0633/E0602零报错，含实际平台AsyncRobotTransformer桥接执行验证。[静态扫描](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/static_coordinates.json)布局坐标对违规0；target锚点死读取没有恢复。[pre_run_review.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/pre_run_review.json)24项全true：与r1相比，嵌入filter外仅版本/声明SHA改变；M5、WM融合、确认、道路规划、approach/grab/delivery及运动守卫未改。直接diff见[round1_to_round2_review.diff](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/round1_to_round2_review.diff)。

批跑结束[freeze_verification.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/freeze_verification.json)22/22一致；对应22份源码也已逐字节归档至[frozen_sources/INDEX.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/frozen_sources/INDEX.json)。v2只在原WM窗口**40≤raw<90cm**内应用原红<.84/蓝<.80的confidence规则，等于边界保留；窗外、封顶、数值无效时弃权保留。40/90是既有合同、.84/.80沿用r1，没有新增拟合阈值。完整开发证据与原轨迹独立性检查见[DEVELOPMENT.md](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/filter-candidate-v2/DEVELOPMENT.md)及[constant_provenance.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/filter-candidate-v2/constant_provenance.json)。

| 规则依据 | 三个独立dev相关类别轨迹中的支持行：raw cm／°／confidence |
|---|---|
| 窗内红过滤，原floor .84 | [calib_v6 attempt-02](/Users/ken/Desktop/wm_bench/artifacts/inloop/calib_runs_v6/attempt-02.json) L91：87／.55／.81；[attempt-08](/Users/ken/Desktop/wm_bench/artifacts/inloop/calib_runs_v6/attempt-08.json) L77：43／−34.25／.83；[v28r1 map-09](/Users/ken/Desktop/wm_bench/artifacts/inloop/v28r1_batch/map-09.json) L87：67／−13.13／.81。 |
| 窗内蓝过滤，原floor .80 | [calib_v6 attempt-03](/Users/ken/Desktop/wm_bench/artifacts/inloop/calib_runs_v6/attempt-03.json) L3：82／−2.62／.79；[attempt-05](/Users/ken/Desktop/wm_bench/artifacts/inloop/calib_runs_v6/attempt-05.json) L56：58／25.24／.74；[attempt-08](/Users/ken/Desktop/wm_bench/artifacts/inloop/calib_runs_v6/attempt-08.json) L37：73／20.33／.76。 |

窗外真实红/蓝各三完整独立轨迹也在开发文档列出。它们说明窗外保留的依据，不消除test污染；dev原本无已标真误杀，也不能声称v2改善了dev误杀率。dev过滤unknown共10条（红1/蓝9），不宣称这些全是假检测。本轮只记录已完成结果与存证，不进行额外仿真或事后调参。

逐局原始证据索引如下。每局program_version均在L0；完整最后observe、首次WM CONFIRMED和逐球里程端点见数字审计。

| 原始局 | 首次WM CONFIRMED L／主流程确认L | approach L | grab_step L（末次成功） | 抓取E／送达E | flow_end L／run_finished E |
|---|---|---|---|---|---|
| [map-01](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-01.json) | 288／292 | 300 | 302,303,304 | 3／无 | 328／4 |
| [map-02](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-02.json) | 752／756 | 844 | 846,847,848 | 3／5 | 868／6 |
| [map-03](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-03.json) | 288／292 | 300 | 302,303,304 | 3／5 | 322／6 |
| [map-04](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-04.json) | 273／277 | 499 | 501,502 | 2／无 | 623／3 |
| [map-05](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-05.json) | 315／319 | 519 | 521,522 | 2／4 | 542／5 |
| [map-06](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-06.json) | 526／530 | 639 | 641,642 | 3／无 | 762／6 |
| [map-07](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-07.json) | 无／无 | 无 | 无 | 无／无 | 6378／1 |
| [map-08](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-08.json) | 315／319 | 486 | 488,489 | 2／4 | 509／5 |
| [map-09](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-09.json) | 957／961 | 1108 | 1110,1111,1112,1113 | 4／无 | 1236／5 |
| [map-10](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-10.json) | 459／463 | 501 | 503,504 | 2／无 | 624／3 |
