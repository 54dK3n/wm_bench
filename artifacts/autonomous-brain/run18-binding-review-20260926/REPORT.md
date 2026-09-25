# Run18 身份绑定独立诊断

本诊断不替代正式评测，不构成 PASS。Run18 原有 FAIL、SIGTERM、缺失 `brain/summary.json`、未完成 `done` 等结论均保持不变。未修改原始证据、正式评测、生产源码或判定门限，也没有补造 summary。全部真值读取发生在该局结束后，诊断数据不得作为脑的输入。

先保存了九个输入文件的 [SHA 清单](input-sha256.json)，再从 Run18 冻结提交 `258ebab` 提取 [evaluator v3 原文](evaluator_v3.py.txt)。其 SHA256 为 `f65cf386055dff76a3b8d59547bca8b9009657581310957add58bc1f495b914f`，与正式报告记载一致。另保存同提交的 [perception v7 原文](perception_v7.py.txt) 与 [来源 SHA](source-supplement-sha256.json)。当前工作树 evaluator 的后续版本未用于计算。

## 全局冲突来自送达后的四帧

冻结 v3 的 `evaluate_perception` 和 `evaluate_judge` 重算结果与原报告逐字段一致：032、114 的全局集合都含两个物理 ID；正式位置误差为 0 个有效、86 个无法归属；5 个抓放动作均为 unverifiable。

| WM ID | 首次唯一几何对应 | 全程唯一对应次数 | 额外 ID 的全部帧 |
|---|---|---|---|
| target_032 | obs75／r13／54.02s → target-1 | target-1：68；target-2：1 | obs623／r92／471.30s |
| target_114 | obs518／r79／393.74s → target-2 | target-2：62；target-1：3 | obs711／r105／533.62s；obs725／r107／543.30s；obs854／r126／659.36s |

表内 `target-1/2` 为原始 `guangyang-target-1/2` 的简写，均来自原 v3 的同帧、同类别、真值中心落在原始 bbox 内且双向唯一的几何规则；没有最近真值距离补配或 bbox 扩张。

四帧的 perception 标签均来自 `matches_verified_placement`，不是原始确认样本串到另一球：已送达位置的现有 15cm 门控把检测设置为 `known_delivered_object_id`，并使其 `fed_to_world_model=false`。v3 仍将这些检测的 `track_id` 加入全程身份集合。其具体成因为：

- **obs623**：第二球刚释放，bbox `(146,266,342,214)`，raw12cm。其中心投影为 target-2 的 `(320.0000,396.0869)`；target-1 投影 x≈−154.69，在画面外。检测估计位置距已送达032的位置 **5.700243cm**，因此被标032。该帧032状态是 DELIVERED，114尚为 HELD，空爪；属于第一球送达之后、第二次放置过程中的标签冲突。后退后的 **obs624** 已将两个红框分别唯一对应 target-1 和 target-2，放置使用的新球 bbox `(276,210,88,62)` 对应 target-2，而非这个错误标签。
- **obs711**：两个完整红框分别唯一对应 target-2、target-1。target-1 检测估计位置距114已送达位置 **11.611755cm**，略近于 target-2 检测到114的 **11.881191cm**；原按距离排序的一对一贪心分配先将 target-1 标为114。target-1 检测距032 **15.011337cm**，超过原15cm门限；target-2 检测距032 **17.864447cm**，也超门限，遂成为新轨迹136。这里 raw84/78cm，并非 raw<40cm 的近场特例。
- **obs725、854**：target-1 检测距114、032分别为 **8.308506cm、8.471646cm**，原贪心选择114。另一红框在右边界裁切，target-2 投影 x≈641.545 超出该框右边界640，按原规则保持 unmatched。两帧 raw46cm 的错误已送达标签可精确复算。

[诊断 JSON](diagnostic-v2.json) 保存全部四帧的原 bbox、相机矩阵、中心投影、转换后位置、候选距离和原贪心选择；四帧分配均与日志完全一致。这是后续已送达检测标签令全局集合出现冲突的具体证据，不能倒推此前抓放已被证明抓错，也不能据此删除全局冲突记录。几何对应本身仍不独立证明遮挡可见性。

## 动作当时的时间局部核对

对每个动作，仅以**截至该动作 final_observation 的完整前缀**构造身份集合，不删除前缀内任何不利帧，然后原样调用冻结 v3 的 `evaluate_judge`。这是另列的诊断口径，正式全局规则不变。

| 轮次／动作 | 原观测窗口 | 当时唯一身份 | 原生证据 | 诊断结果 |
|---|---|---|---|---|
| r24 pick 032 | 146–158，tick5097–5453 | target-1 | accepted grab tick5279；最终 holding=target-1 | 与成功声明一致 |
| r36 place 032 | 254–261，tick10903–11160 | target-1 | release、delivered tick11005；最终空爪及原目的区几何 | 与成功声明一致 |
| r87 pick 114 | 563–571，tick20806–21059 | target-2 | 三次 `far` 失败 tick20852/20945/21038；始终空爪 | 与失败声明一致 |
| r89 pick 114 | 575–586，tick21096–21480 | target-2 | 两次 `far` 后 accepted grab tick21306；最终 holding=target-2 | 与成功声明一致 |
| r92 place 114 | 618–625，tick23414–23699 | target-2 | release、delivered tick23544；最终空爪及原目的区几何 | 与成功声明一致 |

因此是**4 个成功声明和1个失败声明获得局部证据支持**，不是“五次动作都成功”。JSON 同时保留每项的正式 `unverifiable` 行与诊断行。各关键相机帧的 `holdingTruthId` 与原生同 tick 持物样本相符；两次放置的真实见证帧 obs260、624，其原始 ball bbox 分别唯一对应 target-1、target-2。此结果不能抵销进程异常、缺汇总或未完成探索。

## 位置误差的诊断范围

以首次全局冲突前的完整前缀 **obs1–622** 复算原 v3 CONFIRMED 样本及坐标变换，两个轨迹的86个确认状态观测中，**82个有效，4个继续不可计入**。4个是 obs152、580、581、582：球已在夹爪中，没有 active 同帧真值；没有补配这些缺证据帧。

| 范围 | 有效数 | 均值 cm | RMSE cm | 最大 cm |
|---|---:|---:|---:|---:|
| target_032 | 29 | 2.647182 | 2.762973 | 3.178125 |
| target_114 | 53 | 8.050884 | 8.050884 | 8.050884 |
| 合计 | 82 | 6.139819 | 6.677842 | 8.050884 |

这是逐观测采样，重复估计仍重复计数，不是82个独立确认视点；114的53个样本保持同一已确认位置。以上数字不能替换正式全程统计的0有效／86无法归属。

## 复算与完整性

在仓库根目录运行：

```sh
python3 -B artifacts/autonomous-brain/run18-binding-review-20260926/diagnose.py --output diagnostic-rerun.json
```

输出必须是本目录内未存在的新文件。[脚本](diagnose.py) 验证输入 SHA、冻结 evaluator SHA、正式 perception/Judge 全字段一致、native samples 与独立 samples 导出一致；运行后再次验证所有输入 SHA 未变。无网络或模拟器调用。

[v2 执行记录](execution-v2.json) 为 exit0，stderr为空；[原始输出](execution-v2.stdout.txt) 与 [JSON](diagnostic-v2.json) 均已保存。v1为首次相同范围复算；v2追加已送达分配候选表与精确重现断言，未改变动作前缀、阈值或统计范围。新目录文件 SHA 见 [交付清单](SHA256SUMS.json)。
