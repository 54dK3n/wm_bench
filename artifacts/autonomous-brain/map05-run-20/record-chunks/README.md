# 原始压缩记录无损分片

原始`record.json.gz`为322,036,353字节，超过GitHub单文件100MiB限制。七个分片直接切分原gzip字节（六片50MiB，末片7,463,553字节），没有解压重压、删帧或改变PNG。完整SHA256为`c2295736ba0744639d85780586be0dbb040979a421ee1e6134a0b4ec661cb7bf`。

从仓库根目录恢复：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/map05-run-20/record-chunks/manifest.json
```

工具验证各片顺序、偏移、大小、SHA256及整个文件SHA256；已有完全相同目标时接受，已有不同目标时拒绝覆盖。已实际恢复到新临时文件并验证身份，核验后仅删除此次临时副本。原gzip保留本机，`.gitignore`只精确忽略本局这一原始文件。`restore-checks.json`保存大小与原/恢复哈希。
