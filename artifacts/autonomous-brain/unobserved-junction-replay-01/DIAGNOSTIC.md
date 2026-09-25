# 未观测节点时执行器停止：Run19前140轮回放诊断01

定向恢复诊断 **PASS**：第140轮保持原模型状态与explore动作，原follow_road仍在零位移、零tick且新观测无节点时报告junction；actions v19识别这一不一致，按公开道路切线转向，再取得新净空后前进4cm。实际位移3.9824615503479683cm，后观测onRoad、atNode、atJunction均为true，且出现三个出口。结论由实际动作和新传感观测支持，不以执行器junction标签代替节点见证。

整个任务仍为 **FAIL**：本次预设降低为140轮诊断上限，brain以round_limit结束；独立评测确认有效交付1/2，第二球仍持有且未在存放区，没有自主done。这不是新正式模型运行，不加入LIVE_RUNS，不是十布局门票，也不证明后续任务一定完成。原Run19的FAIL和11次explore假PASS记录保持原样。

## 冻结来源与严格前缀

冻结提交`6ee4abf464504eb297242df98dc9fadaaf7debfa`，actions v19、runtime v10、navigation v4、LLM v12、driver v6。`source-commit.json`按Git blob逐个核验7个brain文件及driver，与运行前manifest、运行后manifest及7项brain summary SHA全部相符；完整前后manifest相等，sourcesUnchanged=true。平台14项与capture函数记录指纹前后相同。本证明不依赖后续HEAD或工作树。

输入`../unobserved-junction-fix-20260926/run19-prefix-140.jsonl`逐字节保留原Run19决策1–140的全部150条模型调用，包含历史重试和输出修正。共5,961,941字节，SHA256为`dd638c5444c3aa7df50b6ce915e36751ad20c3b93c2c30c9bf0d7f11aef32d60`。

独立的`prefix-replay-proof.json`核验：

- 全140个state和action逐字段相同，前139个执行result相同。
- 全150条模型调用除顶层mode从live改为replay外完全相同，原始行也只有这个token变化；嵌在round里的模型记录同样核验。
- 所有记录完全消耗，无提前输入失配。原Run19与诊断的观测到obs926逐字段、原始字节均相同；前647条motion完全保留。
- 首个不同观测为obs927：原局是无运动的最终观测，新局是新增转向后的观测；随后新增前进。第140轮result有意改变，没有宣称第141轮及以后旧输入仍可沿用。

再次独立执行严格离线LLM核验，140轮/150条记录全部匹配；使用的LLM源码SHA与冻结提交相同，网络调用0、环境读取0。实际场景回放也走replay分支，全部150条调用为replay；这是应用记录与源码分支证明，没有额外网络抓包。2268.6844635429993秒模型elapsed及2秒重试等待均为历史字段，不能算作新模型耗时或API用量。该诊断brain实际墙钟344.668694375秒，driver进程墙钟344.834秒。

## 第140轮的公开恢复证据

起始obs925和原沿路后obs926：right=103.3cm、forward=31.9cm、heading=−171°，tick33423/668.46秒；onRoad=true、atNode=false、atJunction=false、exits=[]。公开headingErrorDeg=−47.6°，左净空0.1cm，前净空28.4cm。原姿态下直接前进的侧向许可为0；本次没有绕过这个约束。

| 动作 | 观测 | 新证据 |
|---|---|---|
| follow_road请求20cm | 925→926 | junction、0cm、0ticks；仍无节点和出口 |
| 按公开切线turn −47.6° | 926→927 | 位置不变，heading=141.4°、headingError=0、前净空103cm；仍未见节点 |
| 新观测许可forward 4cm | 927→928 | 实移3.9824615503479683cm，onRoad/atNode/atJunction均true，三个出口 |
| 运行循环最终观测 | 929 | 道路、里程计、holding和物体表与928相同 |

恢复共增加52ticks/1.04仿真秒，最终tick33475/669.5秒；新出口角为22.7°、−53.9°、−178.3°。实测沿向位移3.982412456271802cm，横向偏差0.019774431247951085cm，航向在前进时不变。全程仍holding=true。`boundary-recovery-proof.json`保存完整公开快照、计算公式、原/新结果和预算核验；没有用真值位置授权动作。

恢复只用了一次4cm请求，在最多五次、每次不超过4cm、总请求不超过20cm的原定预算内。节点、道路安全、确认、抓放和done判据均未放宽。原公共反例与离线修复证据见[只读诊断](../unobserved-junction-review-20260926/REPORT.md)、[actions v19修复](../unobserved-junction-fix-20260926/REPORT.md)。

## 独立交付、Judge与误差

评测器v4从本诊断导出的原生record事件及最终sample核对：首球抓取95.2秒，有效交付206.58秒，交付事件未撤销且终态在存放区内、未持有；第二球抓取590.38秒，没有交付事件，终态仍持有、在存放区外。终态sample tick与record结束tick均为33475。脑内target_034为DELIVERED、target_136为HELD；7次grab分别为首球2次、第二球5次（第125轮3次失败，第128轮2次后成功），仅首球release一次。

独立抓放Judge为4次match、0假阳性、0假阴性、0无法核验，覆盖r22 pick、r40 place、r125失败pick、r128成功pick；其余136轮不在抓放对照范围。第140轮恢复PASS来自独立公共传感核验，不伪称评测器对explore给了真值Judge。

WM红球位置误差基于75个同帧唯一绑定的CONFIRMED观测样本：均值5.83252911229038cm、RMSE7.03387033597925cm、最大11.09313323775761cm；另3个持物后的确认轨迹样本无法绑定。重复估计仍按每观测计入；不能把未匹配样本当零误差。逐球时间线、匹配样本和抓放依据保存在`report/evaluation.json`，可复算指标在`diagnostic-metrics.json`。

## 指标及失败边界

| 项目 | 结果 |
|---|---:|
| 轮次 / 历史模型调用 / 观测 | 140 / 150 / 929 |
| motion / robot bridge请求 | 649 / 4366 |
| explore / look_around / go_to / pick / place | 77 / 43 / 16 / 3 / 1 |
| 自报成功动作 / 原动作失败 | 121 / 19 |
| 控制器错误 / 执行异常 / 外停错误 | 0 / 0 / 0 |
| 新模型API请求 | 0 |
| 重放的历史传输错误 / 状态校验错误 | 2 / 8 |
| 独立有效交付 | 1/2 |
| 上限 / 实际仿真时间 | 140轮、1200秒 / 669.5秒 |

19次动作失败：道路受阻返回r8/41/65/86/103/110/111；视觉停靠需道路换位r18/122/137/138；已知路线耗尽r23/28/33/34；r125三抓失败；r129路线无进展；r130路线受阻；r135当前视野未见停靠目标。都在未改变的前139轮中。

两次历史HTTP502和八次历史CONFIRMED校验错误原样重放并已恢复，没有本次新网络失败。4366条bridge调用终态均completed，无非白名单请求；649条motion与桥中对应方法、参数、返回值一致。

独立评测的失败项为第二球未交付、第二球终态在存放区外、round_limit_reached、未observed done、末轮done缺乏佐证及通用execution_or_controller_error。最后一项来自brain status=failed/round_limit，不代表本次实际有执行异常或控制器错误。没有外部停止记录，process.signal/interrupted均为null；140轮是主动降低的诊断上限，正式200轮任务没有在此运行。

## 归档完整性与复核

driver status=complete、sourcesUnchanged=true；五项导出complete、failures=[]、partial={}。4个gzip逐个流式读至EOF验证CRC、压缩/展开大小及SHA256，envelope也独立匹配。原record压缩222,137,867字节、展开318,324,295字节，SHA256为`617689e51ad4e76a64b16cc718ff08c7b0051c7a6a9b6f3b9f942f6f3c311ac6`。超过100MiB，因此按原gzip字节切为五片（四片50MiB、末片12,422,667字节）；已实际恢复新临时文件并核对总SHA，原文件保留在本机，仅精确忽略该路径。恢复命令见[record-chunks/README.md](record-chunks/README.md)。

`original-input-hashes.json`保留25份原始driver/brain/导出文件哈希；`archive-checks.json`复核原件及前19局既有报告未改；`publication-checks.json`扫描本目录文本及四个gzip展开内容，不读取配置或密钥文件。分片由已扫描的原gzip和恢复总SHA覆盖；所有提交候选单文件均小于100MiB。旧正式结果、LIVE_RUNS及当前docs未由本归档改写。真值只在结束后供独立评测，未传给脑。

从仓库根目录可重做（使用新的输出目录；评测exit1表示成功生成完整FAIL报告）：

```sh
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1 --out artifacts/autonomous-brain/unobserved-junction-replay-01/recomputed-report
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1 --out artifacts/autonomous-brain/unobserved-junction-replay-01/recomputed-llm-replay
```
