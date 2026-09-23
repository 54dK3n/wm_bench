# WorldModel 来源

- 项目来源：<https://github.com/54dK3n/WorldModel>
- 本次主仓快照：`fef0ba9b754ce9652836fdb720d1162dcadbc5ef`
- 前置契约迁移：[PR #1](https://github.com/54dK3n/WorldModel/pull/1)
- 广阳岛功能及默认配置隔离：[PR #2](https://github.com/54dK3n/WorldModel/pull/2)
- 字节锁：`vendor/worldmodel.lock.json`；`python3 tools/verify_worldmodel_vendor.py` 可独立核验
- 阶段 1 基线：`ad237a143f0d35e100a28c15567d4b75bd56cccf`
- 文件：`vendor/wm_kit_opt2/`
- 历史备份：`artifacts/inloop/opt-2/wm-kit-action-evidence/wm_kit_opt2.bundle`

主仓库将 vendor 内容保存为普通文件，避免指向本机路径的不可克隆 gitlink。现有工作目录中的嵌套 `.git` 保留在本机并被忽略。新 clone 不会自动获得此嵌套元数据；构建应使用锁定的 vendor 快照。历史 bundle 仅用于复现旧实验。

运行程序须显式调用 `guangyang_static_world_model(max_range_m=0.9)`，以保持旧广阳岛实例的 FOV、衰减和归档查询行为；通用默认配置已恢复为契约迁移基线。已冻结的实验程序继续保留其原始嵌入包与提交身份，不重新嵌入。

保留原 README、作者署名、设计说明和测试。未发现上游 LICENSE/COPYING 文件，本次不替作者授予新许可证，也不将其默认标为 MIT 等许可证。
