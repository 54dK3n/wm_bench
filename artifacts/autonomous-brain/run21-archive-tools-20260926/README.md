# 完整终局归档脚本

版本 `completed-run-metrics/v1`。脚本只接受 driver 已 complete 且有大脑摘要、独立评测和严格离线模型回放的目录，拒绝覆盖原有归档结果。校验 8 项冻结 Git 源码、5 项导出压缩及展开哈希、全部原始文件未变，并从公共逐行记录重新计算轮数、调用耗时、动作失败和探索提示使用情况。

`dry-run-check.json` 记录在已结束 Run20 上的只读校验：输出函数替换为内存收集，未写入该局。脚本不接触模型、机器人或配置密钥，不修改生产源码；终局物理结论引用独立评测结果，不能把观测中的 DELIVERED 状态直接当真值。

从仓库根目录运行，须先完成独立评测及 LLM 回放：

```sh
python3 -B artifacts/autonomous-brain/run21-archive-tools-20260926/archive_completed.py --run artifacts/autonomous-brain/map05-run-21 --source-commit 1d9b0a79aed7a67a539a03a2c7d5b181bbcbec21
```
