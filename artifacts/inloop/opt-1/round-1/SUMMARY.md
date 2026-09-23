# opt-1 round-1：FAIL（捕获门通过，冻结过滤器测试失败）

判定：**FAIL**。确认且抓到 9/10 布局；合并重复目标轨迹后为 **8/9 个独立场景（88.89%，要求至少8个）**。本阶段捕获回归0组；仅过滤器测试门失败，其中红/蓝误杀率与precision四个子门全失败。实际送达4/10，map-04送达从旧R3成功退化为本轮失败，详见后面的单列证据。捕获门通过不表示全流程无回归。

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
| frozen_filter_test_metrics_pass | FAIL |

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
| map-09 | E/未见过 | True | 8.6 | 3 | 16.8/4.3 | 0/13 | {"event": "flow_end", "success": false, "stage": "constraint", "reason": "多次重规划后仍无法抵达节点", "one_target_released": false, "navigation_queries": 484, "navigation_controls": 179, "full_targetDelivered": false, "holding": "目标物"} |
| map-10 | D/已标定 | True | 3.7 | 2 | 13.4/3.2 | 0/13 | {"event": "flow_end", "success": false, "stage": "constraint", "reason": "多次重规划后仍无法抵达节点", "one_target_released": false, "navigation_queries": 383, "navigation_controls": 151, "full_targetDelivered": false, "holding": "目标物"} |

| 布局 | observe | 原生图像bytes | 全部图像bytes | program_error |
|---|---|---|---|---|
| map-01 | 7 | 2163861 | 2337650 | 0 |
| map-02 | 7 | 2323411 | 2671215 | 0 |
| map-03 | 7 | 2209376 | 2557465 | 0 |
| map-04 | 8 | 2483239 | 2657243 | 0 |
| map-05 | 9 | 2842179 | 3189977 | 0 |
| map-06 | 10 | 3043809 | 3217734 | 0 |
| map-07 | 52 | 10781831 | 10781831 | 0 |
| map-08 | 9 | 2847584 | 3195485 | 0 |
| map-09 | 14 | 3803067 | 3977016 | 0 |
| map-10 | 8 | 2428312 | 2602353 | 0 |

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
| map-01/guangyang-target-2 | 13.5→42.92→52.14→None | 59.5/48.71075787657443；1.2214960841045392 | 11.441710023297091/1.2054196467679519；-40.2 | 7；2337650 |
| map-02/guangyang-target-1 | 35.7→65.16→95.02→128.98 | 186.8/63.09658759875432；2.9605404524869727 | 11.12767389914409/-3.638502579478267；121.6 | 7；2671215 |
| map-03/guangyang-target-2 | 13.5→42.92→52.14→85.04 | 59.5/48.71075787657443；1.2214960841045392 | 11.441710023297091/1.2054196467679519；-40.2 | 7；2557465 |
| map-04/guangyang-target-2 | 34.36→52.96→110.5→None | 398.79999999999995/93.60394098520656；4.260504374094969 | 13.32924345481743/-1.8983448900919155；164.4 | 8；2657243 |
| map-05/guangyang-target-1 | 34.36→56.92→96.26→130.22 | 270.9/60.4921056806799；4.47827029579697 | 13.45472807353618/-1.6100412498628507；103.3 | 9；3189977 |
| map-06/guangyang-target-2 | 38.34→58.4→76.24→None | 129.3/71.70158209458491；1.8033074894977121 | 11.822737339374896/-4.736757967012536；116.6 | 10；3217734 |
| map-07/未抓到 | 首次确认 None；其余见原始轨迹 | 未到抓取，未知 | 未抓取，未知 | 见布局审计 |
| map-08/guangyang-target-1 | 34.36→56.92→88.94→122.88 | 221.20000000000005/60.44587473397491；3.659472229883536 | 13.167799290067798/-1.5167037803313224；102.7 | 9；3195485 |
| map-09/guangyang-target-2 | 69.06→89.28→117.58→None | 174.80000000000007/71.24480947468302；2.4535120704072564 | 16.77111164348505/4.273038519752811；-43.5 | 14；3977016 |
| map-10/guangyang-target-1 | 41.28→48.94→56.34→None | 48.099999999999966/41.63230630267843；1.1553527601930003 | 13.387891226283458/3.193778761355183；13.9 | 8；2602353 |

None 为未到达或证据未知，不能视为零。原始行、事件索引、里程边界与精确tick证据见 opt_report.json。定位测试结论仅E/G；其余球位只报告。分组方法/容差与旧stage-1一致。

| 未见位置 | 关联布局样本数 | 独立场景样本数 | 最终误差cm（逐样本） |
|---|---|---|---|
| E | 1 | 1 | [{"map": "map-09", "final_error_cm": 8.6}] |
| G | 0 | 0 | [] |

回归证据：

```json
[]
```

本页以下 **L 是原始 JSON `lines` 的零起始下标，E 是 `record.events` 的零起始下标**，均不是物理文件行号。[numbers_audit.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/numbers_audit.json) 保存完整逐局索引、固定规则证据、精确事件和数值。[audit_numbers.py](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/audit_numbers.py) 可离线复算，只读现有证据，不启动仿真或测试；一致性检查全部通过。

| 验收门 | 具体数值与证据 |
|---|---|
| 十布局各一局 | [progress.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/progress.json)：10 executed，各图恰一次；44次重复分配在执行前跳过，unknown执行0。 |
| program_error=0 | 10局完整平台events中合计0，10/10有run_finished；正常flow_end=false单列，不能误计程序异常。 |
| 原地重复observe=0 | 实际observe合计131，重复0；逐次L索引及原报告证据在numbers_audit。 |
| observe运动守卫违规=0 | 违规0/10局；原≥5cm或≥10°守卫未改。所有131次都以query=null、confidence=0获取原始结果；每条红蓝raw均含类别、距离、方位、confidence，且有tick。 |
| 每局observe≤92 | 最大52（map-07 L6375，tick13774），其余7–14。 |
| 每局原生图像≤20MiB | 最大10,781,831/20,971,520 bytes（map-07）；每局见前表。 |
| 独立确认且抓到≥80% | 8/9=88.89%，需至少8个；S01=(01,03)，S02–S09分别=(02,04,05,06,07,08,09,10)，仅07失败。 |
| 所有局固定规则无fail | 12项规则fail合计0；map-07前9项未进入确认/抓取阶段为unknown，后3项pass。 |
| 已抓局固定规则全pass | 9/9已抓局，每局12项全pass；具体边界数值见下表。 |
| 已成功场景无捕获回归 | regressions=[]，0组；比较截于delivery_phase_start前，不是送达回归检查。 |
| map-02确认并抓取 | C，最终WM误差5.4cm；L756三命中，L844 approach，L848抓到；E3 t=95.02s。 |
| 幻影首次CONFIRMED=0 | 全量WM日志有9个首次CONFIRMED target track，幻影0、无法绑定真值0；不是只数memory_confirmed。首次WM行及精确图像/真值绑定见数字审计和opt_report.per_ball_diagnostics。 |
| 每局全部视觉证据≤20MiB | 原生图像+补充截图最大仍是map-07的10,781,831 bytes。 |
| 冻结过滤器测试身份一致 | test完整10图、133次observe、168条红蓝检测；runtime/evaluator SHA均匹配本轮manifest。见[独立复核](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/filter-test-v1/independent_review.json)。 |
| 冻结过滤器性能 | **FAIL**：红误杀1/40=2.50%>2%，precision10/11=90.91%<95%；蓝误杀2/11=18.18%>2%，precision10/12=83.33%<95%。 |

过滤test使用封存的stage-1 round-3观测，不是本轮新轨迹。168条标签unknown=0、ambiguity=0；红保留真/假=39/9、蓝=9/88，残余假占比分别18.75%、90.72%。三条误杀为旧R3 map-04 L1/raw[1]（29cm，−0.14°，conf .79，蓝）、map-09 L24/raw[2]（100cm，36.62°，.77，蓝）、map-10 L62/raw[1]（100cm，2.48°，.83，红）。窗外/封顶检测不从过滤器分母删除；封顶值机械标签也不授权运行时距离定位。逐条PNG、真值、极端自检见[首次过滤器测试报告](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/filter-test-v1/TEST_REPORT.md)。

| 固定约束 | 数值及原始行 |
|---|---|
| 同track恰好3次命中，40–90cm窗 | 9局各3次；最小42/最大87cm均为map-10 L463的hit[2]/hit[0]。实际WM hit增长亦已逐条对照preceding observe/association，见opt_report.actual_WM_hit_audit。 |
| 所有两两命中间距≥15cm | 最小15.073486657cm：map-10 L463 hit[0,1]；最大65.292266004cm：map-02 L756 hit[1,2]。 |
| 最后采样WM距离≥0.5m | 最小0.553380336m：map-01 L292；最大0.787448020m：map-04 L277。 |
| 最后observe后纯记忆≥30cm再approach | 最小38.7cm：map-10 L502，最后observe L455；最大392.1cm：map-04 L499，最后observe L269。 |
| approach开始WM距离≤0.25m | 9局范围0.220–0.221m；最大map-06 L639。 |
| max_steps=1且每球approach≤3次 | 9局均一次approach、max_steps=1；具体L见下表。 |
| 全程onRoad | 10个平台完整run_finished对应off_road episodes=0、durationMs=0、maxSeverity=0；不只依赖稀疏onRoad=true。 |

| 原始局 | 确认L | approach L | grab_step L（末次成功） | 抓取E | 送达E | flow_end L／run_finished E |
|---|---|---|---|---|---|---|
| [map-01](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/map-01.json) | 292 | 300 | 302,303,304 | 3 | 无 | 328／4 |
| [map-02](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/map-02.json) | 756 | 844 | 846,847,848 | 3 | 5 | 868／6 |
| [map-03](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/map-03.json) | 292 | 300 | 302,303,304 | 3 | 5 | 322／6 |
| [map-04](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/map-04.json) | 277 | 499 | 501,502 | 2 | 无 | 623／3 |
| [map-05](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/map-05.json) | 319 | 519 | 521,522 | 2 | 4 | 542／5 |
| [map-06](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/map-06.json) | 530 | 639 | 641,642 | 3 | 无 | 762／6 |
| [map-07](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/map-07.json) | 无 | 无 | 无 | 无 | 无 | 6378／1 |
| [map-08](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/map-08.json) | 319 | 486 | 488,489 | 2 | 4 | 509／5 |
| [map-09](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/map-09.json) | 876 | 1029 | 1031,1032,1033 | 3 | 无 | 1156／4 |
| [map-10](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/map-10.json) | 463 | 502 | 504,505 | 2 | 无 | 625／3 |

map-07 L6375最后observe为raw=[]，L6378因未通过确认结束，没有确认/抓取。不能以0误差代替缺失指标，也不能将空raw解读为“检测在窗外”。mission是平台全部任务累计计数，不能替代目标送达计数。

单球指标完整性：9个已抓球的首见、确认、抓取、道路距离、直线距离、道路/直线比、精确抓取tick真值前/侧向及夹角均非缺失。首见指同次渲染真值下唯一关联的最早**未封顶**raw，不等价于物理上首次可见；确认秒数为最后确认observe tick×0.02，抓取/送达取平台事件t/1000。道路距离是最后确认observe到成功grab的累计里程差，包含精靠近，不同于“approach前纯记忆里程”；边界只用精确tick或累计里程完全相同的静止括区，未对移动区间插值。原精度和每个边界query序号见[opt_report.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/opt_report.json)。5个已抓未送达球的delivered_seconds=null是实际未送达，不是0秒。

**map-04送达退化单列，捕获仍通过。** [旧R3原始局](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/map-04.json) E3于127.58s抓取guangyang-target-2，E6于201.54s送达，L403 flow_end.success=true、holding=null。本轮E2于110.50s抓取同球，比旧版早17.08s；但无package_delivered，L623结束时仍holding=目标物，flow_end.success=false，原因“多次重规划后仍无法抵达节点”，E3于392.88s结束。导航查询/控制=468/177，低于1000/300配额，program_error=0。

本轮map-04 L600–L622显示送达阶段重复：central-north take_exit移动40.6cm至progress34.1；cross_road仅移11.3cm，在progress22.8因front_clearance停止、余量0.3cm；node_state再移20.7cm回progress43.5。相同三事件见L603–605、606–608、609–611、612–614、615–617、618–620，L621–622再次进入循环。这是送达路由反复的直接证据；本轮“capture回归0”不能掩盖送达退化。此处只报告，不更改冻结程序。

定位测试只取E/G：E有1局/1独立场景，map-09/S08最终WM误差8.6cm，L876确认且E3抓取；G无合格样本，不能给精度结论。B/C/D的本轮成功仅报告，不作新位置泛化结论；map-07没有WM真球关联，不擅自计入E/G。

| 版本／哈希 | 冻结值 |
|---|---|
| PROGRAM_VERSION（10局L0一致） | `wm-opt1-r1-20260923` |
| 原始源文件／冻结program.py SHA256 | `a6527ca62bcbd643ca0a16842409834269ac292815a947ea9af25ae6404a28cd` |
| 平台trim后文本SHA256（L0.file_sha256） | `7aa429495b06a6696abcc2f74f32266610fd46c06ed21c0b4c44f10822ec2c02` |
| wm_kit commit | `ad237a143f0d35e100a28c15567d4b75bd56cccf` |
| 嵌入WM ZIP SHA256 | `651a89967b41aad583b70e5f5095c5fc35f6babc950d8ab878748cb69e9f66e3` |
| Runtime filter SHA256 | `fe953d2e4f63db981e5eea33ff95dbedf524ed8f9a965046c12b830479c43659` |
| 原R3程序SHA256 | `414b941ebc4c24fcf70a9384de90abc50c7e677e9f79103dc84b0861d567a69a` |
| 首次test_evaluation.json SHA256 | `80e899c213ca7dcb9a1ac797fb99e4ca8e3b1c4f966edd3b6675ccd8fb105b38` |

平台执行前trim文本，所以原文件SHA与日志file_sha256分别记录。开跑前[preflight.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/preflight.json)全通过：[指定pylint](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/pylint.txt) E1123/E1120/E1121/E0633/E0602零报错；[测试记录](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/tests.txt)为175 passed。实际平台AsyncRobotTransformer的顶层filter调用桥接执行测试包含在其中。M5函数、WM更新、确认核心及嵌入ZIP与R3一致；target锚点死读取已删除，mission对象读取在obstacle/distractor类别守卫后。

[坐标扫描](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/static_coordinates.json)检查791个数值字面量和14个嵌入Python文件，布局坐标对违规0；[独立review](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/review.json)26项一致性检查全通过。批跑结束[freeze_verification.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/freeze_verification.json)为22/22一致。为避免round-2修改共享文件影响复现，本轮22份旧源码均已逐字节归档，[frozen_sources/INDEX.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/frozen_sources/INDEX.json)给出原路径、归档路径和SHA，数字审计确认全部匹配本轮manifest；不将以后共享路径变化混同批跑期间修改。

规划没有新增经验阈值：局部障碍边界和frontier重复修复复用已有5cm/15cm规则，旧日志因果及15项针对性回归见[planner_change.md](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/planner_change.md)。新增红/蓝confidence阈值分别为0.84/0.80，严格小于才拒绝，等于保留；取自dev已标真检测的最低confidence。开发数据仅原始calib+v28r1，每类三个完整相关类别轨迹在既有容差下两两不等价，并非同一轨迹的三个孤立帧。完整证据见[DEVELOPMENT.md](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/filter-candidate-v1/DEVELOPMENT.md)及[constant_provenance.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/filter-candidate-v1/constant_provenance.json)。

| 新阈值 | 三个独立dev轨迹中的支持行：raw距离cm／方位°／confidence |
|---|---|
| 红confidence<0.84 | [calib_v6 attempt-02](/Users/ken/Desktop/wm_bench/artifacts/inloop/calib_runs_v6/attempt-02.json) L91：87／0.55／.81；[attempt-08](/Users/ken/Desktop/wm_bench/artifacts/inloop/calib_runs_v6/attempt-08.json) L77：43／−34.25／.83；[v28r1 map-09](/Users/ken/Desktop/wm_bench/artifacts/inloop/v28r1_batch/map-09.json) L87：67／−13.13／.81。 |
| 蓝confidence<0.80 | [calib try-1](/Users/ken/Desktop/wm_bench/artifacts/inloop/calib_runs/try-1.json) L17：32／−13.53／.77；[calib_v6 attempt-08](/Users/ken/Desktop/wm_bench/artifacts/inloop/calib_runs_v6/attempt-08.json) L20：34／16.10／.79；[attempt-05](/Users/ken/Desktop/wm_bench/artifacts/inloop/calib_runs_v6/attempt-05.json) L56：58／25.24／.74。 |

以上只是阈值开发依据，不是泛化通过证明；首次封存test失败按原样保留。本次只新增离线数字审计、源码归档和本页补充，不改变本轮raw、程序、过滤器、评测源码、原评测结果或门限。
