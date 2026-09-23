# opt-1 round-2 原始证据独立审计

证据完整性：PASS。10 局完整且身份一致；独立确认并抓取为 8/9，map-02 成功，phantom CONFIRMED=0。本轮冻结的15项数值门通过；过滤测试已受v1反馈污染，不能作为独立泛化通过。数值通过不等于全任务或双球送达成功。

详见 [evidence_audit.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/evidence_audit.json)。本次只读原始记录，没有仿真、代码改动或原始数据改动。

| 布局 | observe | samples | 原生PNG/字节 | 事件图/字节 | 全部图像字节 |
|---|---:|---:|---:|---:|---:|
| map-01 | 7 | 989 | 9/2164975 | 1/173800 | 2338775 |
| map-02 | 7 | 1368 | 9/2321004 | 2/347846 | 2668850 |
| map-03 | 7 | 927 | 9/2211044 | 2/348197 | 2559241 |
| map-04 | 8 | 4066 | 10/2483356 | 1/173976 | 2657332 |
| map-05 | 9 | 1372 | 11/2844512 | 2/347843 | 3192355 |
| map-06 | 10 | 3723 | 12/3043867 | 1/173900 | 3217767 |
| map-07 | 52 | 2915 | 52/10776801 | 0/0 | 10776801 |
| map-08 | 9 | 1295 | 11/2847220 | 2/347921 | 3195141 |
| map-09 | 15 | 3958 | 17/4034377 | 1/173877 | 4208254 |
| map-10 | 8 | 3513 | 10/2437501 | 1/174049 | 2611550 |

全部原生 PNG 与完整 record 的 visionFrames.pngBase64 解码字节相同，原生 SHA256/byteLength 一致；observe raw 顺序与 query 相同。runId、frameId、evidenceId、capture/evidence/frame/query/log tick、stateRevision 精确绑定。完整 record events/samples 与导出完全相同。每局全部图像总和 ≤20 MiB。

## map-04 历史送达退化仍未解决

历史 stage-1 round-3 已释放一球（flow_end.success=true、one_target_released=true）。本轮 tick5525（110.50s）抓到 C 球，但结束 tick19644（392.88s）仍持 guangyang-target-2，没有送达事件，最终 constraint：“多次重规划后仍无法抵达节点”。

central-north 共 38 次到达 progress22.8cm、frontClearance0.3cm 并停止。末段反复：前进20.7cm到junction（progress43.5）→take_exit40.6cm回到progress34.1→前进11.3cm停到progress22.8、净空0.3cm。循环首末原始行与全部次数保存在JSON。capture门的 regressions=[] 不能描述为“送达无退化”。

## 每球里程与抓取几何

“路线里程”沿用现报告的公开 odometry 累计差，包含道路导航、直行及 approach 等平移，并非只道路控制的里程。另列 follow_road/take_exit 的原生 result.distanceCm 绝对值累计，以 confirmation_tick < 控制结果tick ≤ grab_tick 为范围；原始 input seq 在JSON。直线为确认帧机器人中心至抓取tick机器人中心位移。

| 布局/球 | 确认→抓取tick | 总里程/道路控制/直线cm | 总里程÷直线 / 道路控制÷直线 | 抓取前/右cm | 最后命中视线夹角° | 送达 |
|---|---|---:|---:|---:|---:|---|
| map-01/guangyang-target-2 | 2146→2607 | 59.500/40.600/48.711 | 1.2215 / 0.8335 | 11.442/+1.205 | -40.2 | 否 |
| map-02/guangyang-target-1 | 3258→4751 | 186.800/160.300/63.097 | 2.9605 / 2.5405 | 11.128/-3.639 | 121.6 | 是 |
| map-03/guangyang-target-2 | 2146→2607 | 59.500/40.600/48.711 | 1.2215 / 0.8335 | 11.442/+1.205 | -40.2 | 是 |
| map-04/guangyang-target-2 | 2648→5525 | 398.800/353.300/93.604 | 4.2605 / 3.7744 | 13.329/-1.898 | 164.4 | 否 |
| map-05/guangyang-target-1 | 2846→4813 | 270.900/257.900/60.492 | 4.4783 / 4.2634 | 13.455/-1.610 | 103.3 | 是 |
| map-06/guangyang-target-2 | 2920→3812 | 129.300/122.600/71.702 | 1.8033 / 1.7099 | 11.823/-4.737 | 116.6 | 否 |
| map-08/guangyang-target-1 | 2846→4447 | 221.200/207.900/60.446 | 3.6595 / 3.4394 | 13.168/-1.517 | 102.7 | 是 |
| map-09/guangyang-target-2 | 4489→6144 | 206.500/168.400/73.818 | 2.7974 / 2.2813 | 13.082/+3.901 | -45.8 | 否 |
| map-10/guangyang-target-1 | 2447→2806 | 48.100/40.000/41.484 | 1.1595 / 0.9642 | 13.531/+2.101 | 17.0 | 否 |

map-07 未抓取，相关几何为未知，不能填0。全部9个抓球结果均重新核算，覆盖 map-02/04/09 等至少3个独立场景。抓取使用同tick且抓取input前的sample；该tick的前后位姿相同，没有近邻tick替代。sample的x/z为6位小数、heading为4位小数，“精确”指事件时刻绑定。

视线夹角由最后 memory_hit 的 M5 world−pose 与 approach前航向独立重算，差异<0.15°（日志舍入）。该值不同于最终抓取真球方位；JSON另列最终真方位。

## 原图与冻结抽查

- [map-02 抓取后主视图](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/attempts/attempt-009.demo/event-001264-package_grabbed-tick-4755.png) 已实际查看：正常场景，非空白。事件tick4751，拍摄tick4755，延后4tick；不是事件同刻PNG。全景包裹像素较小，抓取判定以原生accepted事件和holding支持。
- [map-04 抓取后主视图](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/attempts/attempt-005.demo/event-001467-package_grabbed-tick-5526.png) 已实际查看：正常场景，非空白。事件tick5525，拍摄tick5526，延后1tick；不是事件同刻PNG。全景包裹像素较小，抓取判定以原生accepted事件和holding支持。
- [map-09 抓取后主视图](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/attempts/attempt-003.demo/event-001637-package_grabbed-tick-6147.png) 已实际查看：正常场景，非空白。事件tick6144，拍摄tick6147，延后3tick；不是事件同刻PNG。全景包裹像素较小，抓取判定以原生accepted事件和holding支持。

批结束原 freeze_verification.json 的22项均true，冻结副本逐项SHA核对；当前源文件哈希核对结果另列JSON，不改写历史清单。十局sourceCode都等于本轮program.py平台strip形式，四项版本字段一致。

旧stage-1分组保持不变，map-01/03仍为一个独立场景。WM测试精度仅E/G有效关联；其他位置不推导泛化结论。本轮4个目标包裹送达（另5个已抓未送达、map07未抓），并未完成全任务。

## 15项门限独立复算

从 raw/完整record 重建观察重复、WM实际hit递增、三点所有距离、接近调用和整局off-road；从同帧真值关联与原生抓取事件重算9布局成功、冻结9组中的8组成功。map-07未到确认，固定规则记unknown，不冒充通过。实际WM hit、接近与观察原始行均在JSON。

| 门限 | 独立复算 |
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

与 opt_report 的15项布尔结果逐项相同。无program_error、无重复observe、无observe guard违规；没有相对r1的抓取回退。送达仅 map-02、map-03、map-05、map-08，其余6局未送达；这些送达结果并未被8/9抓取门隐藏。

冻结归档INDEX按当前 schema+files 字典逐项读取原路径、archive相对路径与sha256（审计兼容早先列表格式），22项无缺失、重复或哈希不符。v2评测引用的文件哈希、规则SHA及评测器SHA均与本轮一致；污染声明显式为true，held_out_generalization_claim=false。其数值为红0/40误杀、2/2precision；蓝0/11误杀、4/4precision。这是受反馈影响的回放数值通过，不是新未见数据的泛化通过。

仅E有效关联map-09进入WM测试精度，最终误差10.3cm（1个独立场景）；G无有效关联样本，不能报告G精度通过。

固定规则边界复核：确认采样点最小间距15.0735cm；接近前纯记忆前进最小38.7cm；approach入口WM距离最大22.1cm。9个已确认抓球各只调用一次approach(max_steps=1)。归档INDEX中的source_manifest_sha256也与22项清单一致。
