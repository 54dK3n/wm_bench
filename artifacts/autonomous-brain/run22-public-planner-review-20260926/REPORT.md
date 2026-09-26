# run22 公开规划前缀审查（仅 r1–76）

固定前缀显示：模型确实收到已成功到达的结果；r66–76 连续 11 次选择 `go_to(storage-zone_062)`，每次结果均为 `success=true / target_seen_at_standoff`。其中 r66 首次到达，r67–76 的 10 次再次导航没有推进仿真时间。r1–76 没有任何 `place`，因此这个前缀内的重复不能解释为放置失败后的恢复。

这份材料只审查已固定的 r1–76，不扩大前缀，不评价后续决策或整局最终结果，也不声称循环不会自行结束。

## 可复算证据

- 原始文件范围：`map05-run-22/map-05-run-1/brain/rounds.jsonl` 的前 76 个完整 JSONL 行；未读取尾部未完成行。
- 快照：`rounds-through-r76.jsonl`，3,008,110 字节。
- SHA256：`c3288a4a430acc37da9e6d337132e57ea2382dd49a69f8b192dedcc7862e5a63`。
- 当前提示词快照：`system-prompt.txt`；其 SHA256 为 `37c86124c0d1a1283a6e65c4f9cfb21547a19dfe51c6d4b6b67dea3cd4fc4c08`。
- 76 轮均验证：`llm_output.request_sha256` 可复算；实际请求中 user JSON 与该轮 `state` 完全一致；实际 system prompt 与保存的当前提示词一致；记录的模型动作与执行动作一致。
- `analysis.json` 保存逐轮校验、r59–76 时间线、r72–76 实际发送的完整 `recent_actions` 和提示词原文片段。

复算只读本目录快照，不访问运行中的文件或网络：

```sh
python3 -B artifacts/autonomous-brain/run22-public-planner-review-20260926/analyze.py
```

## 模型实际收到的内容

| 决策轮次 | 请求中的最近五轮 | 这五轮的共同结果 | 本轮动作 |
|---|---|---|---|
| 72 | 67–71 | 同一存放区，success=true，target_seen_at_standoff | go_to 同一区域 |
| 73 | 68–72 | 同上 | go_to 同一区域 |
| 74 | 69–73 | 同上 | go_to 同一区域 |
| 75 | 70–74 | 同上 | go_to 同一区域 |
| 76 | 71–75 | 同上 | go_to 同一区域 |

这些请求均含 `robot.holding=true`、`held_object_id=target_017`。最近动作中还保留 `object_id=storage-zone_062`、`evidence.holding=true`、观测帧号及该存放区的检测证据：距离约 34.8005 cm、方位约 −2.0365°、来源 `storage-ground-pixels`、同一 `track_id`。并非成功标志或原因在压缩时丢失。r72–76 的模型为 `deepseek-flash`，记录中没有 validation_error 或 transport_error。

重复阶段存在两组不同的距离表达：r67–76 的 `objects` 表一直给出 WorldModel 距离 42.4 cm、方位 −8.0°；最近成功导航的检测证据一直给出约 34.8005 cm、−2.0365°。r66–76 结束时均为 270.9 仿真秒、tick 13545；r67–76 决策前姿态均为 right=79.1 cm、forward=20.3 cm、heading=−138.2°。观测帧号增加并没有伴随这段仿真姿态变化。

历史失败不足以解释这里继续导航：r64 的同一区域导航曾返回 `known_route_exhausted_needs_exploration`；r65 探索后，r66 已返回成功到达。到了 r72–76，五轮窗口只剩成功到达的记录，且前缀内没有放置失败记录。

同一前缀还出现过较短的相似行为：r43–46 对 `target_017` 连续四次返回 `target_seen_at_standoff`，r47 才执行 `pick` 并成功。它支持“动作阶段转换延迟”这一观察，但不能证明本次原因完全相同。

## 提示词是否清楚

总体意图清楚：提示词明确写了“先 go_to 再 place”；`place` 自行依据绿色区域观测对准并放下；持物时应选择已确认存放区。没有要求持物后无限重新导航。

但阶段转换条件仍有可澄清处：

1. 没有出现 `target_seen_at_standoff`，也没有明确说明这个成功原因表示 `go_to` 阶段已完成、下一轮可以执行 `place`。
2. 提示词同时写“go_to … 25–40cm”和“依据当前 objects 中自己的 distance_cm”。这里 WorldModel 显示 42.4 cm，成功导航的视觉证据显示 34.8 cm；提示词没有解释应如何协调“记忆距离仍略远”和“执行器已基于观测报告到达”。这是可能的歧义来源，不能据此断言模型实际采用了某种推理。
3. 避免重复的指令针对“同一失败动作”；本段每次都报告成功，因此没有明确覆盖“重复已完成但没有新进展的子步骤”。

## 后续可验证的改进（本次未实施）

可在之后独立运行中先验证一个小幅提示词改动：解释 `target_seen_at_standoff` 的完成含义；在仍持物、最近对同一已确认存放区成功到达、且之后没有移动或相反观测证据时，把下一步明确指向 `place`；说明 `place` 仍会自行重新观测和对准，WorldModel 平滑距离略超范围本身不足以重复已经完成的导航。对未持物目标可对称说明成功到达后进入 `pick`。

这应由模型根据公开状态作出下一动作，保留放置控制器本来的观测校验；不应在本次运行中强行注入 `place` 或把重复动作冒充实际放置。另可在后续离线评测中统计“已成功到达后、位姿与时间不变的重复导航次数”，分别评估下一步规划是否改善。

未调用模型、未修改生产代码、未停止或操纵仿真；未读取 record、captures、samples、evaluation 或其他真值文件。当前证据不能判断 `place` 的物理执行在 r67 是否会成功，也不能唯一确定模型为何推迟阶段转换。
