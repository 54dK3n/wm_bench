# 最小双球 demo 改动

基线是 `../stage-1/round-3/program.py`（wm-stage1-r3），新程序另存于 `programs/world_model_two_target_demo.py`，版本 `wm-demo-v1-20260923`。原单球程序和三轮历史记录不修改。

1. 最外层循环两次：WM有未处理目标先选择记忆，否则沿用原巡逻；每球必须重新取得三次合规确认，不以一个CONFIRMED标志跳过确认凭据。
2. 每球重置确认记录、记忆行驶计量、目标专用视点失败记录，保留WM、道路几何、全局observe计数、运动守卫及导航预算。
3. 抓到后排除该WM轨迹ID；投放预览合法、释放后空夹爪且公开task_state.completed增加，才登记送达。记录来自里程计的释放位置和公开夹爪投影13.75cm；周围排除范围复用原WM关联门限0.30m。这里只排除已处理物，不增加伪检测过滤。100cm封顶读数仍只作方位，不投影为100cm位置。
4. 删除mission target锚点变量和两个未使用的旧fallback函数。仅保留公开obstacle道路锚点避让与storage锚点送货；受保护dict测试证明未读取target的roadId/progressCm。
5. 新增每球开始、选择、确认、抓取、送达、结束的tick与来源日志。抓取/道路/确认/WM融合函数保持原实现。

两个球来自赛题定义；13.75cm来自原程序已有公开释放投影；0.30m直接读取既有静态WM配置。未使用任何布局坐标、布局分支、新测距拟合或新确认门槛。所用测距常数、确认函数和WM内嵌包的不变性见 `preflight.json`。

driver仅在 `--demo-evidence 1` 模式增加完整原生record导出，以及两个目标首次抓取/送达各一张原生主视图截图。截图只读取已有渲染结果，不增加observe/render，不改变仿真或原生证据预算；实际截图tick与事件tick分列。阶段0对额外截图合计字节只报告，不增设20MiB失败门槛。

验收代码与机器人分文件。`tools/run_demo.py` 严格按03、04、05、08优先逐图尝试，失败换图，首次完全通过即停；执行状态不明时保留active并停止，禁止自动重跑。原始记录不得被后续成功替换。

运行前检查复现：`python3 tools/demo_preflight.py`。142项测试通过（含2个未决执行禁止重跑用例），指定pylint五类零报错，真实平台异步转换后编译通过；逐字节源码差异见 `changes.patch`。截图契约测试：`node tools/test_demo_keyframes_hook.js`，输出见 `keyframe_tests.txt`。
