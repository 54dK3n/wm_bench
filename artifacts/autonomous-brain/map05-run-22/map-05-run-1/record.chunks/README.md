# 原始 record 无损恢复（说明 v1）

本目录的4个二进制分片按原gzip字节切分，没有重新压缩、删帧或改写record。原文件大小209536863字节，SHA256：

`75667a973758f596d23e1e5523fa85d7f4879bd03071452240fcd63e60d34d9f`

从仓库根目录运行：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/map05-run-22/map-05-run-1/record.chunks/manifest.json
```

恢复至 `artifacts/autonomous-brain/map05-run-22/map-05-run-1/record.json.gz`。工具校验每片和拼接结果的SHA256；若原文件已存在且匹配，则保留原件。该完整gzip被Git忽略，分片和manifest作为GitHub交付。

本次已实际恢复到临时文件并验证与原件一致，随后只删除临时恢复副本。证据见 `artifacts/autonomous-brain/map05-run-22/record-chunk-verification.json`。恢复完成后可按本局报告运行独立评测。
