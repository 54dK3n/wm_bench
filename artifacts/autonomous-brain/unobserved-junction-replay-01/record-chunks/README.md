# 原始压缩记录无损分片

原始 `record.json.gz` 为222,137,867字节，超过GitHub单文件100MiB限制，保留在本机并仅精确忽略该路径。五个分片依次为四个50MiB及最后12,422,667字节，直接切分原gzip字节，没有解压重压或删帧。SHA256为 `617689e51ad4e76a64b16cc718ff08c7b0051c7a6a9b6f3b9f942f6f3c311ac6`。

从仓库根目录恢复：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/unobserved-junction-replay-01/record-chunks/manifest.json
```

目标缺失时原子恢复；已有目标完全相同时接受，已有不同内容时拒绝覆盖。工具验证每片顺序、偏移、大小、SHA256及总SHA256。已实际恢复到新临时文件，逐字节身份校验通过后删除此次临时副本，原始文件始终保留。结果见 `restore-checks.json`。本目录仅是140轮回放诊断归档，不是正式任务成功门票。
