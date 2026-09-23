# round-2 改动清单

相对 round-1，只修改独立过滤器的应用范围及 PROGRAM_VERSION/嵌入过滤器 SHA256。置信度阈值仍为红 .84、蓝 .80；只在原有 40≤distanceCm<90 窗口内抑制，窗外/封顶/无有效距离保留供规划。没有新增拟合数值，40/90 复用现有 WM 窗口。

测距修正、确认、WM 融合、视点规划、接近/抓取和送货函数保持不变，见 pre_run_review.json 和 round1_to_round2_review.diff。原始检测先完整记录，再打印过滤决策；100cm 不进入 WM，仍只用于方位规划。

来源与代价：../filter-candidate-v2/DEVELOPMENT.md 与 constant_provenance.json 列出每条规则三个独立开发场景及日志值；INDEPENDENT_DEV_REVIEW.md 已重建完整轨迹核实。v2 开发集多保留 53 条已标伪检测与 36 条未知检测；被过滤的 10 条未知不算伪检测。

**测试已污染**：v1 冻结测试反馈影响 v2 选型；本轮 filter-test-v2 的回放只作为回归数值，不是独立泛化证明。所有 168 条原始检测和原标签完整保留在评测分母；v2 实际保留 162 条、过滤 6 条。规则再次冻结后才回放，参见 ../filter-test-v2/freeze_manifest.json 与 evaluation_record.json。

运行前检查：178 项测试通过，指定 pylint 五类错误为 0；坐标常量、真值 API、target anchor 检查通过。preflight.json 与 tests.txt/pylint.txt 保留完整输出。批跑开始后程序及 code_manifest.json 中的文件冻结，十布局各执行一次。

版本与身份：

```json
{
  "version": "wm-opt1-r2-20260924",
  "file_sha256": "25590162d87b90c4dcb6c1d9766d7e62a115bfc07f68c709c8a61fb75fd78e34",
  "wm_kit_commit": "ad237a143f0d35e100a28c15567d4b75bd56cccf",
  "wm_embed_sha256": "651a89967b41aad583b70e5f5095c5fc35f6babc950d8ab878748cb69e9f66e3"
}
```
