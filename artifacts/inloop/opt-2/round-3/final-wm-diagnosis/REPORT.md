# 最终轮WM、确认与目标身份审计

只读保存轨迹/原生记录；L是raw.lines零基索引，原生event_index亦为零基。坐标编号只在离线报告中使用，WM与同tick精确renderTruth真球距离≤30cm且唯一匹配才编号；没有WM或未确认仍标unknown，不用最近目标/原始检测强行补标签。

本轮9/10首选与独立真值代价oracle一致；仅9局有首选，map07未选择不能记作成功。9次首选全部仅1个WM候选，其中5次运行时代价unknown并用唯一候选fallback。因此不是9次两已知WM候选排名验证。第一球真实抓取9/10，对opt1-r2的capture退步0局。

全部首次CONFIRMED轨迹12条，phantom=0、身份unknown=0；实际observe 280次、原地重复0、guard违规0、原生program_error 0。本轮结束；阶段2失败停止，不启动阶段3。

|布局/球|确认标签及WM误差cm|确认L/tick|实际抓取/送达（秒）|observe / WM入库条数|结果|
|---|---|---|---|---|---|
|map-01/1|B / 2.4996|L295/t2146|55.76 / —|6 / 3|L682: constraint / navigation_queries_budget_exhausted|
|map-02/1|C / 5.4395|L759/t3258|93.24 / 129.50|6 / 3|L909: delivery / success|
|map-02/2|D / 5.3316|L1562/t9835|— / —|14 / 4|L3478: constraint / navigation_queries_budget_exhausted|
|map-03/1|B / 2.4996|L295/t2146|55.76 / 86.32|6 / 3|L363: delivery / success|
|map-03/2|无对应真球/未确认|未确认|— / —|28 / 0|L773: confirmation / WorldModel 未通过 observe() 确认目标物|
|map-04/1|C / 2.7074|L280/t2648|97.94 / 141.44|8 / 3|L558: delivery / success|
|map-04/2|无对应真球/未确认|未确认|— / —|30 / 2|L1872: confirmation / WorldModel 未通过 observe() 确认目标物|
|map-05/1|C / 2.4231|L322/t2846|87.08 / 123.36|8 / 3|L576: delivery / success|
|map-05/2|E / 7.3024|L1214/t10028|290.22 / 319.60|16 / 3|L2291: delivery / success|
|map-06/1|D / 8.1726|L533/t2920|74.38 / 167.10|10 / 3|L719: delivery / success|
|map-06/2|无对应真球/未确认|未确认|— / —|30 / 2|L2250: confirmation / WorldModel 未通过 observe() 确认目标物|
|map-07/1|无对应真球/未确认|未确认|— / —|26 / 0|L239: confirmation / WorldModel 未通过 observe() 确认目标物|
|map-08/1|C / 2.6023|L322/t2846|81.62 / 117.90|8 / 3|L543: delivery / success|
|map-08/2|无对应真球/未确认|未确认|— / —|39 / 0|L1739: confirmation / WorldModel 未通过 observe() 确认目标物|
|map-09/1|E / 10.3272|L965/t4489|129.46 / —|15 / 4|L1444: constraint / navigation_queries_budget_exhausted|
|map-10/1|D / 3.6552|L466/t2447|56.12 / 97.60|8 / 3|L558: delivery / success|
|map-10/2|G / 1.0188|L1217/t10755|236.12 / 255.18|22 / 3|L1539: delivery / success|

误差使用日志最后确认WM快照（坐标打印至.001m）与确认帧精确真值；原始精确命中坐标也保存在JSON，不能将打印精度当更高的测量精度。表中确认时刻是业务memory_confirmed，首次WM状态CONFIRMED另存JSON。

12次业务确认的同ID、3点、原始40≤d<90、所有两点间距≥15cm和末点≥0.5m全部通过；最小实际间距15.005332cm，末点最小0.553380336m。其他5个已启动球次没有确认，不把缺失当通过。

|布局|first choice L/tick|唯一候选状态|所选package/真值最优|旧→新第一抓秒|旧→新抓取尝试|
|---|---|---|---|---|---|
|map-01|L15/t675|unknown|guangyang-target-2 / True|52.14→55.76|3→7|
|map-02|L19/t1785|unknown|guangyang-target-1 / True|95.02→93.24|3→7|
|map-03|L15/t675|unknown|guangyang-target-2 / True|52.14→55.76|3→7|
|map-04|L26/t1718|selected|guangyang-target-2 / True|110.5→97.94|2→2|
|map-05|L26/t1718|selected|guangyang-target-1 / True|96.26→87.08|2→2|
|map-06|L223/t2170|selected|guangyang-target-2 / True|76.24→74.38|2→2|
|map-07|无选择|unknown|None / False|均未抓取|0→0|
|map-08|L26/t1718|selected|guangyang-target-1 / True|88.94→81.62|2→2|
|map-09|L38/t3453|unknown|guangyang-target-2 / True|122.88→129.46|4→12|
|map-10|L177/t2064|unknown|guangyang-target-1 / True|56.12→56.12|2→2|

第一球capture无退步仅指原来抓到的9局仍抓到同一package；01/03慢3.62s、尝试3→7次，09慢6.58s、尝试4→12次，不能称全部性能无退步。抓取尝试指原生package_grab交互次数，不等于approach调用次数。

E/G仅作为未见位置精度结果：

|位置|n（确认的球次）|各次误差cm|均值cm|
|---|---|---|---|
|E|2|map-05/球2 L1214=7.3024；map-09/球1 L965=10.3272|8.8148|
|G|1|map-10/球2 L1217=1.0188|1.0188|

n为成功确认的球次，不能把未确认的E/G规划线索计作精度样本；E两次来自同一实际目标位置，也不是两个独立未知位置。A/B/C/D/F误差仅逐局描述，不据此推出泛化精度。

失败归因与空帧/身份变化：

归因先区分确认与后续步骤：03/04/06/08均已送达第一球，第二球未确认；07是第一球未确认，根本没有第二球阶段。02是第二球确认后未到抓取。01/09是第一球抓取后未送达。

- map-01：最终L682/tNone constraint/navigation_queries_budget_exhausted，Q/C=1000/74，本球observe 6，全局6/92。原生event[7]在55.76s/t2788已抓guangyang-target-2；退出仍holding=目标物，无package_delivered；不能归为确认失败或第一球capture退步。预算证据L681查询1000/1000，未启动第二球。
- map-02：最终L3478/t22727 constraint/navigation_queries_budget_exhausted，Q/C=1000/300，本球observe 14，全局20/92。球2 target_002唯一关联新真D，确认误差5.3316cm（L1562/t9835，三点50/50/55cm，最小间距15.0053cm，末点0.728643m）。后续未调用approach、未grab、未发生轨迹LOST。L3467再选north-west-main@72.5：path=0cm、remainingBound=219.4128156126cm；L3468推进before=after=72.5cm、distance=0、stoppedBy=junction；L3476改选@88.1，path15.6cm、remainingBound207.0190654299cm，最终L3477查询预算1000/1000。属于真实确认后的记忆导航预算失败。
- map-03：最终L773/t10182 confirmation/WorldModel 未通过 observe() 确认目标物，Q/C=507/137，本球observe 28，全局34/92。本球WM窗口入库0、没有新WM轨迹，原始空帧14、无红25。失联封顶射线正常退出L600/t7306,L752/t8945，随后巡逻。末次观察L769/t10182 odo=[73.4, 220.5, -80]、raw=[{"category": "distractor", "distanceCm": 27, "bearingDeg": 18.61, "confidence": 0.87}, {"category": "distractor", "distanceCm": 28, "bearingDeg": -32.02, "confidence": 0.85}, {"category": "distractor", "distanceCm": 27, "bearingDeg": -10.63, "confidence": 0.8}]；末帧没有可入库红球，确认失败不是已确认球遗失。
- map-04：最终L1872/t13266 confirmation/WorldModel 未通过 observe() 确认目标物，Q/C=574/153，本球observe 30，全局38/92。target_002 L576/t7645距最近真球50.8123cm；target_003 L1323/t8463距最近真球39.1369cm，均超过30cm、无A–G编号，均1hit从未CONFIRMED，也不能认作已送达球的准确WM位置。清锁事件L1318/t8287:target_002,L1790/t8676:target_003；末次空帧衰减L1789/t8676把target_003从.2334263124降至.1233679117并LOST，然后巡逻继续。球2原始空帧20、无红24、无eligible red28；实际仅2个伪窗口观测入库。4条已送达区排除全部严格匹配已经送达的target-2，0条匹配剩余真球，不支持排除误杀剩余球。末次观察L1868/t13266 odo=[87.6, 11.8, 19.3]、raw=[]；没有观察预算耗尽事件。
- map-05：最终L2291/t16086 delivery/success，Q/C=748/197，本球observe 16，全局24/92。两次抓取为不同package ['guangyang-target-1', 'guangyang-target-2']；原生送达为event[4] guangyang-target-1@123.36s；event[7] guangyang-target-2@319.60s，第二球不是已送达球或原位幻影。
- map-06：最终L2250/t14549 confirmation/WorldModel 未通过 observe() 确认目标物，Q/C=602/175，本球observe 30，全局40/92。target_002 L737/t8928距最近真球50.8123cm；target_003 L1629/t9746距最近真球39.1369cm，均超过30cm、无A–G编号，均1hit从未CONFIRMED，也不能认作已送达球的准确WM位置。清锁事件L1624/t9570:target_002,L2168/t9959:target_003；末次空帧衰减L2167/t9959把target_003从.2334263124降至.1233679117并LOST，然后巡逻继续。球2原始空帧20、无红24、无eligible red28；实际仅2个伪窗口观测入库。4条已送达区排除全部严格匹配已经送达的target-2，0条匹配剩余真球，不支持排除误杀剩余球。末次观察L2246/t14549 odo=[87.6, 11.8, 19.3]、raw=[]；没有观察预算耗尽事件。
- map-07：最终L239/t7583 confirmation/WorldModel 未通过 observe() 确认目标物，Q/C=245/86，本球observe 26，全局26/92。本球WM窗口入库0、没有新WM轨迹，原始空帧10、无红24。失联封顶射线正常退出L188/t3349，随后巡逻。末次观察L235/t7323 odo=[-46.6, 152.4, -101.3]、raw=[{"category": "distractor", "distanceCm": 94, "bearingDeg": -8.62, "confidence": 0.83}, {"category": "distractor", "distanceCm": 78, "bearingDeg": -11.42, "confidence": 0.82}, {"category": "distractor", "distanceCm": 57, "bearingDeg": -13.92, "confidence": 0.78}]；末段lower-east两位姿[-46.6,152.4,-101.3]与[-74.8,171.8,47]来回，位移34.228643cm/转角148.3°，所以是巡逻覆盖不足，不能误计原地重复observe。
- map-08：最终L1739/t12716 confirmation/WorldModel 未通过 observe() 确认目标物，Q/C=618/153，本球observe 39，全局47/92。本球WM窗口入库0、没有新WM轨迹，原始空帧13、无红25。失联封顶射线正常退出L1466/t10212,L1726/t12181，随后巡逻。末次观察L1735/t12716 odo=[-116.9, 65.4, 135]、raw=[{"category": "distractor", "distanceCm": 47, "bearingDeg": 12.22, "confidence": 0.82}]；末帧没有可入库红球，确认失败不是已确认球遗失。
- map-09：最终L1444/t14233 constraint/navigation_queries_budget_exhausted，Q/C=1000/130，本球observe 15，全局15/92。原生event[12]在129.46s/t6473已抓guangyang-target-2；退出仍holding=目标物，无package_delivered；不能归为确认失败或第一球capture退步。预算证据L1443查询1000/1000，未启动第二球。
- map-10：最终L1539/t12865 delivery/success，Q/C=676/190，本球observe 22，全局30/92。两次抓取为不同package ['guangyang-target-1', 'guangyang-target-2']；原生送达为event[4] guangyang-target-1@97.60s；event[9] guangyang-target-2@255.18s，第二球不是已送达球或原位幻影。

03/04/06/07/08的最终日志stage为confirmation、reason为WorldModel未通过确认，并未直接打印巡逻步号。结合冻结程序program.py:1817的24步循环、末端1864的return None、本球观察数未达传入上限，且没有patrol_failed/confirmation_aborted/异常/预算耗尽事件，可归因为有限巡逻结束仍未确认；“24步耗尽”是源码和排除分支所得推断，不冒充日志显式值。
04/06同样的局部伪轨迹被归档、03/08射线失联后退出，证明本轮新增释放旧搜寻锁机制确实触发；它没有自动解决后续巡逻覆盖和道路循环。这里不据离线轨迹推断任何未运行修复会成功。

map-02球2时间补充（保留冻结机器报告原None）：

首次全局未封顶且一对一对应D为L1294/t9433=188.66s：50cm/-7.67°/.89，相机真bearing=-7.532367928°，误差.137632072°，M5二维残差.803854762cm。首次WM实际增量入库为观察L1040/t9146=182.92s，association L1043、hit1快照L1044。该时刻早于严格首次看到，是因为L1040的78cm/34.62°/.87与同帧100cm/32.52°/.83均可按方位对应D，严格timeline的一对一规则判歧义；runtime只有78cm入库，轨迹与D相距27.9518cm。

全局最早封顶方位候选是球1期间L14/t1785=35.70s；球2分段最早候选L935/t8491=169.82s，均不是未封顶距离证据。冻结demo_timeline.py:111仅枚举实际抓取/送达package，未抓到的D没有timeline.balls条目，opt2_report.py:267/278查找得到空条目，于是首见与首WM时间为None；这不是D一直没有严格原始匹配。这里沿用冻结几何和一对一规则逐帧全局扫描，补充JSON含原图SHA及全部候选；不修改原机器报告。

全部逐条selection/CONFIRMED关联、三hit证据、原生抓取/送达索引、原地重复检查、WM空帧before/after与预算事件在diagnosis.json。真实抓取后wm_action_removed只撤销原位置：每次confidence=0/LOST且exact轨迹ID保留归档；不是额外感知衰减。

复算：`PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-3/final-wm-diagnosis/reproduce.py`。依赖与全部输入SHA随JSON保存；脚本只读原始资料，未修改任何运行/评测代码，未运行仿真。
