# opt-2 独立运行前审查

审查程序 SHA256：`203e7a8acfa041064f341b6103b1fda4f80cc64b304ca3ae628e34844d79ca0e`。
**未发现确定的阻断缺陷。** 此结论仅覆盖这个构建版本；没有运行任务仿真。

|检查|证据与结论|
|---|---|
|平台异步转换|使用当前 `python-worker.js` 的原始 `AsyncRobotTransformer` 编译完整程序；转换后没有含 `await` 的生成器或 lambda。|
|真实新桥接执行|转换后的完整 selector/flow 配合真实新 WM 包执行双轨迹软件用例；物理动作明确使用测试替身。两次 exact ID 的 `mark_removed` 均 True/0/LOST，归档后选择另一 ID；实际100cm输入在送达区域过滤器中仍保留。此用例不构成真实抓取/送达成绩。|
|固定逻辑|25 个原 nav/motion wrapper、observe 位移守卫、query、M5正反算、WM入口、三命中记录/确认与抓前graph导航函数，AST与opt1-r2逐项相同。`counted_observe`仅在完整原始日志及原过滤后增加已送达区域排除；全局observe计数和运动守卫不清零。|
|确认与抓取|`approach_target_with_world_model` 的原确认后接近、≤0.25m、≥30cm记忆行驶及 `max_steps=1` 前置检查保留；最终抓取循环改为有界原地角度恢复。每球 approach 计数重置，限值仍3。|
|WM动作证据|`opt2_flow_fragment.py:210` 先要求接近/抓取返回成功；新抓取循环所有成功出口均在公开holding为“目标物”且原记忆行驶指标通过后。`opt2_flow_fragment.py:219`起取得当前公开tick、调用同步包API并记录0/LOST。嵌入包不经过学生AST改写，`wm.mark_removed`的同步属性调用正确。|
|布局与真值|AST目标锚点扫描通过；主程序和全部14个嵌入Python文件无已知布局坐标对。合法obstacle过滤及公开storage锚点保持。新片段没有布局名分支；offline choice的真值读取留在driver工具，未嵌入程序。|

常数来源：新 `TURN_COST_K=0.060290462706043484` 为冻结12次原生协议的测量结果，根代理另行决定作名义P3代价使用；真实任务118条外部残差失败仍保留。`OPT2_GRASP_MIN_FORWARD_CM=4.75`、`MAX_FORWARD_CM=16.875`、`MAX_SIDE_CM=4.75` 来自公开交互窗口，恢复角由窗口几何反算。13.75cm释放投影复用公开平台值。道路网格、节点探步、观察转角、预算、确认/接近门限均复用既有常量；`1e-9`仅算术边界比较。

对构建/预检工具的读取核对：正式k必须非负有限且calibration.all_pass；主程序绑定calibration SHA、新WM提交和ZIP SHA、原filter全文、新片段全文。WM对比只允许新增 `mark_removed` 与模块说明，原函数AST一致。原M5、确认和WM融合入口检查独立存在。

限制：没有观察实际任务 `program_version` 事件；本报告只核对磁盘构建SHA，不伪造运行身份。完整预检和P3独立oracle/最终报告由根代理与audit_batch另行审核；真实holding只公开类别，具体package身份仍需driver验真。后续改动须重跑本审查。

离线复核命令：

```sh
cd /Users/ken/Desktop/wm_bench
PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/pre-run-review/review.py
```

逐项机器结果见同目录 `review.json`。
