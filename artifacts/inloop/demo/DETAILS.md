# 双目标 Demo

仅展示首次通过的演示；失败布局保留，不计算成功率。

| 布局 | 结果 | 已验证送达目标 | 仿真秒 | observe | 停止原因 / 未通过门槛 |
|---|---|---|---:|---:|---|
| map-03 | 未通过 | guangyang-target-2 | 246 | 33 | WorldModel 未通过 observe() 确认目标物; two_distinct_targets_grabbed_and_delivered=fail; two_ball_timelines_complete=fail; every_ball_fixed_rules_pass=fail |
| map-04 | 未通过 | guangyang-target-2 | 509.4 | 54 | WorldModel 未通过 observe() 确认目标物; two_distinct_targets_grabbed_and_delivered=fail; two_ball_timelines_complete=fail; every_ball_fixed_rules_pass=fail |
| map-05 | 通过 | guangyang-target-1, guangyang-target-2 | 440.6 | 27 | — |

主时间线：map-05。原始记录：`/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/map-05.json`。所有索引为零起点。

## 第 1 球

轨迹 `target_001`；来源 `new_observations`；平台目标 `guangyang-target-1`。

| lines 索引 | tick | 事件 | 数值 / 状态 |
|---:|---:|---|---|
| 1 | 0 | ball_start | `{"ball_index":1,"track_id":null,"target_source":"new_observations","retained_wm_targets":0,"delivered_count":0,"observe_count":0,"approach_calls":0}` |
| 20 | 1718 | ball_selection | `{"ball_index":1,"track_id":"target_001","target_source":"new_observations","wm_position":[-1.5494969570255135,1.0797690673763842],"wm_state":"tentative","wm_hit_count":1}` |
| 21 | — | last_observe | `{"wm_distance_m":0.629,"camera_distanceCm":55,"target":[-1.549,1.08],"pose":[-1.208,0.552,30.5],"forward_after_last_observe_cm":0}` |
| 23 | — | confirmation_sample | `{"hits":1,"camera_distanceCm":55,"wm_distance_m":0.6286178172284205,"gap_to_previous_m":null,"pose":[-1.208,0.552]}` |
| 103 | — | last_observe | `{"wm_distance_m":0.569,"camera_distanceCm":49,"target":[-1.544,1.085],"pose":[-1.079,0.756,55.5],"forward_after_last_observe_cm":0}` |
| 105 | — | confirmation_sample | `{"hits":2,"camera_distanceCm":49,"wm_distance_m":0.5690935949353986,"gap_to_previous_m":0.241,"pose":[-1.079,0.756]}` |
| 310 | — | last_observe | `{"wm_distance_m":0.555,"camera_distanceCm":51,"target":[-1.554,1.099],"pose":[-1.458,0.552,9.1],"forward_after_last_observe_cm":0}` |
| 312 | — | confirmation_sample | `{"hits":3,"camera_distanceCm":51,"wm_distance_m":0.5554425680419891,"gap_to_previous_m":0.43,"pose":[-1.458,0.552]}` |
| 313 | — | memory_confirmed | `{"hits":[{"track_id":"target_001","pose_x":-1.208,"pose_z":0.552,"pose_heading_deg":30.5,"distanceCm":55,"world_x":-1.5494969570255135,"world_z":1.0797690673763842},{"track_id":"target_001","pose_x":-1.079,"pose_z":0.7559999999999999,"pose_heading_deg":55.5,"distanceCm":49,"world_x":-1.53783110442855,"world_z":1.0893606255914603},{"track_id":"target_001","pose_x":-1.4580000000000002,"pose_z":0.552,"pose_heading_deg":9.1,"distanceCm":51,"world_x":-1.5750962820230883,"world_z":1.1280465363346304}],"track_id":"target_001","confirmation_distanceCm":51,"last_sample_wm_distance_m":0.5554425680419891}` |
| 314 | 2846 | ball_confirmed | `{"ball_index":1,"track_id":"target_001","target_source":"new_observations","accepted_hits":3}` |
| 423 | — | approach_call | `{"count":1,"max_steps":1,"wm_distance_m":0.219,"forward_after_last_observe_cm":871.7}` |
| 425 | 9369 | grab_step | `{"step":1,"advanced_cm":0,"holding":null,"wm_distance_m":0.21,"onRoad":true,"pose":[-1.349,1.146,102.9]}` |
| 426 | 9427 | grab_step | `{"step":2,"advanced_cm":6,"holding":"目标物","wm_distance_m":0.151,"onRoad":true,"pose":[-1.407,1.133,102.9]}` |
| 427 | — | memory_navigation_metric | `{"passed":true,"last_observe_distance_m":0.555,"last_observe_camera_distance_cm":51,"forward_after_last_observe_cm":877.7,"required_forward_cm":30,"approach_calls":1,"grab_attempts":2,"grab_advanced_cm":6,"observe_count":8,"onRoad":true}` |
| 428 | 9427 | ball_grabbed | `{"ball_index":1,"track_id":"target_001","target_source":"new_observations","holding":"目标物"}` |
| 445 | 11318 | ball_delivered | `{"ball_index":1,"track_id":"target_001","target_source":"new_observations","preview":{"schemaVersion":"chenlong.release-preview/v1","holding":"target","releaseAccepted":true,"releaseReason":"ready","wouldCompleteDelivery":true,"roadClearanceCm":null,"requiredRoadClearanceCm":null,"tick":11284},"holding_after":null,"completed_before":0,"completed_after":1,"expected_release_position":[0.9214457289980681,-0.011772630842694046],"position_source":"successful_release_pose_and_public_release_projection","storage_anchor":{"id":"storage","roadId":"nw-bag","progressCm":4.4},"exclusion_radius_m":0.3,"delivered_count":1}` |
| 447 | 11375 | ball_end | `{"ball_index":1,"track_id":"target_001","target_source":"new_observations","success":true,"stage":"delivery","reason":null,"delivered_count":1}` |

固定规则：confirmation_three_hits=pass；confirmation_same_track=pass；confirmation_window_40_90cm=pass；confirmation_all_pair_gaps_15cm=pass；confirmation_last_distance_0_5m=pass；actual_wm_three_distinct_hits=pass；actual_wm_window_40_90cm=pass；actual_wm_all_pair_gaps_15cm=pass；memory_drive_30cm=pass；approach_distance_0_25m=pass；approach_max_steps_one=pass；approach_at_most_three=pass。

## 第 2 球

轨迹 `target_002`；来源 `new_observations`；平台目标 `guangyang-target-2`。

| lines 索引 | tick | 事件 | 数值 / 状态 |
|---:|---:|---|---|
| 448 | 11375 | ball_start | `{"ball_index":2,"track_id":null,"target_source":"new_observations","retained_wm_targets":1,"delivered_count":1,"observe_count":9,"approach_calls":1}` |
| 605 | 16404 | ball_selection | `{"ball_index":2,"track_id":"target_002","target_source":"new_observations","wm_position":[-0.40940486157336653,1.5352925034605298],"wm_state":"tentative","wm_hit_count":1}` |
| 606 | — | last_observe | `{"wm_distance_m":0.537,"camera_distanceCm":46,"target":[-0.409,1.535],"pose":[-0.865,1.819,-123.9],"forward_after_last_observe_cm":0}` |
| 608 | — | confirmation_sample | `{"hits":1,"camera_distanceCm":46,"wm_distance_m":0.5367093009727676,"gap_to_previous_m":null,"pose":[-0.865,1.819]}` |
| 871 | — | last_observe | `{"wm_distance_m":0.697,"camera_distanceCm":60,"target":[-0.419,1.552],"pose":[-0.907,2.05,-136],"forward_after_last_observe_cm":0}` |
| 873 | — | confirmation_sample | `{"hits":2,"camera_distanceCm":60,"wm_distance_m":0.6974822933936975,"gap_to_previous_m":0.235,"pose":[-0.907,2.05]}` |
| 1010 | — | last_observe | `{"wm_distance_m":0.8,"camera_distanceCm":69,"target":[-0.431,1.56],"pose":[-1.063,2.05,-127.7],"forward_after_last_observe_cm":0}` |
| 1012 | — | confirmation_sample | `{"hits":3,"camera_distanceCm":69,"wm_distance_m":0.7998162350541951,"gap_to_previous_m":0.156,"pose":[-1.063,2.05]}` |
| 1013 | — | memory_confirmed | `{"hits":[{"track_id":"target_002","pose_x":-0.865,"pose_z":1.819,"pose_heading_deg":-123.9,"distanceCm":46,"world_x":-0.40940486157336653,"world_z":1.5352925034605298},{"track_id":"target_002","pose_x":-0.907,"pose_z":2.05,"pose_heading_deg":-136,"distanceCm":60,"world_x":-0.4277542087672481,"world_z":1.5688621287573448},{"track_id":"target_002","pose_x":-1.063,"pose_z":2.05,"pose_heading_deg":-127.7,"distanceCm":69,"world_x":-0.45535412932030417,"world_z":1.5759161501508654}],"track_id":"target_002","confirmation_distanceCm":69,"last_sample_wm_distance_m":0.7998162350541951}` |
| 1014 | 16869 | ball_confirmed | `{"ball_index":2,"track_id":"target_002","target_source":"new_observations","accepted_hits":3}` |
| 1038 | — | approach_call | `{"count":2,"max_steps":1,"wm_distance_m":0.22,"forward_after_last_observe_cm":476.7}` |
| 1040 | 19932 | grab_step | `{"step":1,"advanced_cm":0,"holding":"目标物","wm_distance_m":0.22,"onRoad":true,"pose":[-0.218,1.505,80.1]}` |
| 1041 | — | memory_navigation_metric | `{"passed":true,"last_observe_distance_m":0.8,"last_observe_camera_distance_cm":69,"forward_after_last_observe_cm":476.7,"required_forward_cm":30,"approach_calls":2,"grab_attempts":1,"grab_advanced_cm":0,"observe_count":26,"onRoad":true}` |
| 1042 | 19932 | ball_grabbed | `{"ball_index":2,"track_id":"target_002","target_source":"new_observations","holding":"目标物"}` |
| 1061 | 21974 | ball_delivered | `{"ball_index":2,"track_id":"target_002","target_source":"new_observations","preview":{"schemaVersion":"chenlong.release-preview/v1","holding":"target","releaseAccepted":true,"releaseReason":"ready","wouldCompleteDelivery":true,"roadClearanceCm":null,"requiredRoadClearanceCm":null,"tick":21940},"holding_after":null,"completed_before":1,"completed_after":2,"expected_release_position":[0.9187180090742255,-0.012695913098820247],"position_source":"successful_release_pose_and_public_release_projection","storage_anchor":{"id":"storage","roadId":"nw-bag","progressCm":4.4},"exclusion_radius_m":0.3,"delivered_count":2}` |
| 1063 | 22031 | ball_end | `{"ball_index":2,"track_id":"target_002","target_source":"new_observations","success":true,"stage":"delivery","reason":null,"delivered_count":2}` |
| 1064 | 22031 | flow_end | `{"ball_index":2,"track_id":"target_002","target_source":"new_observations","success":true,"stage":"delivery","reason":null,"one_target_released":true,"delivered_count":2,"required_targets":2,"navigation_queries":609,"navigation_controls":207,"full_targetDelivered":true,"holding":null}` |

固定规则：confirmation_three_hits=pass；confirmation_same_track=pass；confirmation_window_40_90cm=pass；confirmation_all_pair_gaps_15cm=pass；confirmation_last_distance_0_5m=pass；actual_wm_three_distinct_hits=pass；actual_wm_window_40_90cm=pass；actual_wm_all_pair_gaps_15cm=pass；memory_drive_30cm=pass；approach_distance_0_25m=pass；approach_max_steps_one=pass；approach_at_most_three=pass。

## 门槛与证据

| 门槛 | 状态 |
|---|---|
| program_identity | pass |
| no_target_anchor_access | pass |
| no_layout_coordinates | pass |
| run_finished | pass |
| two_distinct_targets_grabbed_and_delivered | pass |
| program_errors_zero | pass |
| simulation_seconds_at_most_600 | pass |
| observe_at_most_92 | pass |
| vision_at_most_20mib | pass |
| no_stationary_observe_or_guard_violation | pass |
| on_road_entire_run | pass |
| two_ball_timelines_complete | pass |
| every_ball_fixed_rules_pass | pass |
| full_raw_record_preserved | pass |
| samples_preserved | pass |
| native_png_evidence_complete | pass |
| driver_keyframes_preserved | pass |

数值与证据文件 SHA256 见 `demo_report.json`。缺证据为 unknown，不计通过。
