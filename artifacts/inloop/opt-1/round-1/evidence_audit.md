# opt-1 round-1 原始证据独立审计

证据完整性：PASS。10 局完整且身份一致；独立确认并抓取为 8/9，map-02 成功，phantom CONFIRMED=0。opt-1 总验收仍为 FAIL：冻结过滤器测试未通过。证据完整不等于任务或过滤器成功。

详见 [evidence_audit.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/evidence_audit.json)。本次只读原始记录，没有仿真、代码改动或原始数据改动。

| 布局 | observe | samples | 原生PNG/字节 | 事件图/字节 | 全部图像字节 |
|---|---:|---:|---:|---:|---:|
| map-01 | 7 | 989 | 9/2163861 | 1/173789 | 2337650 |
| map-02 | 7 | 1368 | 9/2323411 | 2/347804 | 2671215 |
| map-03 | 7 | 927 | 9/2209376 | 2/348089 | 2557465 |
| map-04 | 8 | 4066 | 10/2483239 | 1/174004 | 2657243 |
| map-05 | 9 | 1372 | 11/2842179 | 2/347798 | 3189977 |
| map-06 | 10 | 3723 | 12/3043809 | 1/173925 | 3217734 |
| map-07 | 52 | 2915 | 52/10781831 | 0/0 | 10781831 |
| map-08 | 9 | 1295 | 11/2847584 | 2/347901 | 3195485 |
| map-09 | 14 | 3902 | 16/3803067 | 1/173949 | 3977016 |
| map-10 | 8 | 3518 | 10/2428312 | 1/174041 | 2602353 |

全部原生 PNG 与完整 record 的 visionFrames.pngBase64 解码字节相同，原生 SHA256/byteLength 一致；observe raw 顺序与 query 相同。runId、frameId、evidenceId、capture/evidence/frame/query/log tick、stateRevision 精确绑定。完整 record events/samples 与导出完全相同。每局全部图像总和 ≤20 MiB。

## map-04 送达退化

上一轮 stage-1 round-3 已释放一球（flow_end.success=true、one_target_released=true）。本轮 tick5525（110.50s）抓到 C 球，但结束 tick19644（392.88s）仍持 guangyang-target-2，没有送达事件，最终 constraint：“多次重规划后仍无法抵达节点”。

central-north 共 38 次到达 progress22.8cm、frontClearance0.3cm 并停止。末段反复：前进20.7cm到junction（progress43.5）→take_exit40.6cm回到progress34.1→前进11.3cm停到progress22.8、净空0.3cm。循环首末原始行与全部次数保存在JSON。capture门的 regressions=[] 不能描述为“送达无退化”。

## 每球里程与抓取几何

“路线里程”沿用现报告的公开 odometry 累计差，包含道路导航、直行及 approach 等平移，并非只道路控制的里程。另列 follow_road/take_exit 的原生 result.distanceCm 绝对值累计，以 confirmation_tick < 控制结果tick ≤ grab_tick 为范围；原始 input seq 在JSON。直线为确认帧机器人中心至抓取tick机器人中心位移。

| 布局/球 | 确认→抓取tick | 总里程/道路控制/直线cm | 总里程÷直线 | 抓取前/右cm | 最后命中视线夹角° | 送达 |
|---|---|---:|---:|---:|---:|---|
| map-01/guangyang-target-2 | 2146→2607 | 59.500/40.600/48.711 | 1.2215 | 11.442/+1.205 | -40.2 | 否 |
| map-02/guangyang-target-1 | 3258→4751 | 186.800/160.300/63.097 | 2.9605 | 11.128/-3.639 | 121.6 | 是 |
| map-03/guangyang-target-2 | 2146→2607 | 59.500/40.600/48.711 | 1.2215 | 11.442/+1.205 | -40.2 | 是 |
| map-04/guangyang-target-2 | 2648→5525 | 398.800/353.300/93.604 | 4.2605 | 13.329/-1.898 | 164.4 | 否 |
| map-05/guangyang-target-1 | 2846→4813 | 270.900/257.900/60.492 | 4.4783 | 13.455/-1.610 | 103.3 | 是 |
| map-06/guangyang-target-2 | 2920→3812 | 129.300/122.600/71.702 | 1.8033 | 11.823/-4.737 | 116.6 | 否 |
| map-08/guangyang-target-1 | 2846→4447 | 221.200/207.900/60.446 | 3.6595 | 13.168/-1.517 | 102.7 | 是 |
| map-09/guangyang-target-2 | 4464→5879 | 174.800/129.600/71.245 | 2.4535 | 16.771/+4.273 | -43.5 | 否 |
| map-10/guangyang-target-1 | 2447→2817 | 48.100/40.000/41.632 | 1.1554 | 13.388/+3.194 | 13.9 | 否 |

map-07 未抓取，相关几何为未知，不能填0。全部9个抓球结果均重新核算，覆盖 map-02/04/09 等至少3个独立场景。抓取使用同tick且抓取input前的sample；该tick的前后位姿相同，没有近邻tick替代。sample的x/z为6位小数、heading为4位小数，“精确”指事件时刻绑定。

视线夹角由最后 memory_hit 的 M5 world−pose 与 approach前航向独立重算，差异<0.15°（日志舍入）。该值不同于最终抓取真球方位；JSON另列最终真方位。

## 原图与冻结抽查

- [map-02 抓取后主视图](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/attempts/attempt-005.demo/event-001264-package_grabbed-tick-4754.png) 已实际查看：正常场景，非空白。事件tick4751，拍摄tick4754，延后3tick；不是事件同刻PNG。全景包裹像素较小，抓取判定以原生accepted事件和holding支持。
- [map-04 抓取后主视图](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/attempts/attempt-001.demo/event-001467-package_grabbed-tick-5528.png) 已实际查看：正常场景，非空白。事件tick5525，拍摄tick5528，延后3tick；不是事件同刻PNG。全景包裹像素较小，抓取判定以原生accepted事件和holding支持。
- [map-09 抓取后主视图](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-1/attempts/attempt-004.demo/event-001560-package_grabbed-tick-5882.png) 已实际查看：正常场景，非空白。事件tick5879，拍摄tick5882，延后3tick；不是事件同刻PNG。全景包裹像素较小，抓取判定以原生accepted事件和holding支持。

批结束原 freeze_verification.json 的22项均true，冻结副本逐项SHA核对；当前获准批后开发造成的源文件差异另列JSON，不改写历史清单。十局sourceCode都等于本轮program.py平台strip形式，四项版本字段一致。

旧stage-1分组保持不变，map-01/03仍为一个独立场景。WM测试精度仅E/G有效关联；其他位置不推导泛化结论。本轮4个目标包裹送达（另5个已抓未送达、map07未抓），并未完成全任务。
