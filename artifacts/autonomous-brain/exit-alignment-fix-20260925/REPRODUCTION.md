# Run10 出口转向与受阻优先级回归

证据只来自 `artifacts/autonomous-brain/map05-run-10/map-05-run-1/brain/` 的动作、传感器与状态日志。未读取布局或真值，未操作模拟器，未修改 `autonomous_brain` 源码。

## 现场证据

原始字段摘录及 JSONL 行号见 `run10-sensor-evidence.json`。

- r43 开始 obs239：位置 (右99.8cm, 前5.5cm)，heading169.6°，onRoad=true、atNode=true、atJunction=false；唯一出口相对角−102°，对应绝对heading67.6°，front4.7cm。
- r43 `take_exit(-102)` 原始结果为 `front_clearance / distanceCm8.7 / elapsedTicks70`。obs240 到达 (93.6,0.4)cm、heading−145.2°，仍 atNode=true、atJunction=false，唯一出口相对角−147.2°仍对应同一绝对heading67.6°，front0.1cm。但脑结果为成功 `next_junction_observed`，吞掉了受阻结论。
- r44/46/47/49/50/52/53 均重试相同绝对出口，原始结果每次 `front_clearance / distanceCm0 / elapsedTicks0`，位置及累计里程1552.1cm不变。这不是 `junction / 0cm` 的正常到达，也不是尝试多个不同出口。
- r45 扫描 obs247、r48 扫描 obs259 均在同位置观测到 heading34.8°、road headingError0.2°、onRoad=true、front292.4cm，随后360°扫描又返回 heading−145.2°和front0.1cm。因此日志证明当前动作选择循环受阻，不能据此宣称所有物理方向永久阻断。

r43 的短距离并非单独错误：近路口可能只需小步。错误是显式受阻结果优先级低于持续存在的 atNode 标志，以及下一次选择出口时没有先建立当前可用朝向。物理出口是否能走通仍要由后续新鲜传感器和真实执行验证。

## 回归契约

`tests/test_brain_exit_alignment.py` 直接调用 explore/go_to。合成 actuator 的 turn 本身不更新状态，只有随后的 observe 发布新 heading 与出口，确保动作必须等待新观测。

- 从 r44 的旧heading及front0.1cm开始，先向已观测出口转向。模拟2°实际转向残差后，新观测出口角为2°；take_exit 必须使用该新角，保持原绝对heading67.6°，不能继续使用−147.2°或假定为0°。
- explore 和 go_to 两条入口均要求新观测中存在唯一同一绝对出口，沿用5°角匹配范围。出口消失、多个匹配、唯一候选偏差6°均拒绝平移；新观测离路或不再atNode同样拒绝。
- `collision`、`front_clearance`、`off_road`、`wrong_way` 优先于 atNode 与正移动距离；保留原始 actuator_result。follow_road 的相同冲突也不能误报到达。
- 零距离受阻保持失败；6.4cm 的明确 `junction` 保持成功，不引入最小15cm到达门槛。

## 基线与复算

完整 v12 包在主任务修改前复制到临时隔离目录；临时包不交付，可从提交 `27d3a4eb3eed854d8101c837bbaf3aafa2e09f18` 复建，源哈希见 `baseline-source.json`。正式元数据不包含临时绝对路径；原始测试输出作为原始执行证据保留。

在各被测包目录设置 `PYTHONDONTWRITEBYTECODE=1` 并执行：

```sh
python3 -m pytest -q -p no:cacheprovider tests/test_brain_exit_alignment.py
```

冻结基线结果为 **14 failed、3 passed（0.06s）**，见 `baseline-tests.txt` / `baseline-tests.json`。3个通过对照分别为旧逻辑已拒绝off_road、零距离受阻仍失败、真实6.4cm junction仍成功。多项失败覆盖同一底层行为契约，不代表14个独立缺陷，也不证明修复后整局将完成。

主任务导航 v13 修复后的同份测试为 **17 passed（0.03s）**，见 `current-navigation-tests.txt` / `current-navigation-tests.json`。该次 Actions SHA256 为 `49641a58d79c33ea4ea9cca2a8edc20979901a0276de9f159c681b2c3eaa7e34`；测试 SHA256 为 `4af2981b6e7711bbdf2702f33cbf3a284d4e458620fa2891d042e69e3ef02379`。两次测试各自前后源哈希均未变。本结果只覆盖该次导航修复，后续其他动作变更需由主任务单独记录最终综合验证。
