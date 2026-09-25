# Run19原压缩record的无损分片

原文件：`artifacts/autonomous-brain/map05-run-19/map-05-run-1/record.json.gz`，241,903,595字节，SHA256 `7119fb382ae5d3f7dbbf1457193470ffeca99ed5103111699f6425de20616591`。

五片按manifest顺序拼接：前四片各50MiB，末片32,188,395字节。分片直接来自原gzip字节，没有解压、重压或改变原文件。原gzip本机保留并精确忽略，不提交超过100MiB的单文件。

在仓库根目录恢复：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/map05-run-19/record-chunks/manifest.json
```

工具验证每片index／offset／长度／SHA256及完整文件SHA256；接受已有完全相同的目标，拒绝覆盖不同目标。归档已另建临时目标完成实际恢复、完整SHA256和逐字节比较，随后仅移除临时副本，见 `restore-checks.json`。

这些分片只打包原始证据，不改变Run19整体FAIL、实际有效交付1/2的结论。
