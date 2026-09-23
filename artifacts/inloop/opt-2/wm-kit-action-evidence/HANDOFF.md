# WM 动作证据撤销：交付

基线提交 `ad237a143f0d35e100a28c15567d4b75bd56cccf`；新提交
`326a5f8892b9da11996b5f3d3d0fc56341aca6e4`。
隔离源 `/Users/ken/Desktop/wm_bench/vendor/wm_kit_opt2`，仅更改 API、14 项单测及说明文档。
原 `/Users/ken/wm_kit` 的 HEAD、tracked 工作区保持不变；其未跟踪验收工具没有带入克隆。

全 tracked WM 回归 **157 passed**。这些是软件单测，不是任务布局实测，也不宣称相机自然衰减通过 P2.5。

`mark_removed(exact_id, now)` 在调用方已用公开持球状态确认选中目标后，
将其原位置轨迹置 `confidence=0 / LOST` 并归档。重复调用 True 且零副作用；
未知 ID、类别或别名 False；非有限时刻拒绝。位置、最后看到时刻、帧信息、命中和位姿
历史全部保留，其他对象及其融合结果不变。此动作证据不证明目标已经送达。

ZIP SHA256：`61308c1c20270ec31d8ee5870ed2b01bf6920075e4820e5fc8c30bd2e626f1fb`。
`manifest.json` 列出全部 14 条目、文件 SHA、bundle SHA 与执行验证命令。
`wm_kit_opt2.bundle` 含完整提交历史，已通过 `git bundle verify`。

复核（不运行仿真）：

```sh
cd /Users/ken/Desktop/wm_bench/vendor/wm_kit_opt2
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest tests/ -q
cd /Users/ken/Desktop/wm_bench
PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/wm-kit-action-evidence/package.py
```

主程序集成由根代理负责：保持原公开持球验证后，仅对锁定的 exact track ID 调用 API，
记录动作前/后状态；不得读取 target 真值、改融合或制造漏检。现有嵌入工具可直接使用
`--src /Users/ken/Desktop/wm_bench/vendor/wm_kit_opt2`，从该提交读取包字节。
