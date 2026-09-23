# A → B → C → D 执行状态

本轮按用户新要求顺序执行。A 不跑仿真；B 完成后才开始 C；C 十布局行为等价验收通过后才开始 D。C 与 D 各最多三轮，不放宽门槛，不运行赛题1。

- A：已完成。DEMO/README相对链接、四关键帧、两球WM故事及可复算数值已保存；原证据未变，不做可选重跑/录屏。
- B：已完成。两个PR均合并，主仓fef0ba9b754ce9652836fdb720d1162dcadbc5ef。全部168测试和迁移基线原130测试通过；vendor锁定主仓，旧GY配置35场景168操作相等。
- C：未开始。模块化单一源码、删除被覆盖/不可达代码、相对路径、真实 worker 冒烟及重复定义检查；十局 inputs/events/得分对 opt-2 round-3。
- D：未开始。仅在 C 通过后按 opt-2b 开始，最多三轮。

基线：`artifacts/inloop/opt-2/round-3/program.py`，SHA256 `59d8f617a7fd82135b710b6a32cf112b4c17c80aa770beb59407aa50d5cf17e6`。历史原始证据与冻结程序不得覆盖。当前 Git 基线 `330d6d7`。

原 demo 与 opt-2 round-3 是不同程序和不同运行。A 的文字与图片使用 demo 原局；不把后续程序的 SHA 写成 demo 身份。

B独立兼容检查输入和日志临时保留：`/private/tmp/wm-main-tests-vendor-20260924-3rtabf1r/`；主仓隔离克隆：`/private/tmp/wm-bench-worldmodel-integration-20260924`。此前未push；当前已推前置分支，建PR中。
