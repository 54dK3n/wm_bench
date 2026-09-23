# opt-1 首次冻结过滤器测试：FAIL

规则于 2026-09-23 13:33:37 UTC 冻结，首次测试于 13:34:27 UTC 执行。本次只读核对全部 10 个布局、133 次 observe、168 条红蓝检测；168 条均精确绑定原生 PNG、同次 renderTruth 和 query。unknown=0，ambiguity=0，wrong-class=0。规则/评测代码与运行中 round-1 的 22 项源码清单均保持冻结哈希。

独立复算检查：PASS；标签、M5 距离、全部对象关联、逐帧决定及汇总均与原测试一致。详见 [independent_review.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/filter-test-v1/independent_review.json)。此处完整性 PASS 不代表过滤性能 PASS。

## 原始计数与过滤性能

误杀率 = 过滤真检测 / 原真检测；过滤 precision = 过滤假检测 / 全部已标过滤检测；残余假占比 = 保留假检测 / 全部保留检测；假检测存活率 = 保留假检测 / 原假检测。

| 类别 | 原始 真/假 | 过滤 真/假 | 保留 真/假 | 误杀率 ≤2% | precision ≥95% | 残余假占比 | 假检测存活率 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 红 | 59：40/19 | 1/10 | 39/9 | 2.5000% | 90.9091% | 18.7500% | 47.3684% |
| 蓝 | 109：11/98 | 2/10 | 9/88 | 18.1818% | 83.3333% | 90.7216% | 89.7959% |
| 合计（非门限） | 168：51/117 | 3/20 | 48/97 | 5.8824% | 86.9565% | 66.8966% | 82.9060% |

红、蓝各自的误杀与 precision 四个性能门均失败。旧置信度 baseline 在本测试拒绝 0 条：红蓝误杀率均 0%，precision 无分母，必须写 undefined，不能据此 PASS；baseline 原假占比分别为 32.2034%、89.9083%。候选单独运行与追加到 baseline 的结果相同。

## 逐条误杀

下表 line、det 均为原始 JSON `lines` / 红蓝 `raw` 数组的 **零起始下标**，不是物理文本行号。真值距离为机器人中心水平距离；方位比较为相机系。

| map / line / det / tick | 原始距离 cm / 方位° / confidence | 同色真物体 | 方位误差° | M5距离 / 真距离 / 径向残差 cm | 拒绝阈值 |
|---|---|---|---:|---|---|
| map-04 / 1 / 1 / 0 | 29 / -0.14 / 0.79 | guangyang-distractor-2 | 0.140000 | 36.321975 / 40.927500 / 4.605525 | confidence < 0.80 |
| map-09 / 24 / 2 / 3453 | 100 / 36.62 / 0.77 | guangyang-distractor-1 | 0.300555 | 132.721071 / 146.581851 / 13.860780 | confidence < 0.80 |
| map-10 / 62 / 1 / 1798 | 100 / 2.48 / 0.83 | guangyang-target-1 | 0.015097 | 108.740502 / 125.459707 / 16.719205 | confidence < 0.84 |

三个误杀全部位于旧 WM 40–90 cm 窗外，但距离窗是后续 WM 可用性，不是当前过滤器拒绝规则，不能从分母删除。map-09、map-10 的 100 cm 读数按冻结要求机械计算 M5 并计入标签；这不表示运行时可将封顶值用于精确定位。

三个 PNG 已逐张查看，均为有效场景图像。map-04 中央可见蓝色物体及青色标记重叠；map-09 的对应物体接近远处视野边缘，单凭缩放图无法无歧义辨认；map-10 道路前方花坛附近可见小红色物体。图片查看不替代冻结的几何标签，也不能仅凭几何匹配证明检测连通域来自该物体。

- [map-04 原始 JSON](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/map-04.json)；[同次 PNG](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/attempts/attempt-007.vision/evidence-000007-tick-0.png)；frameId=7，evidenceId=vision-1，querySeq=8，capture/evidence/frame/query/log tick=0。
- [map-09 原始 JSON](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/map-09.json)；[同次 PNG](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/attempts/attempt-005.vision/evidence-000866-tick-3453.png)；frameId=15，evidenceId=vision-9，querySeq=867，capture/evidence/frame/query/log tick=3453。
- [map-10 原始 JSON](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/map-10.json)；[同次 PNG](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/attempts/attempt-009.vision/evidence-000465-tick-1798.png)；frameId=11，evidenceId=vision-5，querySeq=466，capture/evidence/frame/query/log tick=1798。

## 冻结独立场景分组的检测数

按 stage-1 round-3 已冻结的 9 个独立目标轨迹场景分组。每格格式为「原始数（真/假）；过滤真/假」。原始性能分母仍为全部 168 条检测；这里提供场景内检测计数，不把布局数当作检测分母。

| 独立场景 | 布局 | observe帧 | 红色 | 蓝色 |
|---|---|---:|---|---|
| S01 B 场景 | map-01, map-03 | 14 | 9（6/3）；0/2 | 15（1/14）；0/1 |
| S02 C 场景 | map-02 | 6 | 8（6/2）；0/1 | 2（0/2）；0/0 |
| S03 C 场景 | map-04 | 9 | 3（3/0）；0/0 | 6（3/3）；1/0 |
| S04 C 场景 | map-05 | 9 | 3（3/0）；0/0 | 5（0/5）；0/1 |
| S05 D 场景 | map-06 | 10 | 5（5/0）；0/0 | 12（0/12）；0/2 |
| S06 无对应真球 场景 | map-07 | 52 | 12（3/9）；0/4 | 43（2/41）；0/6 |
| S07 C 场景 | map-08 | 9 | 3（3/0）；0/0 | 4（0/4）；0/0 |
| S08 E 场景 | map-09 | 16 | 10（5/5）；0/3 | 11（3/8）；1/0 |
| S09 D 场景 | map-10 | 8 | 6（6/0）；1/0 | 11（2/9）；0/0 |

S01 的 map-01 / map-03 为重复目标轨迹，同一个独立场景，只列一次组计数。两局的完整观测记录并非逐帧红蓝全等：冻结分组算法剥离了蓝色检测和确认前巡逻，所以不得将该组声称为两个独立场景，也不得据此自动删除其中一局的所有蓝色检测。成员拆分如下：

| S01成员 | observe帧 | 红色 | 蓝色 |
|---|---:|---|---|
| map-01 | 7 | 5（3/2）；0/1 | 9（1/8）；0/0 |
| map-03 | 7 | 4（3/1）；0/1 | 6（0/6）；0/1 |

## 两个极端自检与证据

| 类别 | 全保留误杀率 | 全保留 precision | 全过滤 precision = 原假占比 | 自检 |
|---|---:|---|---:|---|
| 红 | 0.0000% | undefined | 19/59 = 32.2034% | PASS |
| 蓝 | 0.0000% | undefined | 98/109 = 89.9083% | PASS |
| 合计 | 0.0000% | undefined | 117/168 = 69.6429% | PASS |

独立审计逐条重新读取原始 observe、query、renderTruth 和 PNG，检查 runId、frameId、evidenceId、同 tick、同 stateRevision、PNG 长度/哈希、原始检测顺序以及决定索引完整分区。核验全部 149 张原生 PNG，总计 35,209,096 字节；各局分别均在 20 MiB 原生预算内（十局合计不是单局预算分母）；逐文件哈希与字节数保存在独立 JSON。冻结规则 SHA256：`fe953d2e4f63db981e5eea33ff95dbedf524ed8f9a965046c12b830479c43659`。

复现使用已冻结的 `tools/detection_evaluation.py`，指定 `--dataset test --filter-file programs/detection_filter.py --freeze-manifest artifacts/inloop/opt-1/filter-test-v1/freeze_manifest.json --out <新的输出目录>`；不得覆盖首次测试产物。独立核对采用同一冻结定义、独立公式与聚合，不导入评测器或运行时规则。当前报告只记录首次封存测试失败，不开发新规则、不更改控制程序、不启动额外仿真。
