# 正式阶段 1：首次实质阻塞与后续链

冻结源码 `dec5b078d6711bdfda972ca4632c200e235dfb7e` 的唯一正式局，脑端结束为 `failed / round_limit`：200 轮、948 次观测、206 次模型调用、1047.64 仿真秒。本文只读取已关闭的公开脑日志，不读 record/capture/evaluation/truth，不改结果、不重跑模型或仿真。公开链诊断不是独立真值验收。

**r94 是可恢复的前期可见性失败；r105 已确认候选之后，r106 才是该候选抓取链首次实质动作阻塞。** 最终 `target_096` 曾有 5 次有效 hit，不能写成“整局没有确认第二候选”。这里的 ID 是脑端跟踪身份，不等于经真值核验的物理球身份。

## 从早期机会到确认

- r8/o31：`target_017` 首个 hit；r9 选择其稳定发现 ID 时，o34/35 原始红框已为空，采样零运动失败。该对象后来在 r20 抓取、r64 放置，说明早期可见性失败不等于不可恢复终因。
- r68/o356–357、r69/o358：另有 3 条未关联原始红框，raw 距离 59 cm、bearing −35.27°，按原确认窗口拒绝入库。r69 摘要明确 `sampling_allowed=true / needs_bearing_adjustment`，但模型选择普通 explore。这是较早未取得有效确认的机会，不是阈值被放宽或忽略。
- r93/o476：`target_096` 首个 hit，raw 76 cm/−17.74°。r94 从 o478 实际前进 15.5 cm；o479 和后置 o480 的原始红框均为空，hit 1→1，返回 `confirmation_needs_fresh_observation`。r95–98 又选四次旧发现 ID，均零运动；o481–488 原始红框为空。仅凭这些公开框不能判别物理遮挡、CV 漏检或其他成像原因。
- r105 普通 explore（exit_angle=175.1）在 o513 获第二 hit，o515 获第三 hit并转为 CONFIRMED，结果为 `target_objects_confirmed`。r106/o517 的模型状态明确显示 CONFIRMED/3 hit，模型立即选择 `go_to(target_096)`；o522/524 又增至 4/5 hit。

## r106：接近受限，实际换位没有证实到达

o526 仍看见同一候选，校正后距离 41.5409 cm、bearing 4.573°，尚未进入 25–40 cm 的 standoff 范围。道路偏角 33.3°、右侧净空仅 0.1 cm；希望再进 9.5409 cm，但公开净空计算只允许 0 cm，因此进入 `visual_standoff_requires_road_reposition`。

换位候选的脑端公开位置为 `[-0.002, 1.358] m`，历史路线长度 217.7 cm。o526→527 实际转向 −146.7°，随后 `follow_road` 合并两个短记录段，合法请求并实际行驶 10.6 cm至 o528，回执为 `accepted / max_distance`。记录要求的到达航向为 −48.9°，实际为 −15.6°，相差 33.3°，超过原 10° 到达门；虽然距合并段终点约 7.99 cm，仍不能认定完成。记录弧长已用尽，返回 `reposition_recorded_arc_exhausted_without_arrival`。

公开证据表明：接近时沿目标方向的基本步已到道路边缘；换位时重新对齐当前道路并跟路，未重现那些记录段的端点姿态。**不是电机参数拒绝、未移动，或整局步数预算耗尽。** 本轮继续保持严格到达判定，不能用近邻位置或 accepted 回执代替到达证据。r106 整次 go_to 的里程为 **101.2 cm**，其中上述候选换位只有 **10.6 cm**；两者不得混写。r107 无新证据的重复 go_to 被拒绝，零运动。

## 五次换位尝试均未闭环

以下均为同一候选位置的尝试，所选 route_version 共 4 个；不是 5 个不同物理位置。

| 决策轮 | 实际换位观测窗 | 换位里程 | 整次 go_to 里程 | 停止依据 |
|---|---|---:|---:|---|
| 106 | o526→528 | 10.6 cm | 101.2 cm | 到达航向差 33.3°，记录弧长用尽 |
| 110 | o548→550 | 14.7 cm | 79.4 cm | 到达航向差 20.7°，记录弧长用尽 |
| 112 | o566→568 | 14.8 cm | 109.0 cm | 到达航向差 20.7°，记录弧长用尽 |
| 114 | o582→584 | 11.5 cm | 83.0 cm | 到达航向差 33.2°，记录弧长用尽 |
| 116 | o600→610 | 140.1 cm | 239.9 cm | 下一段尚未完成，却重新观察到道路节点 |

r116 采用另一条已记录路线，真实完成前 6 个 segment。最后反向尝试 `road-segment-513-514` 的历史弧长为 38.5 cm；走 20 cm 后，o610 已是 `atNode=true`。此时位置误差约 8.56 cm、航向匹配，但弧长不足，该段未被消费；下一循环发现“当前已在节点、该段出发点却不是节点”，返回 `reposition_unrecorded_junction_inside_segment`。这是新的道路上下文阻塞，不是前 6 段没有执行，也不是完整候选成功。

因此：**5 次候选换位尝试、0 次候选到达、0 次完整换位成功。** 完整成功定义为当前 go_to 成功且 `road_reposition.status=reposition_and_visual_standoff_verified`；单段完成或中途到节点均不算。公开日志共保留 27 个不同候选路线版本，内部候选枚举全量未记录，不能把 27 当作全部生成次数。

r116/o610 的 `target_096` 转为 STALE，r139/o703 转为 LOST，直到结束仍是 `ever_confirmed=true / completion_classification=pending`，不能作为从未确认假设退役。整局仅一个高层 pick、一个 place、没有 done；末次决策的完成检查为 delivered 1/required 2，未满足身份和数量条件。最终手空、pending_grasp 为空，并不代表交付任务完成。末尾 125 条未解释发现记录、121 个假设也不代表物理球数量。

## 复核入口

- [公开整局诊断](raw/analysis/formal-public-diagnosis.json)：`sources` 保存四个输入的完整 SHA256；`sampling`、`track_identity_chains`、`repositioning.actions/attempts`、`focus_original_public_refs` 保存原行号、行 SHA、JSON 路径和动作依据。
- 原输入均在 `raw/formal-stage1/map-05-run-1/brain/`：`rounds.jsonl` r105/106/107/110/112/114/116，`observations.jsonl` o513/515/517/526–529/548–550/566–568/582–584/600–610/703，及对应 `motions.jsonl`。观测序号与该文件行号一致。
- [脚本](scripts/diagnose_formal_public.py) 只流式读取公开 observations，并读取公开 rounds/motions/summary。复算使用 `--brain-dir <恢复的brain目录> --output <新JSON路径>`；拒绝覆盖、未完成摘要、序号缺口或读取期间文件变化。本次退出码 0，`integrity_findings=[]`；[stdout](raw/analysis/formal-public-diagnosis.stdout.txt) 和 [退出码](raw/analysis/formal-public-diagnosis.exit-code.txt) 均保留。

上述复核只解释公开执行链；不能由红框缺失反推物理遮挡原因，也不以诊断替代冻结评测器的最终报告。
