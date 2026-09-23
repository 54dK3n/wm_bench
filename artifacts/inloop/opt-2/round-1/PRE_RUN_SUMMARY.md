# opt-2 第1轮：运行前状态

**这是运行前说明，不是批跑结果。** 当前待冻结程序为 `wm-opt2-r1-20260924`，SHA256 `203e7a8acfa041064f341b6103b1fda4f80cc64b304ca3ae628e34844d79ca0e`。具体改动、≥3旧独立几何和五局送货循环原始数值见[CHANGES.md](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/round-1/CHANGES.md)。

|项目|当前证据|运行前状态|
|---|---|---|
|P3.1受控控制器协议|同原生控制器、固定速度，100cm×3及45/90/180°各3；12条全部纳入，最大残差0.4357%，k=0.060290462706043484cm/°。|指定夹具协议通过；复杂任务泛化不据此判通过。|
|名义k使用范围|9个真实独立场景的118条同速完整控制全部保留，最大残差23.55%，21条>10%；未参与重拟合。|根任务[USAGE_DECISION](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/constant-evidence/USAGE_DECISION.md)允许作为名义代价，明确外部限制。|
|最短角/道路代价/侧向覆盖|角度与有向部分边软件用例、公开抓取窗口几何证明、旧B/C/D/E不同位置抓取回归依据。|离线证据已有，不代表新布局实测。|
|异步与固定逻辑|[独立审查](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/pre-run-review/REVIEW.md)：实际平台转换、25函数AST不变、真实WM配合显式动作测试替身的双轨迹衔接、无await生成器/lambda、无布局坐标/target锚点。|已核对当前程序SHA；真实运行身份尚待原始program_version。|
|WM动作证据|新提交326a5f8892b9da11996b5f3d3d0fc56341aca6e4；ZIP61308c1c20270ec31d8ee5870ed2b01bf6920075e4820e5fc8c30bd2e626f1fb；原融合AST保持。|API单测/归档交付已有；真实抓持后三秒内证据须由本轮日志核验。|
|最终软件预检/证据审计|[preflight.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/round-1/preflight.json)、[tests.txt](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/round-1/tests.txt)、[pylint.txt](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/round-1/pylint.txt)、[坐标检查](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/round-1/static_coordinates.json)。|仍由根任务汇齐最终代码后复核冻结，不预填测试数。|
|P3.4首次选择与离线穷举最优一致≥8/10|需完整本轮选择时刻公开快照及driver独立真值穷举；缺失/unknown不得当通过。|**未运行，不能PASS。**|
|两个不同目标实际抓取并送达≥8/10|需原生record中真实package事件及每球固定规则，不能用软件替身或单球成功代替；另报本轮独立场景。|**未运行，不能PASS。**|
|成功双送达局耗时中位≤300s|需本轮实际第二次送达时刻和明确成功局范围，失败仍逐局报告。|**未运行，不能PASS。**|

每球 approach≤3，observe≤92/整局；全局运动观察守卫和导航预算不会在第二球重置。确认继续使用原40≤读数<90cm的WM窗口、同track三次不同位置命中、全部位置间距≥15cm、末点≥0.5m，之后纯记忆行驶≥30cm再在WM≤0.25m处approach(max_steps=1)，全程onRoad。保留原过滤器v2及测试污染说明，M5、WM融合和确认规则不改。

抓取侧向恢复只在空手后有界尝试；公共storage搜索不observe，沿实际道路几何和公开出口行驶，有限停车点/角度用release_preview验证。旧map-01零位移junction和04/06/09/10受阻循环都只作为开发证据；本轮是否消除它们仍待实测，不能提前称已修复成功。

冻结后 map-01…map-10 各一局，中途不得改程序、driver、runner、评测脚本或冻结清单；全部结束后才统一复核和讨论修改。失败不重跑、每阶段最多3轮；本文件不授权额外试跑。每局保存完整raw、samples、原生record、图像及精确事件。当前所有“待运行”项保持未评估，阶段2尚未宣布通过。
