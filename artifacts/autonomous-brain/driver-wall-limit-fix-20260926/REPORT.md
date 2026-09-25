# 默认关闭额外墙钟超时

版本：driver v6；独立评测器 v4仅增加对driver v6来源格式的兼容。大脑、LLM、WorldModel、动作和平台源码不变。

## 原因与范围

正式Run18使用冻结提交`258ebab8555344805eabd1c5b2fe4773d97d7df2`的driver v5。该运行器默认在7200秒墙钟后终止子进程。Run18的原始`process`记录为`driver_wall_timeout`、SIGTERM、7200.663秒；当时已完成167轮、855.94秒仿真。用户规定的200轮和1200秒仿真均未达到，实际停止来自额外墙钟限制。

Run18的五项平台导出完整，但子进程没有生成`brain/summary.json`；第168轮只保存起始观测，没有对应模型终态或动作。已有200条完整模型记录不等于可证明服务端请求总数；不能补造可能尚未落盘的请求、耗时或摘要。本修复不改写原局FAIL，完整证据见`artifacts/autonomous-brain/map05-run-18/`。

v6默认`wallTimeoutSeconds=0`，只在显式设置正值时启用诊断墙钟限制；0表示禁用，负数和非有限值拒绝。有效设置写入driver summary、trial和process元数据。200轮/1200秒仿真参数校验、传给大脑的上限、仿真tick监测、后端停止、监测错误及子进程清理均保持。

这不更改LLM的180秒连接/读取等待、有限网络重试、输出修正次数、Kimi温度0.6或任何成功判据。连接/读取等待不是整次SSE请求的绝对墙钟上限。

## 验证

- 原v5固定Git源码：11项新增行为检查中9通过、2失败，分别复现默认7200秒误终止和显式0不被接受。源码副本、退出码和输出见`test-baseline-v5-*`。
- v6整合Node检查24项全部通过，包括虚拟墙钟跨10800秒仍正常退出且逐次监测仿真、显式诊断上限、1200秒仿真停止、后端停止、监测异常、必要时SIGKILL清理、非法或降低上限。虚拟时钟测试不是实际运行三小时。
- 独立评测与runtime最后允许轮边界64项通过。评测v4仅接纳同结构的driver v6；缺摘要、未done或源码不一致仍不能通过。
- 全部检查前后记录的源码SHA相等；完整命令、输出及哈希见`integrated-tests-v1.json`。
- 本地假模型短流程见`artifacts/autonomous-brain/driver-wall-limit-smoke-20260926-01/`：3轮、4条假响应、14次观测、6.26仿真秒；第3轮一次非法输出修正仍失败，按预期停止；大脑摘要和五项平台导出完整。14/14桥检测与内部检测一致；红1、蓝5、障碍49、存放区3。该fixture显式使用600秒诊断墙钟、5轮上限；默认关闭由上述行为测试验证。没有调用Kimi，不作为任务验收。

## 来源

| 文件 | SHA256 |
|---|---|
| `tools/autonomous_brain_driver.js`（v6） | `4844ff6aeb7c09fcc11a8d6ca2d46ae819ae047c668c6a3cb81591d686f4bc6a` |
| `tools/evaluate_autonomous_brain.py`（v4） | `69e4f719afb536af72b55feb0c42835106c633c0491d4725fd9ed549965dccd7` |
| `tools/tests/test_autonomous_brain_limits.js` | `0b97a51b14ce5be51de766169d3a52e66b8ccee0dc16bc091729f801383c91c2` |

正式复跑必须使用新的输出目录，保留200轮/1200秒仿真上限；不得恢复被终止的旧局或把旧2/2物理交付改判完整任务成功。

发布时仅把新增测试输出中的本机仓库路径前缀规范为相对路径；断言、数值和通过/失败计数未变。原始与规范化输出SHA及替换次数见`test-baseline-v5-meta.json`。首次发布扫描记录路径问题，保留为`publication-checks.json`；最终扫描另存。旧Run18日志未参与该转换。
