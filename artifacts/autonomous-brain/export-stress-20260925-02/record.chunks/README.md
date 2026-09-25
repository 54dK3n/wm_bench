# 原始 record gzip 分片

这是本地固定应答导出诊断02的字节归档，**不代表真实模型试验或任务验收通过**。完整上下文见 `../DIAGNOSTIC.md`；验证结果见 `../archive-checks.json`。

`manifest.json` 使用 `wm-evidence-chunks` version1。目标原始文件为 `artifacts/autonomous-brain/export-stress-20260925-02/map-05-run-1/record.json.gz`：115,695,381字节，SHA256 `7d05a534380ccefe1ae4b6f59aaa91ebbac519df40ebfc2662a19591cf38462e`。

| 文件 | 零起始偏移 | 字节数 | SHA256 |
|---|---:|---:|---|
| chunk-000000.bin | 0 | 52,428,800 | 19c69aa2a4d8167e8b233455f1499f2463d8ab716af244a942fde7fd08e771eb |
| chunk-000001.bin | 52,428,800 | 52,428,800 | 05736bd29bf5d73c1434d0759fc99adcd031996349530c34ff6064feabe76661 |
| chunk-000002.bin | 104,857,600 | 10,837,781 | 6deb43d0803b035e5aca51105af49c53779c071a9a2b96a11056d0b569f98c73 |

分片直接取自原始压缩字节，没有重新压缩；每片小于100MiB。原gzip保留在本地，并通过单个精确路径被Git忽略。

从仓库根目录恢复：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/export-stress-20260925-02/record.chunks/manifest.json
```

父目录须存在。工具按 manifest 顺序验证每片及全文件SHA256，再原子发布恢复文件；已有完全相同原件可接受，不同原件不会被覆盖。

仓库外临时恢复已经通过总长度、SHA256及流式逐字节比较，临时副本已清理。应保留此目录的三个分片、manifest和说明；不要把超过100MiB的原gzip强制加入Git。
