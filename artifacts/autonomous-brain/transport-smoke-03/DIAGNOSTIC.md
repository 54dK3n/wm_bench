# 外部大脑传输联调（诊断 fixture）

**这不是任务验收：使用本机假模型 diagnostic-stub，没有调用真实大模型。**

平台、外部 Python 大脑、WorldModel、机器人桥及真实相机检测均运行实际代码。假模型只依次返回 explore、look_around、非法 JSON、非法 JSON；预期大脑在第三轮一次修复失败后停止。

传输检查：PASS。任务验收：未执行。

数值和全部检查见同目录 `diagnostic-checks.json`；完整假模型请求/响应见 `diagnostic-fixture.json`；真实平台及脑日志见 `map-05-run-1/`。

复核命令：

```sh
python3 tools/smoke_external_brain.py --out artifacts/autonomous-brain/transport-smoke-03 --verify-only
```
