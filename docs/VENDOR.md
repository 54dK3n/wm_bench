# WorldModel 来源

- 项目来源：<https://github.com/54dK3n/WorldModel>
- 本次快照：`326a5f8892b9da11996b5f3d3d0fc56341aca6e4`
- 阶段 1 基线：`ad237a143f0d35e100a28c15567d4b75bd56cccf`
- 文件：`vendor/wm_kit_opt2/`
- 历史备份：`artifacts/inloop/opt-2/wm-kit-action-evidence/wm_kit_opt2.bundle`

主仓库将 vendor 内容保存为普通文件，避免指向本机路径的不可克隆 gitlink。现有工作目录中的嵌套 `.git` 保留在本机并被忽略。新 clone 不会自动获得此嵌套元数据；需要独立 WorldModel 历史的构建器应从 bundle 克隆，见根目录 README。

保留原 README、作者署名、设计说明和测试。未发现上游 LICENSE/COPYING 文件，本次不替作者授予新许可证，也不将其默认标为 MIT 等许可证。
