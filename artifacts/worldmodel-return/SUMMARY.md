# B · WorldModel 回流完成

用户选择方案1：先明确迁移契约，再隔离广阳岛功能默认行为。

| 门限项 | 结果与证据 |
|---|---|
| 新分支及 PR 合回主仓 | [PR #1](https://github.com/54dK3n/WorldModel/pull/1)、[PR #2](https://github.com/54dK3n/WorldModel/pull/2) 均已合并；主仓 `fef0ba9b754ce9652836fdb720d1162dcadbc5ef` |
| 主仓全部测试 | 168/168通过、无跳过；[日志](feature/main-fef0ba9/feature_tests.txt)与[result.json](feature/main-fef0ba9/result.json) |
| 广阳岛功能不改变迁移后的默认行为 | 未修改的迁移基线130项测试130/130通过；[结果](feature/main-fef0ba9/result.json)。通用FOV、类别衰减、LOST查询默认恢复；广阳岛显式启用 |
| vendor 与主仓逐字节一致 | `vendor/worldmodel.lock.json` 绑定主仓提交及完整文件散列，校验命令见下 |
| 广阳岛旧配置保持 | 冻结 opt-2 round-3 实际嵌入包与新工厂，35场景、168操作逐步相等；[结果](guangyang-equivalence.json)。仅是离线检查，仿真等价留待C |

原始提交 ad237a1、326a5f8 已回流，并用后续修正将广阳岛配置改为显式工厂。旧主仓49项测试在前置契约迁移后为40通过、9失败，原因是尺寸、帧质量、抓持与单次命中契约收紧；该迁移在PR #1中单列且经用户确认。最初vendor额外的LOST默认回归已在PR #2中修正，不隐去旧失败日志。

复算（仓库根目录）：

```sh
python3 tools/verify_worldmodel_vendor.py
python3 tools/compare_guangyang_factory.py
python3 artifacts/worldmodel-return/feature/reproduce.py --out /tmp/wm-return-check
```

最后一项需基线Git历史；无嵌套Git的新clone可将 `--baseline-repo` 指向从上游克隆的仓库，并使用 `--baseline-rev c3cbed8`（文件树等于原0ea6539）。冻结的原始测试兼容日志保留在本目录，不修改旧实验数据。
