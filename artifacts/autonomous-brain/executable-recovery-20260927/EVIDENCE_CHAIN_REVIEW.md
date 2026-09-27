# 正式局抓放证据链拒绝的只读复核

本次复核不修改冻结源码、审计规则或原结果，不重新运行评测、模型或仿真。评测文件只查阅 `task_scope.observed_evidence`、`action_identity_audit`、`source_proof`；细节由公开脑端观测、动作、运动和桥接引用复算，未读取评测 `perception`、布局、record 或 captures。

结论：三条拒绝由 r34 第二次实际 `grab` 前对象为 **STALE** 引起，随后级联到交付链。它不满足冻结审计明确要求的抓取前 **CONFIRMED** 门。不存在把该门重新解释为 `ever_confirmed` 的新授权，不能定性为纯审计 false-negative，也不能据此宣布已有效交付。原评测 FAIL 保持；脑端交付账本 1 项与独立观测命令链验收 0 项须分别报告。`action_identity_audit` 的两项 Judge match 是另一种动作判断，不能覆盖本链拒绝。

## 逐项原因

| 拒绝 | 首个具体断点 / 因果 |
| --- | --- |
| `pick_command_identity_confirmation_chain_invalid` | `tools/brain_evidence_audit.py:187–190` 查第二次 grab 的 `before_observation=184`，要求唯一对应对象 `state=="CONFIRMED"`。公开观测 184 的 `target_027.state` 实际为 `STALE`，因此在此返回 False，再于 243 行报告拒绝。 |
| `delivery_release_command_reference_invalid` | 被拒 pick 没有进入 `pick_commands`（245–247 行仅成功才登记）。释放引用的 `grasp_request_id="brain-000854"` 与 `pick_commands.get("target_027")=None` 不等，在 366 行触发，371 行报告。不是找不到释放命令本身。 |
| `delivery_missing_prior_verified_pick` | 同一被拒 pick 没有进入 `successful_picks`；372–373 行要求交付前已有独立验证的 pick，因此再次拒绝。 |

r34 的动作入口观测 181，以及第一次失败 grab 前观测 182，仍为 CONFIRMED。第一次 `brain-000844`（182→183）后 holding=false；随后前进 6 cm 到观测 184，对象已衰减为 STALE。第二次 `brain-000854`（184→185）后 holding=true。观测 184 仍有 `ever_confirmed=true`、8 个历史 hit、相同记录位置且没有 `identity_ambiguity`，但这些事实不满足上述字面状态门。

冻结动作实现 `autonomous_brain/actions.py:1816` 在 pick 入口取得 confirmed 对象；1830 行后的重试继续使用该目标记录，1914 行在失败后前进 6 cm；第二次抓取前没有重新要求当前对象状态为 CONFIRMED。1857–1885 行把真实第二次命令及其实际观测边界记入链。这里是动作入口/近场重试语义与审计“每次实际抓取前状态”的差异，不是引用编号应改成第一次 grab；第一次 grab 并没有夹住物体。

## 公开引用核对

令 `B=raw/formal-stage1/map-05-run-1/brain`，下列 JSONL 行号均从 1 开始，与文件实际行号一致：

| 输入 | 定位与可核事实 |
| --- | --- |
| `B/rounds.jsonl:34` | pick `target_027`，动作窗口 181→191，确认观测 190；`result.evidence.grasp_confirmation` 与 summary pick 的 `grasp_chain` 相同。 |
| `B/observations.jsonl:181–185` | 181/182/183 为 CONFIRMED；184 为 STALE、holding=false；185 为 STALE、holding=true。184 原位置与 grab 原位置相同。 |
| `B/motions.jsonl:115–117` | 第一次 grab 182→183；前进 6 cm 183→184；第二次 grab 184→185。有效夹持链引用后者。 |
| `B/bridge-calls.jsonl:853–858` | 853 为 observe(frame184)，854 为 grab `brain-000854`，857 holding=true，858 observe(frame185)；grab terminal completed 与 motion 回执相同。 |
| `B/observations.jsonl:185–190` | 六条连续 holding=true，与保存的 holding_observations 按 observation/frame/tick 对应。190 是后退 30 cm 后的原位置检查见证；这不补足 184 的状态门。 |
| `B/summary.json:6095` | `action_evidence[0]` 为 pick；`[1]` 为 release_unverified；`[2]` 为 place。pick `post_observation=190`，place 释放边界 349、几何见证 350。 |
| `B/rounds.jsonl:52` | place 窗口 344→351，post_observation=350，引用 release `brain-001638` 与 grasp `brain-000854`。 |
| `B/motions.jsonl:245` | release 348→349；round=52，参数/terminal 回执与桥日志对应。 |
| `B/bridge-calls.jsonl:1637–1642` | 1637 observe(frame348)，1638 release，1641 holding=false，1642 observe(frame349)；sequence/requestId/method 均匹配。 |
| `B/observations.jsonl:348–350` | 348 对象为 HELD、holding=true；349/350 holding=false。185→348 夹持读数连续为 true，190 之后至 release 前没有额外 grab/release。 |

释放引用的对象、method、round、before/after、bridge sequence、requestId 和 actuator result 均能直接对上公开日志。失败的是它依赖的“已被审计接受的上游抓取”，而不是将 1638 改成另一个桥编号即可解决。独立评测也未把本次交付列为缺失释放原语、重复几何见证或动作窗口不匹配。

`source_proof.status=verified` 且 failures 为空；`action_identity_audit.failures` 为空、其两项 prefix Judge 为 match。这些分支与 observed_evidence 的三条拒绝并存，必须一起保留，不能只选择其中通过的一支。

## 不执行审计器的最小复算

在仓库根目录执行下列只读提取即可复核首个状态断点及直接命令引用；它不导入或运行评测器，不输出真值字段：

```sh
python3 - <<'PY'
import json
from pathlib import Path
r = Path('artifacts/autonomous-brain/executable-recovery-20260927')
b = r / 'raw/formal-stage1/map-05-run-1/brain'
def rows(name):
    return [json.loads(x) for x in (b / name).read_text().splitlines()]
obs = {x['observation_index']: x for x in rows('observations.jsonl')}
motions = rows('motions.jsonl')
bridge = rows('bridge-calls.jsonl')
summary = json.loads((b / 'summary.json').read_text())
chain = summary['action_evidence'][0]['evidence']['grasp_chain']
grab = chain['grab']
oid = chain['object_id']
before = [x for x in obs[grab['before_observation']]['objects'] if x['id'] == oid]
print('grab_before', grab['before_observation'], before[0]['state'],
      'strict_confirmed_gate', len(before) == 1 and before[0]['state'] == 'CONFIRMED')
ref = summary['action_evidence'][2]['evidence']['release_observation']['command_ref']
motion = [x for x in motions if x['method'] == 'release'
          and x['after_observation'] == ref['after_observation']][0]
commands = [(i, x) for i, x in enumerate(bridge, 1)
            if x['request']['requestId'] == ref['bridge_request_id']]
print('release_direct_reference', len(commands) == 1
      and commands[0][0] == ref['bridge_sequence']
      and commands[0][1]['request']['method'] == ref['method'] == 'release'
      and all(ref[k] == motion[k] for k in ('round', 'before_observation', 'after_observation'))
      and commands[0][1]['terminal']['result'] == motion['actuator_result'])
print('release_names_actual_grab', ref['grasp_request_id'] == grab['bridge_request_id'])
print('holding_185_to_348', all(obs[i]['holding']['holding'] is True for i in range(185, 349)))
e = json.loads((r / 'raw/evaluation/formal-stage1/evaluation.json').read_text())
audit = e['task_scope']['observed_evidence']
print('original_failures', audit['failures'])
print('accepted_picks', sum(x['verified'] for x in audit['picks']),
      'accepted_deliveries', sum(x['verified'] for x in audit['deliveries']))
PY
```

预期：抓前 `184 STALE strict_confirmed_gate False`；直接 release 引用、引用实际 grab 和连续 holding 均 True；原三条 failures 保留，accepted_picks=0、accepted_deliveries=0。该提取不宣布其他未执行审计分支通过，也没有用修改输入或规则的方式算一个替代成绩。

复核输入 SHA-256：`evaluation.json` 为 `9cb2b17b000841eb32068d64ac594f4ec6be6c00cb2f6e9383593956bdbd1758`；`B/observations.jsonl` 为 `8219c632d50cd078cf2f3877baf0c7f580dce8b00c3baed19b2b2f32073d05df`；`B/bridge-calls.jsonl` 为 `4b2cc9f638006007080bda6057253a5c291a0376d855245560d978131ee9c299`；所读 `tools/brain_evidence_audit.py` 为 `595000b19e886182c538234372865a5606ee96f2a89cfd5de2ad045f743c1c93`。
