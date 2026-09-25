# 抓取短距离操纵与实测归路修复

对应第九局真实失败：`map05-run-09/map-05-run-1/brain/observations.jsonl` 的 obs375–377。旧 Actions v11 从道路边缘对准后前进 2.5784 cm，短暂离路；此时距离和方位已符合原抓取条件，但 onRoad 条件拒绝 grab，且动作没有恢复入口。完整原始证据与独立 FAIL 结论见[第九局分析](../map05-run-09/FAILURE_ANALYSIS.md)。

## 行为变化

Actions v12 的 pick 必须从本次新鲜 onRoad 观测开始。随后允许有界抓取操纵短暂离路，与 place 采用同一实测路径返回算法；没有新增全局路径、道路 ID、布局或真值输入。只改操纵道路限制，不把离路判为已抓取。

- 原 CONFIRMED、入口距离 ≤65 cm、抓前记忆/里程计距离 ≤22.5 cm、方位绝对值 ≤3°、最多 3 次 grab、holding 与原位置 15 cm 范围复看证据均保持。
- 每步接近/重试仍最多 6 cm；前进要求本帧有限前方净空覆盖请求距离与 0.1 cm 传感器舍入余量。运动后检查里程计方向、侧向误差、转角、超行程与不足行程，不能用普通原语的 completed=true 代替移动证据。
- 30 cm 抓后分离改为 5 步、每步 6 cm 并观测。每一步都检查最新 holding；掉失即失败，不标记 HELD。若 grab 已产生持物但随后位姿检查失败，也保留该次尝试及待核验身份，不伪造成功。
- 成功或失败都记录 pick_trajectory；需要归路时只逆走本次连续实测的平移/转向，使用现有端点、方向、前方净空及无进展检查。无本次道路锚点不臆造路径。归路失败与抓取判定分开记录；保留抓取证据的 post_observation。
- Runtime v5 将请求距离、观测净空、实际位移与失败帧等有限字段放入下一轮状态，不把完整轨迹塞入模型上下文。

WorldModel、M5、确认采样门槛、放置几何门槛、模型参数以及 200 轮 / 1200 仿真秒上限未变。此次没有根据评测真值合并旧 LOST 身份或更改 done 条件。

## 验证与复算

新增测试使用第九局的传感器几何作为初始条件，局部道路走廊及抓取结果是明确标注的合成输入；不加载布局、真值或真实模型。相同 12 项测试在冻结 v11 为 12 failed，当前 v12 为 12 passed。它们验证了抓取操纵、最多三次、真实持物/旧位证据、失败归路、初始离路、净空不足、零位移及异常抓取后 pending 身份。见[复现说明](REPRODUCTION.md)与 `baseline-complete-tests.*`、`current-complete-tests.*`。

整体 Python 检查为 **382 passed**，源码在测试期间未变，见 `integrated-tests.json` / `integrated-tests.txt`。首次整体运行的 4 个失败也保留于 `integrated-before-tests.*`：3 个是沙箱禁止测试服务器绑定本地端口，1 个是测试仍断言旧 runtime 版本。更新版本断言并允许本地测试端口后全部通过；未调用真实模型或读取密钥。

```text
python3 -m pytest -q tests/test_brain_*.py
```

版本和每个改动文件 SHA256 在 `version.json`；对冻结提交的补丁在 `fix.patch`。新增测试文件独立保留，其哈希也在版本文件。当前离线通过不等于双球任务通过。下一次真实 map-05 使用新目录 `artifacts/autonomous-brain/map05-run-10`，旧局不覆盖。
