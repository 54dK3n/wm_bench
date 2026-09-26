# 阶段 1 正式局：抓放动作身份补充审计

本文件是运行后的诊断，不替换正式评测，不修改原始日志或冻结代码。正式全局 judge 的原结论仍为 **match 2、unverifiable 2**；原 evaluator v5 总体验收结果仍为 success=true。

## 方法与完整性

独立脚本先核对 evaluator SHA256 与正式评测记录一致，再核对 record、captures、summary、rounds、observations、motions 六个输入的 SHA256。随后原样调用 `evaluate_perception` 和 `evaluate_judge`，完整复现原全局 judge，包括两次 unverifiable。

对日志中全部四次 pick/place，统一取“从第一个观测到该动作 before_observation（含）”的全部观测前缀建立身份绑定，没有筛选有利帧、没有手工指定真值身份。动作结果仍由原 judge 使用完整原始动作窗口、执行记录、同 tick 原生样本及窗口内事件验证。前缀只限制建立身份时可用的历史，不截去动作结果或冲突原始记录。

此外，以冻结 `Actions.placement_evidence` 和 `ball_inside_region` 原函数重新计算两次 place 的实际同帧证据；原 0.64 内椭圆门保持不变。未将原生 2/2 代替脑端交付证据。

## 原全局歧义的具体来源

`target_017` 共 49 条唯一像素对应证据中，48 条对应 `guangyang-target-1`，只有 frame/observation 590 对应 `guangyang-target-2`。该冲突发生在 **round 110、tick 28756、575.12 仿真秒**，晚于第一球的抓取（round 21）和交付（round 45）。

frame 590 是第二次释放后的近场观测。脑端用 `matches_verified_placement` 将该大框临时标为 `known_delivered_object_id=target_017`；原像素几何对应规则则唯一匹配第二球。该帧没有喂入 WorldModel，也没有据此将第二球记为 DELIVERED。下一帧 591 记录了两个独立红球框：旧球正确对应 `target_017`，新球保留为未绑定交付候选。第二球经过 RELEASED_UNVERIFIED 后，在该新同帧证据满足要求时补确认交付；frame 592 的两个生命周期均为 DELIVERED。

这是已送达对象近场标签的一次可定位误贴，也是全局“一个 track 在全程只对应一个真值”规则把第一球两次历史动作都标为无法核验的原因。不能据此称全局轨迹身份从未出现歧义。

## 四次动作的历史证据

| 轮次 | 动作 | 全部历史前缀截止观测 | 自动绑定 | 原 judge 在该绑定下的结果 |
|---|---|---:|---|---|
| 21 | pick | 93 | target_017 → guangyang-target-1 | match |
| 45 | place | 243 | target_017 → guangyang-target-1 | match |
| 107 | pick | 540 | target_122 → guangyang-target-2 | match |
| 110 | place | 585 | target_122 → guangyang-target-2 | match |

每次 match 都包含原函数要求的动作内 grab/release 记录、夹爪前后状态、精确 tick 样本和对应原生抓取/交付事件，不是只看执行器 completed。

## 两次 place 的同帧交付证据

- **round 45 / frame 249**：唯一交付球框按原像素匹配规则对应 `guangyang-target-1`；0.64 门的计算值为 **0.0705117149995101**。重算候选数为 1，placement 与原记录完全一致。
- **round 110 / frame 591**：旧球框唯一对应 `guangyang-target-1`，其已送达标签 `target_017` 与动作前身份一致；新球框唯一对应 `guangyang-target-2`，未被标成旧球，是本次唯一交付 witness。两球在同一绿色区域内分别通过原 0.64 门，计算值为 **0.08604174924032237** 和 **0.2968370986920333**。旧球排除后候选数仍为 1，placement 与原记录完全一致，未发生旧球/新球交换。

两次选中的交付 witness 对应两个不同真值对象。该验证只在评测侧使用真值；报告和小型 JSON 均不包含真值布局坐标。

## 结论与限制

四次抓放动作的身份、窗口、实际效果与两次脑端同帧交付证据均可从本局原件复算。原全局不可核验项的原因已经定位，针对这四次动作没有遗留未解释的证据缺失；无需靠重复计数或原生交付结果替代脑端证据。

**原全局 judge 仍是 2 match / 2 unverifiable；补充前缀审计是 4 match。两者不能合并或替换。** frame 590 的脑端误贴作为残余问题保留，未在本局修复，也不能宣称全程关联无误。像素匹配仍保留原评测器“几何对应不能独立证明遮挡可见性”的限制。

## 复算

从仓库根目录运行以下命令，输出必须是不存在的新文件：

```sh
python3 artifacts/autonomous-brain/stage1-review-20260926/audit_action_prefix.py \
  --run-dir artifacts/autonomous-brain/stage1-review-20260926/raw/formal-map05/map-05-run-1 \
  --evaluation artifacts/autonomous-brain/stage1-review-20260926/raw/formal-evaluation/evaluation.json \
  --evaluator tools/evaluate_autonomous_brain.py \
  --out /tmp/action-prefix-audit-new.json \
  --summary-out /tmp/action-prefix-summary-new.json
```

紧凑指标与输入哈希见 `ACTION_PREFIX_AUDIT.json`；逐框诊断仅保留在 `raw/action-prefix-audit.json`，不进入 Git。独立脚本为 `audit_action_prefix.py`。若当前 evaluator 或动作源码发生变化，脚本拒绝继续，应先恢复对应冻结版本后在隔离目录复算。
