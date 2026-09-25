# 回放诊断01的原始record分片

原gzip 133,102,067字节，按50MiB切成3片：52,428,800、52,428,800、28,244,467字节。完整SHA256：`522817087316dbb3f64dea4ad1620bb3af1f0c5ffec5473284b751d1dc8bacf7`。分片仅切割原始压缩字节，没有解压重压。manifest保存原相对路径、长度、偏移及全部哈希。

仓库根目录恢复：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/placement-reobservation-replay-01/record.chunks/manifest.json
```

程序逐片及整体验证；相同原件可接受，不同文件拒绝覆盖。本机原件保留，仅精确忽略原gzip；临时隔离恢复已逐字节一致并清理。详见../archive-integrity.json。该诊断到75轮上限FAIL，复观测没有分离出新球，不计入正式运行成功。
