# Run18原压缩record的无损分片

原文件：`artifacts/autonomous-brain/map05-run-18/map-05-run-1/record.json.gz`，262,553,008字节，SHA256 `7f7fd954b493410c95670f19d3d2b6e1f29e3a43cfb889398ba622d6a381fad3`。

六片按manifest顺序拼接：前五片各50MiB，末片409,008字节。分片直接来自原gzip字节，没有解压、重压或变更原文件。原gzip仅在本机保留并精确忽略，不提交超过100MiB的单文件。

在仓库根目录恢复：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/map05-run-18/record-chunks/manifest.json
```

工具验证每片index／offset／长度／SHA256及完整文件SHA256；已有完全相同目标可接受，不覆盖不同目标。首次归档已另建临时目标完成实际恢复、SHA256和逐字节比较，随后只移除该临时恢复副本，见 `restore-checks.json`。

这些分片仅打包原始证据，不改变Run18的正式FAIL结论。独立评测仍要求原record还原后与其余平台导出、公开brain记录一同使用。
