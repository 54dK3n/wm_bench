# Acquisition独立预运行审查

实际完整程序SHA256：`90191e8764de3b98cd4251341f582a60e4b097e98453273bf5b5ab2eefe0a029`。完整函数名集合144个，实际平台AsyncRobotTransformer转换后执行，26项全部通过。没有启动仿真。

执行覆盖真实_update_wm/标定/WorldModel、无红帧桥接、窗外29/93/100cm保护、同帧旧轨迹LOST且新轨迹保留、LOST目标退出、实际patrol继续导航并选择新轨迹、记忆分支在失效后回巡逻，以及每球起始已知ID对应memory/new_observations来源。

测试边界：道路查询、observe和运动为明确的离线适配器；记忆分支的确认任务只负责制造目标过期、后续确认成功和抓取停止点，不模拟物理或声明新局成功。真实WM/原标定/桥接/身份锁/巡逻及主流程均实际执行。完整适配器清单见JSON。

曾发现的两个阻断已修复：any(_is_target(...) for ...)被显式循环替代，避免异步生成器；旧轨迹失效返回None后，patrol两处已消费abandoned标记，防止立刻重选新轨迹并误报整球确认失败。memory分支也进入巡逻。

原始感知/校准/过滤/确认等13个函数AST与round1相同；CONFIRM_*常量及WM嵌入包AST相同。原每帧原始红蓝日志及过滤决策保留；新增empty更新只发生在实际新observe已执行且经过原过滤/交付排除后没有任何红时。窗外/封顶红不会被range clipping伪装成miss。

|检查|结果|
|---|---|
|no_await_in_generators|PASS|
|raw_29_positive_red_not_miss|PASS|
|raw_93_positive_red_not_miss|PASS|
|raw_100_positive_red_not_miss|PASS|
|real_empty_archives_and_unlocks|PASS|
|history_and_non_target_state_preserved|PASS|
|old_goal_expires|PASS|
|abandon_return_does_not_abort_patrol|PASS|
|same_frame_old_lost_new_track_retained|PASS|
|old_goal_lost_even_with_new_red|PASS|
|new_track_not_immediately_called_confirmation_failure|PASS|
|new_memory_remains_selectable|PASS|
|capped_ray_positive_kept|PASS|
|capped_ray_new_empty_expires|PASS|
|actual_patrol_lost_goal_continues_to_new_track|PASS|
|actual_patrol_preserves_global_observe_count|PASS|
|memory_expiry_reenters_patrol_in_actual_flow|PASS|
|memory_fallback_consumes_abandon_flag|PASS|
|flow_reaches_new_identity_after_fallback|PASS|
|new_after_ball_start_has_new_observations_source|PASS|
|retained_identity_has_memory_source|PASS|
|two_patrol_abort_hooks_integrated|PASS|
|three_real_observe_update_hooks|PASS|
|no_expiry_in_geometry_only_planning_goal|PASS|
|13_original_perception_confirmation_functions_unchanged|PASS|
|confirmation_constants_and_WM_embedding_unchanged|PASS|

固定轨迹回放证据见[EMPTY_UPDATE_REPLAY.md](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/round-1/selection-diagnosis/EMPTY_UPDATE_REPLAY.md)：20局67个原快照零差异，受保护empty模式保留20/20原确认。此结果不能替代新策略在线轨迹检验，成功05的射线失联提前返回可能改变路径。

复算：`PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-2/pre-run-review/review_acquisition.py programs/world_model_opt2.py`。全部脚本与产物仅位于新增审查目录，原程序及共享工具未修改。
