# opt2 round1：选择与身份诊断

只读离线重算；L均为raw.lines零基索引。原生事件tick由明确的t毫秒/20ms换算；动作结束日志tick另列，不能混作抓起瞬间。

P3首选真值最优9/10；但10次首选均只有1个WM候选，其中5次代价unknown走唯一目标fallback。因此本轮证明了首次锁定目标的结果一致性，没有实测两已知候选之间的排名。第一球9次真抓取全部保留，0次capture回归；抓取次数/时间增加另列。

|布局|首选L/tick|WM候选/状态|所选真包/最优|两真包最优成本cm|第一抓：旧→新秒（次数）|
|---|---|---|---|---|---|
|map-01|L15/t675|1/unknown|guangyang-target-2/True|target-1=207.03 / target-2=75.13|52.14→62.90 (3→11)|
|map-02|L19/t1785|1/unknown|guangyang-target-1/True|target-1=118.0 / target-2=157.3|95.02→105.78 (3→11)|
|map-03|L15/t675|1/unknown|guangyang-target-2/True|target-1=259.68 / target-2=75.13|52.14→62.90 (3→11)|
|map-04|L26/t1718|1/selected|guangyang-target-2/True|target-1=193.65 / target-2=104.16|110.50→115.88 (2→6)|
|map-05|L26/t1718|1/selected|guangyang-target-1/True|target-1=104.16 / target-2=216.07|96.26→101.64 (2→6)|
|map-06|L223/t2170|1/selected|guangyang-target-2/True|target-1=246.85 / target-2=173.23|76.24→81.62 (2→6)|
|map-07|L6370/t13133|1/selected|None/False|target-1=188.47 / target-2=120.12|无抓取|
|map-08|L26/t1718|1/selected|guangyang-target-1/True|target-1=104.15 / target-2=216.07|88.94→94.32 (2→6)|
|map-09|L38/t3453|1/unknown|guangyang-target-2/True|target-1=382.03 / target-2=114.97|122.88→138.52 (4→16)|
|map-10|L177/t2064|1/unknown|guangyang-target-1/True|target-1=114.84 / target-2=283.34|56.12→61.50 (2→6)|

|布局|第二球身份/结果|停止原始证据|
|---|---|---|
|map-01|未启动第二球|L371 tick=3159 未找到可确认的目标物存放姿态或释放未验证; Q/C=134/21|
|map-02|未建立/锁定第二球WM轨迹；observe 49，合法窗口真剩余目标检测 0，已送达区域排除 2|L8633 tick=16120 navigation_queries_budget_exhausted; Q/C=1000/133|
|map-03|未启动第二球|L371 tick=3159 未找到可确认的目标物存放姿态或释放未验证; Q/C=134/21|
|map-04|target_002 unmatched_tentative_not_CONFIRMED L581/t8817；observe 55，合法窗口真剩余目标检测 0，已送达区域排除 10|L6758 tick=21714 navigation_queries_budget_exhausted; Q/C=1000/199|
|map-05|target_002 remaining_true_target L745/t12063；observe 16，合法窗口真剩余目标检测 3，已送达区域排除 0|L3054 tick=15686 None; Q/C=668/161|
|map-06|target_002 unmatched_tentative_not_CONFIRMED L742/t9689；observe 39，合法窗口真剩余目标检测 0，已送达区域排除 13|L9627 tick=25529 WorldModel 未通过 observe() 确认目标物; Q/C=944/279|
|map-07|未启动第二球|L8948 tick=14938 WorldModel 未通过 observe() 确认目标物; Q/C=557/124|
|map-08|未建立/锁定第二球WM轨迹；observe 51，合法窗口真剩余目标检测 0，已送达区域排除 1|L12347 tick=18995 WorldModel 未通过 observe() 确认目标物; Q/C=862/174|
|map-09|未启动第二球|L1339 tick=None navigation_queries_budget_exhausted; Q/C=1000/109|
|map-10|target_002 remaining_true_target L641/t13157；observe 21，合法窗口真剩余目标检测 3，已送达区域排除 0|L1535 tick=16369 None; Q/C=714/192|

全部排除事件26条：23条严格标签唯一匹配已送达球；0条匹配剩余球；3条无严格几何匹配。不把无匹配行强行认作某个球。

04/06的第二锁定均为64cm、35.45°、confidence .90：超原确认方位35°，三点接受数0。其M5投影约[1.4194,-.2274]m，既不在原抓取位置，也不是30cm内的新真球；最近已送达球仍约50.8cm远。下一条59cm/35.27°/.92生成另一条tentative轨迹，旧锁定ID已不在活跃快照；未获得任何球2 confirmed。详细距离、原始帧与标签在JSON selections/support_raw。

02/08没有球2轨迹：剩余真球仅有100cm封顶方位线索，没有40≤raw<90的真球观测入库。不能把100cm视作定位。04后段也才看见剩余球的封顶方位；06第二球完全未获得剩余球匹配观测。

05/10第二次原生grab/delivery分别对应未送达的另一package ID，非重抓已送达球。每次新API撤销均置confidence0/LOST，动作结束tick与原生抓起事件的间隔详见wm_action_removals；没有从旧位置复活同一轨迹的证据。

建议（尚未改代码）：保持确认/WM窗口/过滤阈值，区分tentative搜寻候选与通过确认后的身份锁；候选轨迹已LOST或视点证据耗尽时明确解除旧搜寻锁并回到新线索，而不是让残留ID阻止新轨迹。封顶射线的选取与进窗应利用全部公开方位及跨次运动一致性，不能仅取列表第一项后把空帧前的陈旧射线无限保留。已送达区域排除不能盲目扩大半径，附近仍可能有另一真球；这轮没有观察到它误删已匹配剩余球。

复算：`PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-1/selection-diagnosis/reproduce.py`。所有原始文件和依赖SHA记录于diagnosis.json。新脚本仅导入现有只读标签/独立oracle函数，不启动仿真，不更改原报告或冻结代码。

封顶射线失联检查（限定下一次observe之前仍继续选射线视点，排除跨巡逻阶段的误计）：

|布局|新帧无eligible red后仍继续的次数|首个证据|
|---|---|---|
|map-01|0|无|
|map-02|41|L971/t10238: L969 bailu-outer-arc@169.6 → L1003 bailu-south@33.3|
|map-03|0|无|
|map-04|19|L5380/t18818: L5378 oil-south@57.6 → L5389 oil-south@49.8|
|map-05|1|L664/t11700: L662 east-outer-south@175.0 → L702 oil-south@25.0|
|map-06|0|无|
|map-07|20|L185/t3357: L183 oil-west-arc@6.4 → L234 middle-east@105.0|
|map-08|9|L1163/t11476: L1161 oil-west-arc@6.4 → L1221 oil-west-arc@25.0|
|map-09|0|无|
|map-10|0|无|

02/07/08在当前轮完整两球轨迹complete-link分组分别为S02/S06/S07（原opt2_report.json的scenarios/固定容差亦存入本JSON），构成三场景失联射线依据；不是单凭布局名计独立。成功05也出现一次：L664/t11700只有蓝41cm/1.1°/.86、46cm/2.48°/.78、100cm/21.17°/.76，随后仍选oil-south@25.0并最终抓到第二球；因此提前返回巡逻会改变05路径，不能声明离线已证明无回归。10没有这一触发。

修复边界：只在一次真实observe刷新之后判断线索已失联。每轮循环中_planning_goal(pose, [], goal)表示尚未新观察，不能以它清空射线。返回局部进窗失败后由巡逻继续，保持所有原始红蓝、WM窗口、过滤与三点确认不变。空帧WM衰减及LOST锁释放的独立回放见EMPTY_UPDATE_REPLAY.md；不建议在缺少新证据时为旧目标无限扩展全图。
