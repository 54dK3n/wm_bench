# 独立评测器 v2：终态、源码与 Judge 核验

本次只修改 `tools/evaluate_autonomous_brain.py` 与 `tests/test_brain_evaluation.py`。没有修改自主脑、driver 或平台；没有读取运行中的run08真值，没有模型或网络调用。已有报告保持原样；本目录保存新测试与已结束run07的v2复算。

## 实际修复

- 最后原生样本的tick必须等于simulationEndTick。完成历史run06的最后三个样本tick为28360、28365、28369，结束tick为28369；run07的最后样本tick为12496，结束tick也为12496。导出在非固定采样间隔边界补上最后样本，因此无需放宽为“最近的周期样本”。压缩record的输入SHA256和复算数值见 `cadence-check.json`。
- summary中的status=done必须有最后一轮成功的done动作、该轮唯一引用的最后观测、相同结束tick及空夹爪共同支持。仅声明done或引用过期、错误轮次、缺失观测均失败。
- 要求原始evidence.json提供record/captures的压缩与展开SHA256，缺失不再默认通过。原生record的交付事件、撤销事件、最终位置及持物排除仍独立核验。
- 比较已知driver v1–v4格式的运行前manifest与运行后sourceManifestAfterRun，要求sourcesUnchanged=true、driver已完成，并与brain汇总记录的源文件SHA256一致。缺失、未知格式、哈希不一致均明确失败；不读取可能已经更新的工作区源码，不把这种记录核验冒充Git提交字节核验。逐提交证明仍可单独保存。
- 对唯一绑定身份的pick/place单独报告Judge一致、假阳性、假阴性及无法核验数。必须有动作窗口内grab/release记录、对应前后观测、无歧义的同tick真值样本。pick核对接受的抓取事件与最终持物身份；place核对释放前身份、空夹爪、最终区域位置和动作窗口内未撤销交付事件。缺少身份、动作或同tick证据就标记无法核验。其他动作不套用抓放判据，对照本身不增加任务验收门槛。
- 失败轮次保留总数，并将确定性动作失败、执行/模型异常、已知评估停止后的末轮NOT_RUNNING分开。停止后异常仍保留整局失败，不能解释为自主完成。历史停止文件的两个实际格式均被识别；只有时间、末轮、错误类型相符时才单列。
- 时间线表头改为“最终未撤销交付事件”，不再将一个仍存在但最终位置不合格的事件称为“最终有效送达”。模型调用数明确包括修复与传输重试。

原200轮/1200仿真秒到限失败、两球任务定义、最终持物排除、禁止桥方法、执行异常与不完整记录等门槛没有放宽。

## 验证

新增合成回归在v1上复现 **34失败、21通过**；v2上 **55全部通过**。完整输出分别在 `before-tests.txt` 和 `after-tests.txt`，源码与测试SHA256保存在 `checks.json`。合成用例覆盖过期终态、虚假done、缺失源码/证据证明、抓放Judge两方向误判及缺证据、外部停止归类和交付事件标签。

对已结束run07的新复算见 `historical-run07-v2/REPORT.md`。正式结果仍是FAIL：54轮、57次模型调用、249.92仿真秒、266次观测。8个brain/driver记录哈希核验通过，结束样本tick12496一致。12个失败轮次分为11次动作失败、1次评估停止后错误；唯一pick独立核验一致，无假阳性、假阴性或无法核验的pick/place，另53个动作明确不在该对照范围。该局没有place，不能用它声称真实放置Judge已验证。

run07旧 `report/REPORT.md` 和 `report/evaluation.json` 的字节与已提交版本一致，记录在 `checks.json`。新复算不是重新运行机器人或模型，也不改变原局FAIL。

```sh
python3 -m pytest tests/test_brain_evaluation.py -q
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-07/map-05-run-1 --out <新的报告目录>
```
