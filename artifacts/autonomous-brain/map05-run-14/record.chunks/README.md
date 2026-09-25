# Run14 原始 record 字节分片

原始 `map-05-run-1/record.json.gz` 为 133,111,051 字节，超过100MiB。这里按50MiB切割原始压缩字节；没有解压重压。三片长度分别为52,428,800、52,428,800、28,253,451字节。索引、偏移及各片SHA256见 `manifest.json`。

完整原始gzip SHA256：`bbb00e1104264cf837fc05669ed711244929d2dfd5d75eecc0b2714674099235`。

在仓库根目录恢复（父目录已随本归档存在）：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/map05-run-14/record.chunks/manifest.json
```

恢复程序校验每片顺序、长度及SHA256，再验证完整字节；已有完全相同文件可接受，已有不同文件拒绝覆盖。本机原gzip保留并仅对该精确路径忽略，不提交超限原件。归档已在隔离临时目录完成恢复、完整SHA及逐字节比较，临时副本已清理；见 `../archive-integrity.json`。

随后可重新离线评测：

```sh
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-14/map-05-run-1 --out artifacts/autonomous-brain/map05-run-14/recomputed-report
```

评测退出码1对应完整的FAIL报告。该局两球实际有效交付，但大脑未自主完成；分片恢复与导出完整性不改变任务结论。
