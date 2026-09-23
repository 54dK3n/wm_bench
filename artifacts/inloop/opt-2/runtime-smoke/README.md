# 完整平台包装启动检查

入口：`python3 tools/opt2_runtime_smoke.py --program <完整程序> --out <结果.json>`。默认仅读取已保存的公开 API 前缀，输出 `all_pass` / `failures` 和所有依赖 SHA。可选 `--fixture` / `--worker` 可绑定另一份明确的公共输入/平台源码。

本次 [manifest.json](manifest.json) 记录8项专属测试通过及两个实际检查：[冻结R2](frozen-r2.json) 在消费7条公开查询、尚无道路控制时精确报 `NameError: name 'OPT2_MEMORY_TRAVEL_ACTIVE' is not defined`；[修正R3](corrected-r3.json) 消费完整10条输入，完成 take_exit(30%、obeySpeedLimit=true) 返回的25cm首动作及后置里程计/道路状态，再在下一条未保存API之前主动停止。

执行方式直接读取实际 worker 的 Robot 参数验证、AsyncRobotTransformer 及完整 `async __student_main__` 包装。先按 JavaScript template literal 的现有转义解码，再编译其 Python。学生 globals 只有平台原有 robot / print，以及 exec 自行加入的 builtins / __student_main__；没有安装学生函数、运动标志或修复用变量。平台原本提供的 student_source 输入元数据单独用于源哈希日志，未进入学生 globals。原有嵌入 WM 解压仍在临时目录进行。

首动作后，从真实外层 frame 捕获实际嵌套函数引用，使用明确的静态公开里程计/道路回复，调用原记忆 wrapper。缺失目标正常返回 False 以及显式 API 异常两条路径都实际进入原 graph 函数；期间真实 `_opt2_travel_speed` 为100，退出后恢复30。没有替换任何学生 helper，也没有注入缺失的 globals。反例测试另证明只修 global 写入而仍用 globals().get 读速度时，这项检查会失败。

这不是新仿真，也不是整局轨迹重放：没有浏览器、控制器、渲染或视觉模型执行；既有公开结果只用于严格验证请求顺序、参数和返回契约。后半段仅验证真实闭包作用域和 finally 恢复，不证明道路行驶、抓取、送达或时间门通过。宿主为 CPython，未覆盖 Pyodide/JS 调度差异。
