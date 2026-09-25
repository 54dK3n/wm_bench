# 已确认归档身份的重获修复

第十三局在首次红球确认后出现LOST归档。原大脑既不重新关联该归档ID，又永久把曾确认LOST列入待处理；离线纯传感反例证明，新轨迹重新确认和交付也不能解除旧义务。本局按失败保留，不断言其两个WM轨迹对应同一真实球。

修复只增加身份关联及完成证据，不改变操纵/导航方法、官方WM依赖、M5、原30cm关联门控、40–90cm原始测距窗口、三位置相距至少15cm、抓放标准或运行上限。新轨迹独立确认后才可在完整竞争图中双向唯一绑定历史身份；近场帧、歧义、操作过的身份及未确认轨迹均不可绑定。

旧ID、LOST状态、位置和时间线保留，新ID继续独立跟踪。历史义务只在有效无歧义绑定链的后继已经按原动作与观测证据DELIVERED后解除；不提前把历史行改成DELIVERED。这个关联是假设，最终真值评测仍必须核对两球。

| 验证 | 结果与证据 |
|---|---|
| 冻结旧源码、新定向测试 | 6失败、32通过；`baseline-tests-v3.txt`、`baseline-validation-v3.json` |
| 定向候选 | 38通过；`candidate-tests-v1.txt`，保留当时源码摘要 |
| 最终整合 | 485通过；`integrated-tests-v2.txt`、`integrated-validation-v2.json`，运行前后源码未变 |
| 第十三局传感复放 | 365帧，除版本号外感知逐字段一致，物体表一致，重获绑定0；`run13-sensor-replay.json` |
| v10真实模型记录由v11客户端回放 | 58轮、69条调用全部一致，网络/环境读取0；`v10-llm-replay/replay-checks.json` |

初版测试夹具的相对距离断言及越界像素框错误保留在`baseline-tests-v1.txt`，修正说明在`BASELINE_REPORT.md`；没有调整产品门限来通过测试。相关初次沙盒回归有3项本机HTTP监听被系统权限阻止，其余241项通过；允许本机监听后的最终全套485项通过。`integrated-tests-v1.txt`保留前一候选结果，最终以v2源码快照为准。

独立审查见`INDEPENDENT_REVIEW.md`，基线与定向说明见`BASELINE_REPORT.md`、`CANDIDATE_TEST_REPORT.md`。所有验证均不是map-05双球成功证据；下一正式运行使用新目录`artifacts/autonomous-brain/map05-run-14`。

| 源码 | 版本 | SHA256 |
|---|---|---|
| `autonomous_brain/perception.py` | v7 | `5c266e7cd9c87fbc322333691b28d0014cbd08553ed8046f2073b0be4802ba89` |
| `autonomous_brain/actions.py` | v15 | `3340604b8ac73051f1232b4314c02fe491ec468de72aa38038ac7769d419d2a2` |
| `autonomous_brain/run.py` | v7 | `a193194c19fd6527bafd38b19d09a02a584162c5480c7667ff5e4a7f0bdfc4f6` |
| `autonomous_brain/llm.py` | v11 | `ffac80ec63d8217622445b61c4a5f137380bec9662aebad13e087ce308d6b3e1` |

完整机器可读版本表见`source-versions.json`。报告与证据路径均相对仓库；历史失败文件不改写。
