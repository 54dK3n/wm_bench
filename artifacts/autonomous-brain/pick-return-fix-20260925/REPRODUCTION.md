# Run09 抓取操纵归路回归

本报告只使用 `artifacts/autonomous-brain/map05-run-09/map-05-run-1/brain/` 中的传感器日志和动作契约；未读取布局、真值或评测截图，未调用模拟器或模型。只新增 `tests/test_brain_pick_road_return.py` 和本目录证据；动作源码由主任务另行修复。

## 真实触发证据

- `rounds.jsonl` 第 72 轮到达成功；`observations.jsonl` 的 obs374/375 位姿为右向 −6.9cm、前向 163.8cm、朝向 106.9°。道路报告 onRoad=true、右侧净空 0.6cm、前方净空 24.3cm。
- 第 73 轮 `motions.jsonl` motion231 转向约 +5.7728°，obs376 朝向 112.7°，onRoad=true、道路方向误差 53.8°、右侧净空仍为 0.6cm、前方净空 23.9cm。
- motion232 前进请求 2.5784038755cm；obs377 实测位姿变为 (−9.3, 162.8)cm，移动约 2.6cm。此时 onRoad=false、右侧净空 −1.5cm。按当时道路方向误差计算，这段位移的侧向分量约为 2.08cm，超过先前 0.6cm 的侧向余量。
- obs377 的确认目标记忆距离为 21.992631cm，当前相机方位约 0.118947°，均满足原抓取对准门槛（≤22.5cm / ±3°）。旧动作仅因末尾 onRoad=false 返回 `visual_alignment_did_not_converge`，attempts 为空，未执行 grab。相机距离约 34.284569cm 与记忆距离是不同证据，不混用。
- obs378 至后续 obs385 仍停在该位置，空手且离路。本次动作有可验证的刚走过短直线路径，但旧 pick 未调用归路逻辑。该证据支持“操纵后缺少归路”，不支持宣称相机对准未收敛。

## 测试建模与目标行为

测试直接调用 Actions，初始位姿、目标记忆点及相机点取自 obs375；局部道路用该帧及 obs376 道路方向推导出的直走廊近似。直走廊宽度 18.4cm、初始横向偏移 8.6cm，运动按真实观测精度取整。抓取、受阻、丢持物及归路结果均为明确标注的合成情形，不是对真实地图或后续实跑的预测。

要求操纵从本次 onRoad 锚点开始，可沿已观测的有界短路径暂时离路；不放宽 CONFIRMED、≤22.5cm / ±3°、最多 3 次抓取或“持物且原位置消失”的判断。每次平移检查新鲜前向净空（前进）及实际里程计；30cm 验证退后分为最多 6cm 的步长并逐步观测。归路只逆走实测轨迹，结果单列，不改变抓取证据原始帧。

测试覆盖：对准后短暂离路的成功抓取与归路；3 次失败后归路；原位置仍可见时不能确认；已确认抓取与归路受阻分离；部分受阻仅回退实际距离；前方净空不足或缺测拒绝平移；completed=true 但零位移即停；未完成验证退后保持待核验身份；初始离路无锚点零动作；grab 已持物但位姿异常时保留尝试与待核验身份；验证结束已丢持物时不能成功。

## 证据与复算

冻结 v11 来源为 `9d74652735b3834ea7db2c07c64cbbbfdc5ecec3`，源文件哈希见 `baseline-source.json`。基线完整包在源码修改前复制到临时隔离目录；临时包不属于交付物，可由该 Git 提交重建。所有正式报告路径均相对仓库。原始 pytest 输出保持原样，仅作为原始执行证据，不把临时运行路径视为可移植报告路径。

使用 `PYTHONDONTWRITEBYTECODE=1`，在各被测包所在目录执行：

```sh
python3 -m pytest -q -p no:cacheprovider tests/test_brain_pick_road_return.py
```

原始 9 项结果保留在 `baseline-tests.*` / `current-tests.*`；补充位姿漂移及缺测后，11 项结果保留在 `baseline-final-tests.*` / `current-final-tests.*`。冻结 v11 为 11 failed，当前 v12 当时为 11 passed。这些失败存在共同的早期离路拒绝，因此不声称对应 11 个独立源码缺陷。

独立审查新增的“验证结束已丢持物”反例见 `holding-verification-baseline.*`：该时刻 Actions SHA 为 `804274ae3285189cde5cd93c6c508164c40b616f99fd3760c04adb6a301c711c`，最新 holding=false 但旧结果 success=true，定向测试 1 failed。最终完整结果与哈希另见 `baseline-complete-tests.*` / `current-complete-tests.*`。

最终同一份 12 项测试：冻结 v11 为 **12 failed（0.08s）**；修复后的 v12 为 **12 passed（0.04s）**，两个包在各自测试前后源码哈希均未改变。最终测试 SHA256 为 `000b1ef867db87fcdf59e99b3708288a64311583cfa03995349e14ab3a3b3689`；当前 Actions SHA256 为 `e2f685efe79770a9f715580419a3f574b6c6cbc64f3b8af927f3ddab9ac2b249`。

这些是局部动作契约回归，不证明下一次真实任务会完成。日志元数据逐次记录实际源哈希、测试哈希、退出码及测试期间源码未变校验。
