# 版本能力与抓取授权审计复核

本轮基线为 `10e3c879d2499d6f893151f24857c315f12fe2e7`。本复核只运行公开合成输入的审计函数、单元测试及旧公开日志的只读复算；没有运行模型、平台仿真或正式总评测器，没有读取 record、capture 或真值，没有改写旧结果。

## 缺口与明确合同

原 `audit_observed_ledger` 只对 Runtime v15 强制 `grasp_chain` 和 `release.command_ref`。在真实 Perception/WM/Actions 生成的合成链上，同时删除两字段及对应动作输出中的引用后，声明 v17 的完整函数调用可返回 `failures=[]`。复现见 `raw/audit/v17-missing-both-before.json`。这是函数级兼容缺口，**不等于已经证实伪造输入能通过 `evaluate_run` 整局验收**。

现在使用精确版本白名单，不使用字符串或数字大小比较，也不把未知版本推定为旧版。

| Runtime 声明 | 允许的合同 |
| --- | --- |
| v1–v14，逐版显式列出 | 保留原同动作 holding/bridge grab 连接、释放边界与同帧几何审计，以及旧 discovery v1。没有命令链不能跨动作确认抓取；若提供 chain/ref，仍按原规则核验。 |
| v15–v17 | 必须提供完整 `grasp_chain` 与 `release.command_ref`，discovery 必须 v2。保留各历史输入的原证据语义，不追加 v18 授权要求。 |
| v18 | 上述完整命令链，再要求 `brain-grab-authorization/v1`。 |
| 缺失、未知或格式不符 | 明确拒绝，不产生 verified 抓放行。 |

v18 授权审计把授权对象快照与真实 grab 前的原观测对象、frame/index/tick、holding、里程计和命令引用连接起来。从原始同类别每个框、camera 参数及 M5 转换重算位置，再从全部同类历史对象复算门控竞争与双向唯一性。声明的 `authorized` 和候选矩阵不能自行证明有效。原 `CONFIRMED`、无身份歧义及完整持物连续性要求保留。22.5 cm / 3° 来自基线 `_pick_action` 的原执行门；WM 门控读取未改的静态 profile。

原 raw 与 `Perception.last_evidence.detections` 保持逐项对应；窗外或低置信框可能不进入 WM，但没有从转换证据消失。测试包含未入 WM 的无关蓝框、无关无法投影的 storage 框，以及同类别竞争框，分别验证合法目标不误拒、竞争不漏检。无法投影的非球行在生产者候选矩阵中保留空行。

## 验证与复算

最终命令（仓库根目录执行）：

```sh
PYTHONPATH=vendor/wm_kit_opt2:. python3 -m pytest -q \
  tests/test_brain_evidence_capabilities.py \
  tests/test_brain_pending_grasp_audit.py \
  tests/test_brain_grab_authorization.py \
  tests/test_brain_discovery_lifecycle_audit.py \
  tests/test_brain_unknown_discovery_evaluation.py \
  tests/test_brain_evidence_reliability.py \
  tests/test_brain_stage1_evaluation.py
```

结果 **240 passed**，其中新增能力/授权合同 133 例。覆盖 v15/v16/v17/v18 的完整正链、删除字段、冲突引用、重复 grab、缺真实 grab、未知版本拒绝及延迟确认；授权反例覆盖旧帧、假距离、假布尔授权、删除 raw、同帧双框、竞争身份和错命令。`raw/audit/final-directed.json` 保存命令、源码前后 SHA 相同检查及选定 AST 指纹，完整输出在同名 `.txt`。

修前有效红测：`capabilities-final-red.txt` 为 37 failed / 57 passed；新增 v18 授权红测 `authorization-contract-red.txt` 为 8 failed / 1 passed。所有中间日志保留；更早 `capabilities-red.txt` 是 Python 搜索路径错误，`capabilities-red-with-path.txt` 尚有误选 `release_unverified` 行的测试夹具错误，二者不作为有效缺口结论。

最后独立读取 `raw/grab/lifecycle-examples-final.json`，不调用其生产者，重新审计全部九例：9/9 无审计失败。合法链实际产生已验证抓放；拒绝场景没有非法 pick/place 账本，**其审计无失败不表示任务完成**。复算命令：

```sh
PYTHONPATH=vendor/wm_kit_opt2:. python3 \
  artifacts/autonomous-brain/grab-sampling-contract-20260927/scripts/recheck_grab_examples.py \
  --input artifacts/autonomous-brain/grab-sampling-contract-20260927/raw/grab/lifecycle-examples-final.json \
  --output /tmp/grab-audit-new.json
```

本轮对应结果为 `raw/audit/producer-consumer-final.json`；脚本仅接受尚不存在的输出文件。以上是合成生产者→独立消费者联通，不能替代正式局验证。

## 原 r34 结论保持

原运行仍声明 `autonomous-brain-runtime/v17`。r34 的 `brain-000854` 实际 grab 前 o184，`target_027` 原对象状态为 **STALE**。基线及本轮 helper 都拒绝该原链；本轮为 `pick_command_identity_confirmation_chain_invalid`、`delivery_release_command_reference_invalid`、`delivery_missing_prior_verified_pick`。没有修改其状态、版本、观测或结果。

复算入口读取且只读取五份公开脑日志，要求仓库中可读取上述基线 Git 对象。旧证据恢复位置可通过 `--brain-dir` 指定，输出必须新建：

```sh
PYTHONPATH=vendor/wm_kit_opt2:. python3 \
  artifacts/autonomous-brain/grab-sampling-contract-20260927/scripts/recheck_historical_public.py \
  --brain-dir artifacts/autonomous-brain/executable-recovery-20260927/raw/formal-stage1/map-05-run-1/brain \
  --output /tmp/historical-r34-audit-new.json
```

本轮结果为 `raw/audit/historical-r34-final-audit.json`，退出 0，原文件读前读后逐项 SHA 相同：

| 原公开文件 | SHA256 |
| --- | --- |
| summary.json | `42fb52e45ba60ef00bb0d94b0008330f47a69ed213f42920a63657132b7ce5a6` |
| observations.jsonl | `8219c632d50cd078cf2f3877baf0c7f580dce8b00c3baed19b2b2f32073d05df` |
| rounds.jsonl | `4fe18cfa2a6780e0ae3ff71dc6be2b9e546877440f386d7b9ace26d0bbc5b48a` |
| bridge-calls.jsonl | `4b2cc9f638006007080bda6057253a5c291a0376d855245560d978131ee9c299` |
| motions.jsonl | `de2940ed92b3f135c488d0045472cfef9d0f8b3ee30346c0cd3ea2f0e096642a` |

最终 helper SHA256：`bc7507957d7212c56211b4de426a6260763d72237b4375cf4503d650608e103b`。只为旧合成测试夹具补充明确 v14 声明；真实历史转录与 summary 未改。本范围源码与测试已停止编辑，联合门及正式运行由主任务另行决定。
