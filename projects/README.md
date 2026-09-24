# 子项目目录

此目录集中保存统一比赛平台的三个独立运行引擎：

- `car-python/`：Python 编程、正式账户与地图源；
- `blockly-page3/`：Blockly 积木编程；
- `tmm/`：识物工坊。

日常应从上一级 `competition-platform` 目录执行 `npm run start:all`，由统一启动器按正确顺序启动三个子项目和网关。各项目自己的运行数据仍保存在各自目录内，历史备份统一放在上一级 `record-backups/`。
