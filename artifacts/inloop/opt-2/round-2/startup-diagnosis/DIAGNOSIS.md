# Opt2 round2：完整启动作用域故障

结论：十局在第一帧观察后、任何运动之前发生同一启动错误。冻结程序的运动模式布尔变量在真实worker包装后是外层局部，而两个辅助函数使用global读取另一个命名空间。不是布局差异，也不是感知/确认失败。

冻结源码SHA：`90191e8764de3b98cd4251341f582a60e4b097e98453273bf5b5ab2eefe0a029`；实际提交源码SHA：`d423f74fc968b1921d9f9dba6e644ae416880ae3addf00500081d886e938b28f`。全部10局原生sourceCode逐字等于executed_program.py。raw与executed仅末尾换行不同。

|布局|原生program_error索引/seq/t(ms)|observe次数|运动控制次数|首个反馈|
|---|---|---|---|---|
|map-01|events[1]/seq11/0|1|0|第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。|
|map-02|events[1]/seq11/0|1|0|第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。|
|map-03|events[1]/seq11/0|1|0|第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。|
|map-04|events[1]/seq11/0|1|0|第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。|
|map-05|events[1]/seq11/0|1|0|第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。|
|map-06|events[1]/seq11/0|1|0|第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。|
|map-07|events[1]/seq11/0|1|0|第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。|
|map-08|events[1]/seq11/0|1|0|第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。|
|map-09|events[1]/seq11/0|1|0|第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。|
|map-10|events[1]/seq11/0|1|0|第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。|

原生record只有平台格式化中文错误，不包含Python traceback。app.js:12553–12557将NameError统一转成“用了不存在的名称”；12597–12600只选traceback第一个学生代码行，所以3761指向顶层run_target_flow调用，不能把它当真正出错的读取行。离线完整启动已逐局重现确切异常：NameError: name OPT2_MEMORY_TRAVEL_ACTIVE is not defined。栈为3761 __student_main__ →2793 run_target_flow →1842 patrol_until_target_seen →3672 _opt2_patrol_enter。

实际作用域：python-worker.js:407–435先转换函数/await，再将整个tree.body放进async __student_main__，在只含robot、print的scope中执行。program.py:3652赋值成为该函数的局部。3671的global声明令3672的previous读取执行LOAD_GLOBAL；3656–3657的memory wrapper同样有问题。2845的globals().get也不读取外层局部。字节码已由实际worker转换+外层包装编译复核，见frozen_wrapper_lexical_proof。

漏检原因：opt2_preflight.py只以ALLOW_TOP_LEVEL_AWAIT编译转换后的module，没有运行外层包装；motion专属测试在module scope执行fragment，使顶层赋值创建真正global；我的26项独立审查虽使用全函数名并执行了桥接、patrol和flow，但把选定函数放在module namespace且替换了motion，因此也没有覆盖这层作用域。此前“无新阻断”只能证明那些局部执行路径，不能证明完整程序启动。

最小修复：用已在外层初始化的共享字典OPT2_MOTION_STATE["memory_travel_active"]，两个wrapper修改键并在finally恢复原值；速度选择直接读取该字典。避免global和globals()旁路。当前r3仅版本和_opt2_memory_navigation、_opt2_patrol_enter、_opt2_travel_speed三函数行为修改；字典在外层成为cell，三函数均LOAD_DEREF。未改测距、WM、过滤或确认规则。

当前待审候选SHA：`59d8f617a7fd82135b710b6a32cf112b4c17c80aa770beb59407aa50d5cf17e6`。新的完整启动验证必须保持整个学生源码及其顶层初始化，采用真实Robot/Transformer/__student_main__包装，scope只注入平台原有robot+print，API仅返回保存的公开输入；不得注入OPT2状态名称使旧代码假通过。到未保存控制边界应明确停止，不得虚构控制成功。

复算证据：`PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-2/startup-diagnosis/reproduce.py`。该脚本只读冻结记录/源码、生成新诊断，未启动控制器/仿真。完整worker执行产物由专门runtime smoke提供并在本目录归档。


完整执行复核结果：十局各自仅公开API的7条前缀全部依次匹配；全部5条GY日志（program_version、ball_start、observe、detection_filter、target_observations）与各自原raw逐值相同；十次均在首个控制调用之前重现同一NameError。没有向student scope注入运动状态、程序helper或其它变量。

r3整脚本启动通过：默认真实旧记录前缀10条，包含首个take_exit(speed30,obeySpeedLimit=true)返回25cm以及后置odometry/road_state；下一条未保存API之前主动抛出专用边界异常停止。它证明原生公开协议输入下的完整启动/首出口返回，不宣称当前任务真实运动或完整双送达已通过。

后续记忆作用域使用明确的静态公开返回，不替换程序函数/闭包：真实嵌套_opt2_memory_navigation使查询期间速度100；真实图导航对absent目标正常返回False后恢复30；注入公开odometry异常也传播且finally恢复30。该部分是作用域回归测试，不是感知/导航性能测量。

candidate_full_startup.json保留全部调用、输出、依赖SHA与边界；diagnosis.json保留十局逐局异常及traceback。复跑可指定冻结候选：`python3 artifacts/inloop/opt-2/round-2/startup-diagnosis/reproduce.py --candidate PATH_TO_FROZEN_PROGRAM.py`。执行器为tools/opt2_runtime_smoke.py，独立诊断脚本仅调用其公开接口并核验原生逐条输出。


独立对照Node原生JS template求值与离线解码器：字符串SHA256均为`ac035f09379f9b1598b0fed94c14b145e60a2feb35df9ced9894b46b1b17da7e`，逐字节等价；template_decode_review.json及同一复算脚本保留证据。最终smoke helper的SHA记录于每份执行结果dependencies，未编辑该共享工具。
