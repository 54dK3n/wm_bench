# 原生 record 无损分片

原 `map-05-run-1/record.json.gz` 为 258,956,707 字节，SHA256 `a1f08d9cf500a3a6fa41d49d0dac79a8dff173157baf3e80119a64b9e2bdac82`。因超过 GitHub 单文件限制，按原 gzip 字节切成 5 片；没有删帧、解压重压或修改原件。已实际恢复临时副本并逐字节哈希核对，见 `restore-checks.json`。

从仓库根目录恢复缺失的原文件（拒绝覆盖已有文件）：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/map05-run-21/record-chunks/manifest.json
```
