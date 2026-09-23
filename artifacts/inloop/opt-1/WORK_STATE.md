# 当前执行检查点（批跑中，不是最终验收）

用户v3任务按阶段0→opt1→opt2→opt3执行；opt4开始前须用户确认。每优化阶段最多三轮，每轮完整十图且不重复；未通过不能进下一阶段，旧stage1三轮不占新opt1配额。赛题1不得提前运行。

## 已完成

- Stage0 demo PASS map05，440.6秒，27 observe，两个不同package_delivered，两球固定规则全通过；尝试03/04失败后05成功即停止，未运行08或其余demo布局。
- 正式一页交付 ../demo/DEMO.md，冻结program SHA58a24a2d...c7928、wm-demo-v1-20260923，独立4关键帧审计完整。tools/reproduce_demo.py --plan-only也验证通过。
- opt1单球程序 programs/world_model_opt1.py，版本wm-opt1-r1-20260923，raw SHA a6527ca62bcbd643ca0a16842409834269ac292815a947ea9af25ae6404a28cd；平台trim SHA见round-1/identity.json。
- wm_kit /Users/ken/wm_kit 提交ad237a143f0d35e100a28c15567d4b75bd56cccf；ZIP651a89967b41aad583b70e5f5095c5fc35f6babc950d8ab878748cb69e9f66e3不变。
- 规划修复见planner_change.md：局部停止边界保留同侧退路、gateway命名端点与已测landing去重、删target anchor死读取。测距/确认/WM/抓取AST不变。
- 过滤器独立programs/detection_filter.py，red>=.84/blue>=.80；顶层detection_filter_update适配平台AsyncRobotTransformer，类update仅offline接口。SHAfe953d2e4f63db981e5eea33ff95dbedf524ed8f9a965046c12b830479c43659。
- 原始observe仍query(None,0)全raw先打印，独立filter决策后再旧confidence/category门；对象身份不变。
- dev标定+v28r1 1153条，756精确可标/397unknown；baseline0reject/precision undefined。已标dev新filter红0/121误杀11/11precision，蓝0/111与68/68，unknown过滤17/29另列。三独立场景阈值依据与独立review在filter-candidate-v1和filter-development。
- 首次freeze于2026-09-23 13:33:37 UTC，后才读stage1r3 test。完整133帧168条；red误杀1/40=2.5%，precision10/11=90.91%；blue2/11=18.18%，10/12=83.33%，四门FAIL。后续改规则必须标test已污染。完整TEST_REPORT及独立核验在filter-test-v1。
- 三误杀：map04 line1/det1 tick0蓝29cm/-0.14/.79；map09 line24/det2 tick3453蓝100/36.62/.77；map10 line62/det1 tick1798红100/2.48/.83。不能因窗外/封顶删评测分母。
- preflight175 tests pass、指定pylint0、actual async bridge执行通过、坐标扫描通过。round-1/review.json 26checks全true，22冻结文件匹配。

## 当前运行（2026-09-24 local）

r1 已完整十图完成，PTY25734结束、freeze_verification全true。opt_report.json数值：capture8/9独立场景，map02通过，phantom0/errors0/stationary0/budgets/fixedrules通过，filter四指标FAIL。map04送达从旧R3成功退化为失败，单列保留；本轮不得通过。源文件22项已逐字节保存在round-1/frozen_sources/INDEX.json。

v2过滤器已冻结，只在40≤raw<90应用原.84/.80，不改planner/M5/confirmation/WM。filterSHA57ea75300c330bea5b4ecdb7a529cdc802e617a76572c75f4f76fe6d319f7322；dev证据/provenance见filter-candidate-v2。后续test已污染（v1反馈影响选型），不得作heldout结论。v2在原168检测133帧全保留标签/分母的回放：red误杀0/40、precision2/2，blue0/11、4/4；数值PASS但样本很少且残余伪多。freeze/evaluation_record/CONTAMINATION.md见filter-test-v2。

r2程序 wm-opt1-r2-20260924，source SHA6cc3479d55051161f2c451226bda3a61a578c8fd9f84d020848c902c2c5d35cc；178 tests PASS、pylint0、全部preflight通过。
**正在运行 PTY54627**：python3 -u tools/run_opt_batch.py --program programs/world_model_opt1.py --out artifacts/inloop/opt-1/round-2，输出round-2/runner.out。完整十图一次，code_manifest各文件批跑中不得修改。进度看round-2/progress.json，不得重跑executed。
截至 2026-09-23 15:09 UTC：r2 completed 05/01/09/04/02/06/03，active attempt013 map07（约48observe，尚无memory_confirmed）；08/10待执行。05/02/03已送达；01抓取成功送货姿态失败；09/04/06抓取成功但节点重规划耗尽。不要据中途结果下阶段结论。r2源码22项已逐字节保存 frozen_sources/INDEX.json；CHANGES.md 已写。所有共享程序/tools仍冻结。
Agents 当前全部待命，审计产物已完成：
- audit_confirmation：r1 SUMMARY/numbers_audit.json 98项true；r2 pre_run_review.json 24项true，只有version/filter范围变。
- audit_batch：r1 evidence_audit.md/json 全raw/query/native/fullrecord绑定，另列道路控制里程；v2dev INDEPENDENT_DEV_REVIEW 与 v2test TEST_REPORT/independent_review（168全评测、162保留、6过滤；红2拒都map07，蓝3拒同pose/raw不可宣称独立泛化）。
- audit_wm：opt1 runtime_filter_audit.md/json +reproduce脚本，r1全十+r2已完成01/05的147observe、178raw红蓝无遗漏，100cm只方位、窗外不进WM，无target锚点或查表。

## 批跑结束后的工作

1. 等r2完整10局、session正常退出和freeze_verification全true，再汇总：tools/opt_report.py ROUND --previous artifacts/inloop/opt-1/round-1 --filter-report artifacts/inloop/opt-1/filter-test-v2/test_evaluation.json。该工具只适用opt1单球，使用原stage_report分组/容差，回归按上一轮成功组的全部成员。
2. tools/batch_report.py、wm_hit_audit.py可生成通用表/真实WM增量。opt_report含首次seen→confirmed→grab→delivered、道路累计odom差/精确直线、抓取真值、phantom首次CONFIRMED精确truth绑定、E/G样本；完整度未知不得冒充pass。
3. 初次过滤测试已失败，round1不能通过。全10结束后才开发round2修复/更新版本；保留r1源码/报告/所有失败。任何新阈值必须≥3独立开发场景数值依据。再改filter明确污染，不能假装新的干净测试。最多3轮，仍未过立即停止并阶段总报告。
4. 抓取门回归与送达退化分开显式报告，后者不能隐瞒；固定规则不放宽。
5. 每轮CHANGES/SUMMARY、layout/scenario表、PROGRAM_VERSION与源/ZIP/wm commit齐全。opt1通过才能opt2双球/标定/送货优化；此时还未开始它们。

agent状态以实时工具为准。可followup分工，禁止在当前批跑中改代码。

工具文件新建未被git管理（workspace本身非git）；/Users/ken/wm_kit tracked clean，原先untracked文件不能清理。旧demo/old stage1文件没有改。语音屏幕工具不可用。持续工作中文简洁进度，等待不超过60秒，不在完成授权工作前结束。
