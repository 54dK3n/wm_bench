# 第 2 轮运行前记录

状态：尚未运行；待最终预检通过后由批跑器冻结全部依赖并开始十布局各一次。

- PROGRAM_VERSION：wm-opt2-r2-20260924
- 原始程序 SHA256：`90191e8764de3b98cd4251341f582a60e4b097e98453273bf5b5ab2eefe0a029`
- wm_kit 提交：`326a5f8892b9da11996b5f3d3d0fc56341aca6e4`
- 嵌入包 SHA256：`61308c1c20270ec31d8ee5870ed2b01bf6920075e4820e5fc8c30bd2e626f1fb`
- 本轮依据：第 1 轮完整十布局，双球送达 2/10（独立场景 2/9），成功局用时中位 320.55s。
- 回归检查：上一轮成功的 map-05、map-10 所在独立场景必须继续成功；第一球抓取及其他下降另列，不隐藏。
- 改动、数值依据与风险见 [CHANGES.md](CHANGES.md)。没有新增布局分支、测距模型或过滤器规则。
- 运行前检查结果由 preflight.json、pylint.txt、tests.txt、driver_tests.txt、static_coordinates.json 保存；本文件不预填通过数。
- 批跑后检查原始与实际加载代码 SHA、全部冻结依赖、原生record/PNG/查询/完整终端字节，再由相同离线判定器汇总。历史导出错误不得因最终补齐而抹除。

本轮命令（由执行台账阻止重复布局）：

```sh
python3 -u tools/run_opt2_batch.py --program programs/world_model_opt2.py --out artifacts/inloop/opt-2/round-2
```

本轮退出门仍为双球送达≥8/10、P3.4首选最优≥8/10、成功局总用时中位≤300s、无回归，以及全部固定规则与预算。最多三轮不变。赛题1未运行；阶段4尚未授权。
