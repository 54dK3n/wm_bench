# 功能分支独立兼容性复核

被测实现：`f8fb61d7689403ebf44156047374aad6393a4b9a`。迁移基线：
`0ea653925610c67856d807b7b8b6892fdc227e17`。

- 功能分支全部测试：168 passed，0 failed，0 skipped。
- 从迁移基线 Git 对象原样提取的全部测试：130 passed，0 failed，0 skipped。
- 两套测试均显式导入功能分支的 `world_model` / `judge`；逐个已加载模块验证来源。
- 测试前后被测 Python 文件 SHA256 一致。没有修改源码或运行仿真。

结果与输入散列见 [result.json](branch-f8fb61d/result.json)，原始输出见
[功能测试日志](branch-f8fb61d/feature_tests.txt)及
[基线测试日志](branch-f8fb61d/baseline_tests.txt)。

从项目根目录复跑本次分支核验：

```bash
python3 artifacts/worldmodel-return/feature/reproduce.py \
  --source /private/tmp/wm-bench-worldmodel-integration-20260924 \
  --baseline-rev 0ea6539 \
  --out artifacts/worldmodel-return/feature/recheck
```

默认测试当前 vendor；其结果取决于 vendor 当前版本，不会借用旧日志宣称通过：

```bash
python3 artifacts/worldmodel-return/feature/reproduce.py
```

若被测源码目录没有保留基线 Git 对象，可另传
`--baseline-repo /path/to/WorldModel`。原测试先复制到临时目录，内容保持原样；
运行禁用 `.pyc` 和 pytest cache，不写被测目录。报告保存精确提交、测试和被测
Python 文件散列、实际导入路径、退出码、JUnit 计数。此验证不执行阶段 C。
