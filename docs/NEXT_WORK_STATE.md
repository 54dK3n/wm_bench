# A → B → C → D 执行状态

本轮按用户新要求顺序执行。A 不跑仿真；B 完成后才开始 C；C 十布局行为等价验收通过后才开始 D。C 与 D 各最多三轮，不放宽门槛，不运行赛题1。

- A：已完成。DEMO/README相对链接、四关键帧、两球WM故事及可复算数值已保存；原证据未变，不做可选重跑/录屏。
- B：等待用户确认回流范围。origin/main=6a813a34，内容等价于vendor历史bd9e6bb，但缺cecca85→0ea6539相机/安全前置提交。原主仓49项测试自身全过，在vendor上39过/10失败；vendor157项全过。ad237还改通用Fov/衰减类参数/LOST查询，不能声称默认完全不变。已询问拆分前置依赖PR与广阳岛功能PR，或严格仅移植两项功能；确认前不改实现、不进入C。
- C：未开始。模块化单一源码、删除被覆盖/不可达代码、相对路径、真实 worker 冒烟及重复定义检查；十局 inputs/events/得分对 opt-2 round-3。
- D：未开始。仅在 C 通过后按 opt-2b 开始，最多三轮。

基线：`artifacts/inloop/opt-2/round-3/program.py`，SHA256 `59d8f617a7fd82135b710b6a32cf112b4c17c80aa770beb59407aa50d5cf17e6`。历史原始证据与冻结程序不得覆盖。当前 Git 基线 `330d6d7`。

原 demo 与 opt-2 round-3 是不同程序和不同运行。A 的文字与图片使用 demo 原局；不把后续程序的 SHA 写成 demo 身份。

B独立兼容检查输入和日志临时保留：`/private/tmp/wm-main-tests-vendor-20260924-3rtabf1r/`；主仓隔离克隆：`/private/tmp/wm-bench-worldmodel-integration-20260924`。尚未push任何WorldModel分支/PR。
