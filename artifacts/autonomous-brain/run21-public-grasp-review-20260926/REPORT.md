# Run21 前 100 轮：公共抓放证据独立核验

核验 PASS 表示保存的**公共传感器见证**可复算。它不代表终局物理任务验收，不证明真实球总数、物理身份或未观测区域状态。没有读取 truth、record、布局或凭据，没有执行模型/仿真/机器人动作，也未修改正在增长的 Run21 日志。

范围固定为 rounds 前 100 行、observations 前 664 行、motions 前 464 行。脚本按二进制逐行读取固定前缀，验证精确原始字节数及 SHA256，复算后再次验证；后续追加日志不影响本审查。未另复制 31 MB 的观测数据；输入仍指向原公共 brain JSONL。

| 输入 | 原始前缀字节 | 原始前缀 SHA256 |
| --- | ---: | --- |
| rounds.jsonl / 100 行 | 5835911 | a619c88e0a2c9c23f850db40e444989c14e66cdcad527f7da28581925a20bb79 |
| observations.jsonl / 664 行 | 31200601 | 1f2c08b384fc9b1433d94050fb82a09da7ccaa8366ee2a6d50566915dc23bdf4 |
| motions.jsonl / 464 行 | 80582 | bfa2b4a3a96b75c1f963dda734693d8bc37d6e73a07f3d9780638c1c41c2491a |

输入清单：[input-manifest.json](input-manifest.json)。可重跑脚本：[review_public_grasps.py](review_public_grasps.py)。[命令与退出码](execution.json)、[stdout](stdout.txt)、[stderr](stderr.txt)、[完整检查与逐动作证据](checks.json)。脚本不导入或运行生产 Actions，仅使用保存的公开数值独立计算。

## 两次 pick

两次起始 round state 和 observation objects 均为目标 CONFIRMED、ever_confirmed=true，夹爪空且 onRoad。每次 grab 对应 motions 中唯一相同 refs/params 的调用；对准 detection 来自紧邻的前观测同一 frame，记忆距离独立由原已确认位置和 odo 复算，满足 ≤22.5 cm，bearing 满足 ±3°。

| 轮/身份 | grab 前后 observation | holding 前→后 | 记忆距离 cm / fresh bearing° |
| --- | --- | --- | --- |
| r25 target_021 | 136→137 | false→false | 18.8707 / 0.4456 |
| r25 target_021 | 138→139 | false→true | 13.2802 / 1.0247 |
| r97 target_112 | 620→621 | false→false | 22.0643 / −0.3445 |
| r97 target_112 | 622→623 | false→false | 16.1709 / −0.7706 |
| r97 target_112 | 624→625 | false→true | 10.4194 / −1.8728 |

成功 holding 后分别 obs139→144、625→630，均为五次 6 cm backward，distanceCm 实际增加 30 cm，所有中间观测仍 holding。obs144/630 fresh camera 对原已确认位置半径 <0.15 m 的同类检测均为 0；原位置分别 (−1.540524201,1.057294147)m、(−0.305392590,1.499144523)m。final obs145/631 状态 HELD。未把夹爪响应单独当成完整抓取成功。

两次复查结束时本已 onRoad，road_return 均为 already_on_observed_road、无额外恢复 motion；它与抓取见证分开记录。接近/后退期间是否离路以每条真实 observation 为准，不把最终 onRoad 改写成“全程未离路”。

## 三次 place

- **r45 失败有据**：obs289 的 green 为左/底裁剪框 [0,312,323,168]、右/底裁剪框 [538,328,102,152] 及高度为 1 的碎片；完整且宽高 ≥3 的区域数为 0。0 motion、0 release，final obs290 仍持 target_021/onRoad。原 complete_storage_region_not_unique 失败未改写。
- **r53 target_021**：obs346 完整 green [153,253,373,94] 为唯一最大（35062 px²，大于另一完整 315 px²），固定中心像素 (339.5,300)，不在扩展 occupied boxes 中。release350→351 holding true→false；后退 25 cm，obs352 完整 green [183,239,268,48] 与唯一新红 [282,210,72,60] 给出 q=**0.0851251361352442 ≤0.64**。原已知红 target_041/045/058 排除集合与 release 前 objects 完全一致；final353 DELIVERED。
- **r99 target_112**：obs654 完整 green [147,247,325,72]，旧 delivered 球可见，free-quarter 选 (390.75,283)，不在扩展 occupied boxes 中。release658→659 holding true→false；后退 25 cm，obs660 完整 green [96,249,290,47]。旧红 [158,212,94,66] 虽 q=0.11641682039047913，仍因 track_id 和 known_delivered_object_id 均为 target_021 被排除。新红 [276,210,88,62] 两身份标记均 null，q=**0.29728979221851587 ≤0.64**，剩余见证唯一。preexisting 集合为 target_021/041/045/058/115，逐项等于 release 前 objects；final661 DELIVERED。

q 使用原门槛：红框底中心相对完整绿框内椭圆的归一化平方和；框/像素是观测见证，不解释为物理中心。所有 ball–green 组合及被排除的旧红均保存在 checks.json，未只挑选通过的一对。

两次成功 place 的全部轨迹 params/refs/odo 与原 motions/observations 一致。obs352/660 已 onRoad，road_return 为 already_on_observed_road、无额外动作；未用归路成功替代放置见证。截止本前缀末 obs664：target_021/112 均为公共 WM 的 DELIVERED、夹爪空、onRoad；未知道路与终局真值不在本报告判定范围内。
