# 六项恢复闭环修复与同版本正式回归

**联合前置验证 PASS；本候选阶段 1 正式回归 FAIL；阶段 2 未运行、未验收。** 本轮正式运行 1/2，失败后没有改代码、调门槛、扩大预算或重跑。历史源码 d1538f7 的阶段 1 PASS 保持原结论；本候选失败与历史结论分别记录。

## 六项修复与离线范围

六项基线问题均存在，修复和正反对照详见 [REVIEW.md](REVIEW.md)、[DISCOVERY.md](DISCOVERY.md)、[RECOVERY_AUDIT_CONTRACT.md](RECOVERY_AUDIT_CONTRACT.md)。普通未入库红框进入持久发现账；充分后继观测可以消解发现或修正历史 provisional 路口及引用；归路分开证明物理上路与地图重连；短段运动使用真实平台合法参数并按实际行程消费；grab、延迟身份确认和 release 以显式引用连接；不合法模型地址只留下安全错误码。

原 WorldModel 三个独立命中、15cm 位点间距、确认距离和竞争规则、归路 .2cm/.2°、视觉接近 25–40cm、平台 follow_road 10–500cm 均没有放宽。普通发现不直接升级 CONFIRMED，义务不按时间或空画面清除。未知数量任务的道路、发现、身份、交付和主动 done 门保持。

最终联合门：Python **1323 passed**；Node driver **29 passed**；冻结平台边界 **15 passed**，均 0 failed、0 skipped。7 个新测试文件的 **114 项**属于 1323 的子集。开发红测试和正常对照、真实生产者→消费者联动的完整命令、统计范围及首次平台本机监听 EPERM 环境失败见 [TEST_COMMANDS.md](TEST_COMMANDS.md)、[TESTS.json](TESTS.json)、[GATE.json](GATE.json)。不同集合互相重叠，不相加。

另外分别记录四个层次：历史模型转录回放 111 轮/115 调用通过；新 Perception 固定旧传感输入的 594 帧诊断保留旧 obs591/r110 拒绝；合成曲路诊断通过；本轮真实闭环失败。前面三个层次不替代真实闭环。充分新观测的发现、释放恢复和主动 done 正对照在真实组件联动测试中通过，也不等于正式任务通过。

## 冻结输入与顺序

- 起点及当时远端 HEAD：`3ad444d03fc077e3d6215a2cf7165be1af2a7e5c`。
- [冻结源码](https://github.com/54dK3n/wm_bench/commit/1117336bcb875e0700ebe6363d6154fc0409a8a0)：`1117336bcb875e0700ebe6363d6154fc0409a8a0`；分支 `codex/autonomous-brain`，仓库 `54dK3n/wm_bench`。冻结后先正常推送并重新读取远端，再启动唯一正式局。
- 平台：`54b36f82109836226cf654e9a676ddf0c3b07cd0`，58 项运行文件原样核验。平台恢复子包包含运行资产、真实桥边界测试及 Python 标准库，不含 `.git`；恢复后的文件 SHA 才是内容依据。
- WorldModel：vendored `wm_kit_opt2`，上游锁 `fef0ba9b754ce9652836fdb720d1162dcadbc5ef`；实际源码树 SHA256 `10895f70be67c9d70b1073256d7e264451934c8d025a11a82128bb7ad956cd7c`，50 文件未修改。实际加载路径和逐文件哈希见 [FROZEN_INPUTS.json](FROZEN_INPUTS.json)，不只按依赖名称推断。
- DeepSeek Flash (`deepseek-flash`)，temperature=0、thinking=disabled、JSON object、stream=true；Python 3.9.6、Node 26.7.0；200 轮/1200 仿真秒，无额外 wall timeout。
- Actions v23、LLM v17、Runtime v15、Perception v11、Navigation v9、driver v9、独立评测器 v8。正式前后 86 项源码哈希一致，评测 source_proof verified。

模型地址异常测试仅用合成 marker 并禁用网络，没有读取真实密钥；交付敏感内容扫描是另外的步骤。没有证据证明历史真实配置曾泄露。

## 唯一正式运行与复算命令

从仓库根运行，任务仅由自然语言输入；没有十布局或硬件运行：

```sh
node tools/autonomous_brain_driver.js --out artifacts/autonomous-brain/recovery-closure-20260926/raw/formal-stage1 --maps map-05 --runs 1 --task '把两个红球送到绿色存放区' --max-rounds 200 --max-simulation-seconds 1200
```

原完整 stdout/stderr 分别保留在 `raw/gate/formal-stage1-driver.txt` 和 trial 中；driver 退出码 1。导出完成后只执行一次冻结独立评测器，没有再次仿真：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/recovery-closure-20260926/raw/formal-stage1/map-05-run-1 --out artifacts/autonomous-brain/recovery-closure-20260926/raw/evaluation/formal-stage1
```

评测退出码 1 表示任务 FAIL，完整结果在 `raw/evaluation/formal-stage1/evaluation.json` 和 `REPORT.md`，控制台摘要在 `raw/gate/formal-stage1-evaluator.txt`。外部复算必须选择新的输出目录，不能覆盖这些文件。

| 正式指标 | 结果 |
|---|---:|
| 决策轮 / 模型调用（含修复、重试） | 200 / 203 |
| 仿真秒 / 最终 tick | 1179.94 / 58997 |
| 公开观测 | 1118 |
| 两个物理红球中有效交付且最终在区内 | 1 / 2 |
| 模型主动 done / 完成复核 | 无 / 不通过 |
| 动作失败 / 执行错误轮 / 评测外部停止错误 | 53 / 0 / 0 |
| 白名单外请求 / 已执行白名单外调用 / 桥拒绝 | 0 / 0 / 0 |
| 原全局 Judge | 2 match，0 false positive，0 false negative，0 unverifiable；198 不在抓放范围 |
| 源码配置核验 / 模型严格回放 | verified / 200 轮、203 调用通过，网络与环境读取为 0 |

唯一有效对象为 `target_017`（离线真值绑定 `guangyang-target-1`）：r19 内有 3 次 grab，前两次 fresh holding=false，第三次 `brain-000405` 后为 true，以 obs94 确认身份；r78 唯一 release 对应 obs489，新的放置见证 obs490。即 1 个 pick 和 1 个 place 动作，不把 3 次 grab 写成 3 个 pick。独立 observed ledger 的 pick/delivery 均 verified，完成见证身份审计没有失败；本局未触发跨动作 pending_grasp 恢复，P5 的此路径仅由离线正反联动证明。第二个物理球 `guangyang-target-2` 在离线几何匹配中于 frame66/58.1秒已被看见，但未达到 CONFIRMED，没有有效交付事件，最终不在存放区；真值只在离线评测中使用，不反馈给大脑。

评测列出全部 9 项失败：缺第二球有效交付、第二球最终不在区、达到轮次上限、未以观测 done 结束、terminal done 未证实、`execution_or_controller_error`、交付数量不足、模型未选择 done、done 后完成未证实。这里 `execution_or_controller_error` 是评测器对 round_limit 导致进程退出码 1 的通用分类，不能解读为另有 1 次动作执行异常；实际错误轮数为 0。

stage-1 的拓扑和发现独立全图审计字段为 null，这是已知数量任务的既定口径；未对它偷偷添加全图验收，也不把脑端路口数当成独立拓扑 PASS。阶段 2 因本候选阶段 1 失败而未运行，节点比例、全出口完成、全部目标发现与自主 done 均未正式验收。

## 主要阻塞与证据入口

公开日志显示探索得到的视角没有稳定满足原确认窗口：首球交付后 r79–200 共 122 轮均为 explore，后段有新红球入库假设，但除已交付 017 外仍没有任何红球达到 CONFIRMED。这支持“发现后获取足够合格独立视角的闭环尚未可靠”，不支持降低确认门。受阻返回和道路重复探索也消耗预算。

限定 r143 的诊断保留为 `raw/analysis/STAGE1_PREFIX143_DIAGNOSIS.md`、`diagnose_stage1_prefix143.py`、`stage1-prefix143-diagnosis.json`，只读 143 轮/829 观测/543 运动并记录精确前缀 SHA。不把其“后期无入库”外推到 r200。完整局最终诊断为 `raw/analysis/stage1-final-diagnosis.md`、`stage1-final-diagnosis-v2.json`，复算脚本 `stage1-final-diagnose.py --output <new-json>`：295 条红框中 34 入 WM，但除已交付017外所有候选均只有 1 hit；r144–200 的 7 个新候选各自所有入库样本的最大平移分离均为 0cm。最终 182 个 pending 发现假设、225 条未解释记录、0 resolution 是任务义务而非实体球计数。当前 known 两球的完成门仅因交付不足拒绝；发现账本的未知数量全图门不是本局失败的附加原因。

正式道路换位仅 r65、o427–438 的 `road_reposition.status=no_verified_route_needs_exploration`，`attempts=[]`：0 候选尝试、0 候选到达、0 完整换位加新视觉闭环。合成曲路的 1 次完整成功只证明离线组件链路；旧局 190.4cm 运动也不属于本局。完整换位必须有候选路径真实复走到达及随后新视觉接近判据通过，不能以累计行程或一般导航成功替代。

独立消费者只读复核入口为 `raw/analysis/FORMAL_STAGE1_READONLY_REVIEW.md`、`formal-stage1-readonly-review.json`、`review_formal_stage1_readonly.py --output <new-json>`。13 项评测输入哈希和大小全部一致；全局与动作前缀 Judge 均为 2 match，未替换或删除冲突观测。该复核没有另跑总评测器、模型或仿真。

本轮到此停止开发和正式运行。下一轮需要解决主动获取合格新视角及道路探索进展的可靠性，但本报告不补代码、不改当前结果、不重跑。

## 外部证据与恢复

[本轮 Release](https://github.com/54dK3n/wm_bench/releases/tag/recovery-closure-20260926-1117336) 保存原始 record、完整观测/模型/桥日志、全部开发红绿输出、离线诊断、平台恢复子包和独立评测。`raw`、record 和任何 bin 分片不进入 Git。摘要使用仓库相对路径。

下载 `wm-bench-recovery-closure-20260926-evidence.tar.gz` 和同名 `.sha256`；原文件 SHA256 见 [SHA256SUMS](SHA256SUMS)，压缩包 SHA 见独立侧车及 `DELIVERY.json`。敏感内容扫描与明确分类见 `SECRET_SCAN.json`；上传后匿名下载和远端提交复核见 `PUBLICATION_VERIFICATION.json`。这些交付元数据分别生成，不对归档制造包含自身的哈希循环。

完整空目录恢复、冻结源码 checkout、平台子包恢复、正式评测和模型严格离线复算步骤见 [RESTORE.md](RESTORE.md)。两份历史 Release 不重复装入本包，原阶段 1 的 79 项和上轮停止的 95 项清单保持不变；旧全局 Judge 2 match / 2 unverifiable 与本局 2 match 分别报告。
