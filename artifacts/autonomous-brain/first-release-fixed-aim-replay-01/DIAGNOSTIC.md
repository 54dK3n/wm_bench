# 首次放置固定瞄准点：Run17前33轮真实场景回放诊断01

定向诊断 **PASS**：保持原Run17的33个模型输入状态和动作、39条模型记录不变，r33改用首次观测绿色区域的固定地面点后，实际新轨迹产生合法后验见证，target_031变为DELIVERED；独立原生记录与终态真值确认首球有效交付。抓取和放置Judge均一致，false-positive/false-negative均为0。

整个任务仍为 **FAIL**：本次主动降低到33轮诊断上限，brain以round_limit结束，实际交付1/2且没有自主done。这不是新的真实模型正式运行，不加入LIVE_RUNS，不是map-05成功门票，也不保证未来所有首次放置或完整任务成功。

## 严格输入与来源

冻结提交为 `258ebab8555344805eabd1c5b2fe4773d97d7df2`，actions v18、runtime v10、navigation v4、LLM v12、driver v5。`source-commit.json`逐项验证7个brain文件及driver的Git blob、运行前后manifest、brain summary SHA，8项完全一致；平台和capture函数的前后指纹也一致。后续工作树变化不参与本次证明。

输入 `../first-release-fixed-aim-fix-20260926/run17-prefix-33.jsonl` 是原Run17 decision≤33的完整39行原字节，SHA256为 `3f445dd18914affd9dca852dff97aac84fe75e08d50c068a76d3ecb15709cce3`。没有删掉历史重试或修正记录。

`prefix-replay-proof.json`保存逐轮、逐调用比较与哈希：

- 全33个state、action和对应模型返回记录一致；全部39条完整调用记录仅mode由live变为replay，其余字段相等。
- 消耗39/39条记录，未提前发生输入失配；前32轮执行result也完全相等。
- 原Run17与本诊断观测到obs212均完全相同；第一个不同观测是r33的obs213，此时新的固定点控制已改变真实运动轨迹。
- r33执行结果有意改变；没有声称变化后的第34轮及后续输入仍能沿用原记录。

模型API调用0：driver使用冻结LLMClient的replay分支，全部39条记录为replay；本地robot bridge请求单独计数。再次严格离线LLM回放33轮/39条也完全匹配，网络调用0、环境访问0，原证据不变。模型elapsed总和737.825693164秒及5秒重试等待是原Run17历史字段，不是本次新模型耗时或API使用；本次brain实际墙钟77.138262083秒。

## r33固定点与实际新轨迹

与Run17共享的起始obs211中，完整绿色框为(153,253,373,94)。本次选择其中心像素(339.5,300)，投影到里程计地面点(1.0284221940211042, −0.04553616318970216)米。`release_aim`保留原source_frame=211及完整来源检测，mode为 `observed_storage_center_ground_point`。随后对准使用同一个地面点和当前里程计；没有追随靠近后变化的绿色框中心。

`release-aim-proof.json`逐帧重算obs211–215对固定点的距离与bearing，并保存公开观测和实际轨迹。最后对准obs215的距离18.068866922cm、bearing−0.154215558°，与日志精确一致。

| 实际动作 | 观测变化 |
|---|---|
| forward 7cm | 211→212 |
| forward 7cm | 212→213 |
| turn −3.980848716° | 213→214 |
| forward 1.167991750cm | 214→215 |
| release | 215→216，187.36秒holding=false |
| backward 25cm | 216→217，190.04秒onRoad=true |

后退后已经在公开观测道路上，因此road_return为already_on_observed_road，没有额外归路motion，也没有触发补充重观察。最终obs218保持target_031 DELIVERED。

## 后验见证与独立交付

判断使用实际post帧217：唯一红框(282,210,72,60)，完整绿色框(183,239,268,48)，球底点(318,270)。原内椭圆公式结果为0.0851251361352442，低于未改变的0.64门限，candidate_witnesses=1。夹爪为空，release边界为frame216/187.36秒；preexisting_ball_ids仍为025、052。红检测track_id=null属于合法的近场公开见证，不制造新CONFIRMED hit；身份、像素、当前帧和释放边界验证均通过。

原Run17相同r33的post帧226内椭圆值0.6813553675084635，candidate0，记为RELEASED_UNVERIFIED。原轨迹包含15个place motion及4个额外归路motion；新轨迹为6个place motion且无需额外归路。原动作结束195.52秒，新动作结束190.04秒。两次实际物理交付都成立，本次改善的是固定瞄准轨迹及公开传感器可验证的放置结果。

本诊断独立原生交付事件在tick9347/186.94秒；末sample tick9502与record end tick完全一致，首球不在夹爪中、有效交付事件未撤销且终态在存放区内。第二球未抓取、未送达。Judge对r22 pick、r33 place两项均match，false-positive=0、false-negative=0、unverifiable=0，其余31轮不在pick/place判定范围。

原Run17放前目标漂移的公开传感诊断、基线测试与修复说明单独见 [修复报告](../first-release-fixed-aim-fix-20260926/REPORT.md)。本次同前缀对照支持这一条首次放置修复；它不构成所有放置场景的成功保证，未改写Run17的正式FAIL。

## 指标与失败边界

| 项目 | 结果 |
|---|---:|
| 轮次 / 记录调用 / 观测 | 33 / 39 / 218 |
| motion / robot bridge请求 | 152 / 1,025 |
| explore / look_around / go_to / pick / place | 20 / 6 / 5 / 1 / 1 |
| grab / release | 2 / 1 |
| 仿真时间 / 最终tick | 190.04秒 / 9502 |
| brain / driver实际墙钟 | 77.138262083 / 77.25秒 |
| 成功动作 / 原动作失败 | 29 / 4 |
| 控制器 / 执行异常 / 外停错误 | 0 / 0 / 0 |
| 模型新API请求 | 0 |
| 历史重放传输错误 / 状态校验错误 | 5 / 1 |
| 独立有效交付 | 1/2 |

4次原动作失败为r9道路阻塞返回、r23/26/28已知路线耗尽，与原Run17前缀一致。39条历史模型记录中的5次传输错误及1次校验错误也原样重放，不是新网络失败。

独立评测的整体失败项包含第二球未交付、33轮上限、没有observed done和通用execution_or_controller_error。最后一项源于brain status=failed/round_limit；此诊断实际controllerErrors为空，执行异常轮次及外停错误均为0。最终公开记忆仍有未确认的target_052待处理，不能凭首次place通过宣称整体完成。

## 归档完整性

driver status=complete、sourcesUnchanged=true，5项导出complete、failures=[]、partial={}。4个gzip逐个流式读取至EOF并校验CRC、压缩/展开字节数与SHA256；envelope也独立核验。record原压缩文件52,149,374字节、展开75,302,625字节，SHA256为 `bf377aa169475cefebb2001789fa7a39b0888b72065e25081ae6e2ae0a914032`，低于100MiB，无需分片或新增忽略规则。

`archive-checks.json`保存原始文件哈希、8文件来源证明、前17局51份报告和两个正式索引未变的核验；`publication-checks.json`扫描本诊断普通文本及gzip展开内容，检查凭据格式与绝对用户路径。真值只用于结束后的独立评测，没有供给运行中的模型。

在仓库根目录可重做评测与LLM回放（评测exit1表示完整FAIL报告）：

```sh
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1 --out artifacts/autonomous-brain/first-release-fixed-aim-replay-01/recomputed-report
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1 --out artifacts/autonomous-brain/first-release-fixed-aim-replay-01/recomputed-llm-replay
```
