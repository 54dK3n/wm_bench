# 放置前选点回放诊断01的原始record分片

原gzip 128,929,981字节，按50MiB切成3片：52,428,800、52,428,800、24,072,381字节。完整SHA256：`9016f23998dfddd0e1260fab69ce19a68d701d45671f24fdba49586ff62617e2`。分片仅切割原始压缩字节，没有解压重压。manifest保存原相对路径、长度、偏移及全部哈希。

仓库根目录恢复：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/release-free-point-replay-01/record.chunks/manifest.json
```

程序逐片及整体验证；相同原件可接受，不同文件拒绝覆盖。本机原件保留，仅精确忽略原gzip；临时隔离恢复已逐字节一致并清理。详见../archive-integrity.json。该诊断的放置前选点与后验见证成功，但到75轮上限仍FAIL，没有自主done，不计入正式运行成功。
