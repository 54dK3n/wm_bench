# 主动确认采样：局部通过，冻结候选阶段1 FAIL

冻结源码 [`dec5b078d6711bdfda972ca4632c200e235dfb7e`](https://github.com/54dK3n/wm_bench/commit/dec5b078d6711bdfda972ca4632c200e235dfb7e)，基线 `69376055870d430a6b82db971eb9607309cfdb3d`。开发分支为 `codex/autonomous-brain`，指定远端为 `54dK3n/wm_bench`；冻结提交已正常推送并从远端重新查询确认。没有force push、回退用户修改或重写历史。

本候选唯一正式阶段1为 **FAIL**：map-05，“把两个红球送到绿色存放区”，达到 **200轮**上限，**1047.64仿真秒、948观测、206模型调用、1/2有效交付、done=0**。阶段2未运行、未验收，十布局与真机未启动。失败后未修改冻结源码、未追加正式局；当前工作仅为只读复算与证据交付。

历史d1538f7阶段1 PASS、1117336阶段1 FAIL及其阶段2未运行状态均保留。原历史全局2 match/2 unverifiable、前缀4 match不覆盖，也不与本局统计混用。

## 修复和验证层次

[REVIEW.md](REVIEW.md)列明本轮修复与边界；[CONTROL_REVIEW.md](CONTROL_REVIEW.md)和[DISCOVERY_REVIEW.md](DISCOVERY_REVIEW.md)提供具体入口。

| 层次 | 本轮证据 | 能证明的范围 |
|---|---|---|
| 函数反例/回归 | Python1448、驱动29、冻结平台15，全过，无跳过 | 用户所列短段、截断前过滤、探索语义、发现摘要和契约反例；不代表整车成功 |
| 合成感知动作联动 | 19项联动测试通过；16代表场景导出为5成功、10安全拒绝、1未知回执异常，核验全部满足 | 真实Perception/WM根据动作后的公开像素获得独立hit；没有假WM“返回确认成功” |
| 历史模型文字回放 | 原v17的200轮/203调用严格一致，网络0 | 原prompt/状态/响应/参数语义保留，不执行后继动作 |
| 新正式闭环 | 唯一map-05局，独立评测FAIL | 本冻结候选尚未完成两球任务 |

本局v18转录另外由冻结评测器严格回放200/200轮、206/206调用，网络0、环境读取0；仅证明记录可复算。源码来源核验verified：driver运行前后manifest相同，12个brain文件与Runtime记录对应一致，平台、实际WM、模型与预算配置匹配。

六个高层动作保持，新增互斥 `explore(discovery_id)`，旧v1–v17记录仍按旧契约回放。原raw窗口40≤距离<90cm、|方位|≤35°、3hit及15cm独立位姿门不改；抓放/完成判据、平台权限、200轮/1200秒上限不改。采样内部最多12步/120cm，比原全局预算更小，不放开TENTATIVE go_to/pick。

## 原完整公开日志的复算

对1117336整局公开脑日志复算：295红框→34条fed检测→15次有效hit；017占4次，其余11个身份假设各1次。首球交付后r79–200共122次explore。后期7个候选有17条fed记录，各自只有1首hit、0新增独立平移位姿。该“0”不表示机器人全程未动；182个pending假设也不是182个物理红球。

旧摘要的插入顺序与最新更新选择在35个决策处不同，另10个决策的当前TENTATIVE/STALE未被原unresolved摘要纳入。但“当前帧仍unresolved且被last6漏掉”的旧局决策数为0；不把函数反例夸大成该局已经发生的所有遗漏类型。详见公开链脚本与输入哈希。

## 本局确认、换位和首次实质阻塞

本局231条原红框→68条fed→15个唯一(track,frame)有效hit；这几个量不能互换。共有6次定向采样（r9、94–98），**0次采样成功、0新增有效hit**；只有r94实际采样移动15.5cm。

- r8/o31产生017的合法首hit，随后同一explore继续take_exit，o32红框消失；r9选择已过期发现，零运动拒绝。017后来经普通探索获得确认，r20抓取，r64放置，o341为新鲜放置见证，o342为DELIVERED。
- r68/o356–357、r69/o358的未关联红框raw59cm、−35.27°在原方位窗外，未入WM。没有通过放宽35°门使其通过。
- r93/o476新096得首hit；r94从o478实际移动15.5cm（端点位移15.5003cm），规划预测仍在有效窗，但o479原始红框列表为空。它是观测缺失，不能指称为身份误绑；公开数据不能区分遮挡和CV漏失。r95–98重复选择已不可见发现，均零运动、零新增hit。
- **这不是整局“第二候选未确认”**：096在r105/o513得第2hit、o515得第3hit并CONFIRMED；r106/o522、524又增至5hit。模型随后正确选择了go_to096。
- **已确认候选抓取链的首个实质阻塞在r106**：o526近场距离41.5409cm、方位4.573°，右净空0.1cm、道路偏角33.3°，安全检查将前进许可限制为0。换位起于o526，真实移动10.6cm后实测航向与记录反向段相差33.3°，严格段到达证据不成立；记录弧长已用尽，返回 `reposition_recorded_arc_exhausted_without_arrival`。请求合法、执行器接受；不是参数被拒、未执行或耗尽全局预算。整次go_to里程101.2cm，不能把它全部算作换位。

全局5次真实候选尝试在r106、110、112、114、116，**到达0、完整换位成功0**。r116曾完成6个历史段，但后续段遇到未记录的路口而拒绝；它不是完整候选到达。原始日志可见27个保留路线版本；内部全量候选枚举没有完整记录，生成总数写为不可得，不用0代替。

完整换位成功定义：当前go_to成功，并有 `road_reposition.status=reposition_and_visual_standoff_verified`；单段运动、累计里程或候选接近均不替代这个定义。详细逐步观测/运动引用、后续链和复算命令见 [FIRST_BLOCKER.md](FIRST_BLOCKER.md)。最终096为曾确认后LOST且仍pending，不能当从未确认假设退役；末局手空、无pending_grasp，121个未解释假设/125条记录是义务数，不是物理球数。

## 正式命令与独立评测

```sh
PYTHONDONTWRITEBYTECODE=1 node tools/autonomous_brain_driver.js --out artifacts/autonomous-brain/active-confirmation-20260926/raw/formal-stage1 --maps map-05 --runs 1 --task '把两个红球送到绿色存放区' --max-rounds 200 --max-simulation-seconds 1200
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/active-confirmation-20260926/raw/formal-stage1/map-05-run-1 --out artifacts/autonomous-brain/active-confirmation-20260926/raw/evaluation/formal-stage1
```

两者退出码均为1，分别表示单局和独立验收失败。完整stdout/stderr在 `raw/gate/formal-stage1-{driver,evaluator}.txt` 及trial目录。最初启动申请曾在进程创建前被自动审批拒绝；核实用户已指定DeepSeek Flash、接收端为官方HTTPS API且请求只有公开仿真状态后，同一命令获准。实际正式进程只启动1次；没有换端点或间接绕过。脱敏核查见 `raw/gate/{authorization-check,launch-authorization}.json`。

独立评测器v8沿用原输入和规则：两次pick/place均match，假阳性/假阴性/无法核验均0；动作前缀Judge亦2 match，未替换全局Judge。117个动作判定失败，执行/模型异常0；原失败列表中的宽泛 `execution_or_controller_error` 标签随原评测保留，不把它错误解读为存在运行时异常。已知数量任务不要求完整地图探索；stage1拓扑/全图发现独立审计为null，没有偷偷增加阶段2的地图门。

开发与公开诊断没有读取布局/真实球ID；冻结后的独立评测器只在评测侧使用既有验收附件，没有把评测数据反馈给大脑。失败之后只读复算，没有借评测结果再补代码或重跑。

## 外部交付

[本轮Release与原始证据](https://github.com/54dK3n/wm_bench/releases/tag/active-confirmation-20260926-dec5b07) · [指标](METRICS.json) · [测试/复算命令](TEST_COMMANDS.md) · [恢复说明](RESTORE.md) · [逐文件SHA256](SHA256SUMS)。完整包SHA256/大小和原件一致性见 `DELIVERY.json`；发布后的匿名下载核验见 `PUBLICATION_VERIFICATION.json`。

raw、record、完整观测/模型日志及压缩包不进Git，也没有拆成bin分片。上传前扫描凭据；原日志不为通过扫描而改写。报告、完整源码和发布复核分别提交，最终交付时重新查询远端完整HEAD。
