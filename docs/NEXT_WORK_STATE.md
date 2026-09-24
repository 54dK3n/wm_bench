# A → B → C → D 执行状态

本轮按用户新要求顺序执行。A 不跑仿真；B 完成后才开始 C；C 十布局行为等价验收通过后才开始 D。C 与 D 各最多三轮，不放宽门槛，不运行赛题1。

- A：已完成。DEMO/README相对链接、四关键帧、两球WM故事及可复算数值已保存；原证据未变，不做可选重跑/录屏。
- B：已完成。两个PR均合并，主仓fef0ba9b754ce9652836fdb720d1162dcadbc5ef。全部168测试和迁移基线原130测试通过；vendor锁定主仓，旧GY配置35场景168操作相等。
- C：第 1 轮未通过，暂停。模块化源码及预检完成；十布局原生 inputs 相等 0/10、events 相等 5/10、得分相等 8/10，程序错误 0。首个分歧均在感知返回；保存的首帧图像已有差异。未改平台动画、未换旧基线、未开始第 2 轮。见 [报告](../artifacts/inloop/refactor/SUMMARY.md)。
- D：未开始。仅在 C 通过后按 opt-2b 开始，最多三轮。

基线：`artifacts/inloop/opt-2/round-3/program.py`，SHA256 `59d8f617a7fd82135b710b6a32cf112b4c17c80aa770beb59407aa50d5cf17e6`。历史原始证据与冻结程序不得覆盖。B完成提交为 `40eebe2`。

原 demo 与 opt-2 round-3 是不同程序和不同运行。A 的文字与图片使用 demo 原局；不把后续程序的 SHA 写成 demo 身份。


C首轮程序：`wm-refactor-r1-20260924`，文件SHA256 `b31ed3b4c1ad4abe1a162526bdf07174e3259afc2d4d5c977b1e27e384e11381`。源码冻结提交 `4b26cf2`；正式预检630项Python及19项Node测试通过，批跑期间273项冻结文件未变。全部十局已完成并比较，执行台账为 `artifacts/inloop/refactor/round-1/progress.json`。

当前需要明确的范围：是否单独修复平台感知的浏览器时间依赖，并在同一修复环境重新运行旧程序建立对照基线，再按原 inputs/events/得分逐条相等门限检查新程序。此举改变环境及对照基线，超出 C 的“只整理代码、不修行为”；未经明确授权不执行。旧 opt-2 round-3 和本轮 FAIL 均须保留。
