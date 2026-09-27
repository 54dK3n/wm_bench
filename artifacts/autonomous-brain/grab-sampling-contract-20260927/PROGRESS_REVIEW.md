# 采样失败上下文与重试依据

`SamplingProgress.readiness` 现在将当前条件与规范目标保留的全部失败后置上下文逐一比较；任一等价旧条件没有实质新证据时阻止重试。摘要保留最后失败、实际阻止重试的失败、失败上下文数量及解锁原因集合，最近尝试仍至多三条。完整证据保留各尝试的失败类型、采样意图、计划视角和原观测。`find` 合并感知已经证明相关的别名组时合并全部义务，不因换一个发现 ID 清空失败。

新增 hit、首次新视角、相关净空变化、有效失视后重获和新验证的逆向路径可作为重新评价依据；frame/tick 增加本身不是进展。新路径入口由 `Runtime.observe` 在登记实际运动后，调用采样器同一严格逆路径验证器，记录六个有限长度的可执行支持集合。只有新增真实支持长度才算新路径依据；新增 segment ID 或同一路径重分段不算。执行前仍重新核验完整路径和当前净空。原确认与执行门未改变。

`tests/test_brain_sampling_context_history.py` 的 0°→10°→0° 是函数级进展门探针：真实 Perception/WM 提供身份及 hit，但单独假定视角入口许可，不声称绕过另一个源像素兼容门后可实际采样。它没有写 CONFIRMED，也没有发出机器人动作。原始初版探针被源像素门提前拒绝，保存在 `raw/progress/first-red.txt` 和 `baseline-red.txt`，不能把这些提供器失败当成进展门反例。选定函数级反例在 `selected-red.txt`，修复前 3 失败/2 通过；其中新增摘要字段断言属于新契约，循环与别名遗失是行为反例。

真实动作联动正例从同一位姿的一次合法发现开始，记录失败后后退 20cm、前进 20cm 返回原位。后退视角越出原确认窗口，没有生成新 hit；原位重新观测也没有生成新 hit，但这次真实路径获得了严格验证的逆向支持，因此允许重新评价。再记录一次失败后仅新帧不会继续解锁。运动均使用冻结平台 normalizeCommand。

复算：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 -m pytest -q tests/test_brain_sampling_context_history.py tests/test_brain_sampling_progress.py
```

本部分联动与函数回归合计 20 项通过，见 `raw/progress/path-context-green.txt`。它们属于局部验证，不是正式阶段 1 成绩；最终整体验收以 GATE.json 和本轮正式/未运行状态为准。
