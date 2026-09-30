# 运行中监控恢复已修复；本局双球 FAIL，已停止

**未跑通双球。** 新局 `run-20260930T180642` 在 r1 模型连接建立阶段结束：6 次既有有界请求尝试全部 `URLError → ConnectionResetError / errno 54`，0 字节、无 HTTP 状态、无有效模型回复。无认证的官方 HTTPS 检查同样被重置；底层原因 **UNKNOWN**，不归因为账户、API计费或平台崩溃。未修改网络/账户/模型配置，未开第二局。旧两次一球 PASS、旧双球 FAIL 和原件缺失事实保持。

**运行源码** [`e54ad6106123770880f407c82d2d3b9b2e75c5cd`](https://github.com/54dK3n/wm_bench/commit/e54ad6106123770880f407c82d2d3b9b2e75c5cd)：`runBrain / RunningMonitor` 增加最多一次、总计8秒的运行中只读恢复，仅原 endpoint/target；核对平台 run ID、原页面对象、nonce、受限桥认证及控制器代次。`MonitorGuard.next/pause/waitSettled/resume` 同步撤销原桥 pending poll，阻止下一条命令分发；在途命令只查询原 requestId，结果不明、身份不符、后端异常或预算到达均停止。保留原模型请求、脑进程、Runtime/WM/Executor，不重发运动。诊断保留异常栈/cause、待处理CDP请求和关闭阶段；v13沿用原严格评测门，并锁定新辅助文件哈希。未改平台或机器人权限。

初次独立 evaluator **异常退出1，未生成完整判定**：`audit_done_bytes` 解码空模型响应时崩溃。单独提交 [`4cf908e4afe6134a9619dfa9a119fc0c5caa06f9`](https://github.com/54dK3n/wm_bench/commit/4cf908e4afe6134a9619dfa9a119fc0c5caa06f9) 只让缺失/非文本响应明确拒绝 done；在新输出目录复算，正式双球 **FAIL / exit1**。初次 traceback、退出码、冻结清单和原局字节未改，复算未重跑平台或模型。

| 同一局实测 | 结果 |
|---|---:|
| 模型请求尝试 / 有效模型回复；Executor dispatch / judge | 6 / 0；0 / 0 |
| 观测 / 桥请求；仿真秒 | 1 / 5；0 |
| 高层pick / 物理grab / 观测HELD / release | 0 / 0 / 0 / 0 |
| 脑端DELIVERED / 独立合格物理交付 / 模型done | 0 / 0 / 0 |
| 最终夹爪 / 白名单外调用 / 未知动作结果 | 空 / 0 / 0 |
| driver / 初次evaluator / 修复后evaluator退出码 | 1 / 1（ERROR）/ 1（FAIL） |

平台 run ID `run-e8172af7-1409-4c82-8448-aab5b4c13219`；Executor `089e308c8d5c4a45aa58a6c804a83f13:1`。5条桥请求仅为初始化传感器，均唯一分发并完成。`interrupted=null`，无运行中CDP故障；监控恢复、持球运输、抓放/done及第二球采样均 **NOT_EXERCISED**。不以局部恢复测试替代搬运实测。record、samples、sensor-audit、captures、envelope五项完整。

**配置未变。** 官方 `https://api.deepseek.com/v1`，`deepseek-flash / temperature=0 / thinking=disabled`；平台 `54b36f82109836226cf654e9a676ddf0c3b07cd0`；既有框架无关 Executor `33af31baefc9b3beaa855f33849d52254aaa8c4b`、max_retries=0；实际vendored WM树 `10895f70be67c9d70b1073256d7e264451934c8d025a11a82128bb7ad956cd7c`，逐文件哈希见FROZEN_INPUTS及原manifest。200轮/1200秒、白名单及确认抓放门均未放宽，真值仅评测使用。

**针对性检查。** 真实Chrome+真实子进程、受控页面/决策夹具19/19通过，覆盖模型请求/排队动作/在途命令、身份变化、停止、预算、浏览器/目标消失和超时；同一PID、单次模型生命周期及请求/分发各一次。冻结桥门9/9；既有driver集合44/44（含8个重叠桥门案例），原导出重连2/2；源码/运输152/152；空响应修复相关101/101。原输出与命令见 `raw/checks/`，不合计重叠测试，不称为比赛成绩。

实际入口（该目录已存在，禁止覆盖）：
```sh
OUT=artifacts/autonomous-brain/two-ball-monitor-next/run-20260930T180642
node tools/autonomous_brain_driver.js --maps map-05 --runs 1 --platform-root workspaces/guangyang-platform/projects/car-python --orchestrator-root workspaces/octos_robots --task '把两个红球送到绿色存放区' --out "$OUT"
PYTHONPATH=vendor/wm_kit_opt2:. PYTHONDONTWRITEBYTECODE=1 python3 tools/evaluate_autonomous_brain.py --input "$OUT/map-05-run-1" --out "${OUT}-evaluation"
# 仅更换为4cf908e评测修复后，在新目录复算原输入：
PYTHONPATH=vendor/wm_kit_opt2:. PYTHONDONTWRITEBYTECODE=1 python3 tools/evaluate_autonomous_brain.py --input "$OUT/map-05-run-1" --out "${OUT}-evaluation-null-response-fix"
```

**证据与恢复。** [本轮Release](https://github.com/54dK3n/wm_bench/releases/tag/two-ball-monitor-20260930-e54ad61)，发布校验见DELIVERY.json；Git只保留摘要、哈希与恢复入口。下载tar.gz及同名.sha256到新目录，先 `shasum -a 256 -c wm-bench-two-ball-monitor-20260930-evidence.tar.gz.sha256`，再解压到空目录并在解压根执行 `shasum -a 256 -c artifacts/autonomous-brain/two-ball-monitor-next/SHA256SUMS`。按上方独立评测入口与对应依赖，在另一新输出目录复算；公开日志计数复算入口见METRICS.json。已停止，不进入阶段2、十布局或真机。
