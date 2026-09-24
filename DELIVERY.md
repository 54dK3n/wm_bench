# 辰龙竞赛统一平台交付说明

本说明用于组织方在 Windows x64 机器上部署统一比赛平台。交付 ZIP 包含 Python、Blockly、识物工坊、统一入口、统一后台，以及制作交付包时确认保留的正式用户、队伍、地图、成绩和识物评测集快照。

交付包是**运行快照，不是历史恢复备份**。它只能交给组织方、管理员及授权运维人员，不能发送给参赛者。

## 1. 运行要求

- Windows 10/11 或 Windows Server x64；
- Node.js **22.13 或更高版本**，并包含 npm；
- 足够的可用磁盘空间；
- 管理员可控制的 HTTPS 反向代理或官网入口；
- 比赛浏览器使用当前受支持的 Chrome 或 Edge。

Windows 即用包通常已经包含从 `projects/tmm/package-lock.json` 干净安装的 Windows x64 识物工坊依赖。若 `projects/tmm/node_modules` 缺失，联网运行 `INSTALL-DEPENDENCIES.cmd`。换用其他操作系统或 CPU 架构时必须先删除该目录，再在 `projects/tmm` 中执行 `npm ci --no-audit --no-fund`；不能复用另一平台的原生依赖。

## 2. 校验与首次启动

1. 先在受控渠道取得 ZIP 和同名 `.sha256`，核对整个 ZIP 的 SHA-256。校验和只能证明完整性，不能替代加密传输。
2. 解压到磁盘空间充足且运行账号具有读写权限的目录。后续命令均以解压后的 `competition-platform` 为当前目录，不依赖原开发机盘符。
3. 执行 `node --version`，确认版本不低于 22.13。
4. 运行 `VERIFY-WINDOWS.cmd`。若提示缺少依赖，先运行 `INSTALL-DEPENDENCIES.cmd`。
5. 双击 `START-WINDOWS.cmd`，或在 PowerShell 中执行 `npm run start:all`。
6. 本机打开 `http://127.0.0.1:6190/`，并检查 `http://127.0.0.1:6190/api/health`。

`START-WINDOWS.cmd` 是前台启动方式，关闭窗口会停止服务。正式长期运行若使用 Windows 服务管理器或受控进程管理器，必须保持平台目录为工作目录、注入同一组环境变量，并保证每套数据同一时间只有一个写进程。

交付快照中的活动会话已经清除，所有人都需要重新登录。现有数据快照应使用赛务方另行保管的管理员凭据；凭据不能写入 ZIP 或启动脚本。若部署的是完全空的数据包，必须先仅在本机回环地址完成第一个账号注册，该账号会成为初始化管理员，确认后才能开放公网。

## 3. 端口与公网安全

统一启动器把四个服务都绑定到本机回环地址：

- `6178`：Python 子服务；
- `6180`：Blockly 子服务；
- `3000`：识物工坊子服务；
- `6190`：统一网关。

反向代理只能把正式 HTTPS 域名转发到 `127.0.0.1:6190`。不得对局域网或公网开放 `6178`、`6180`、`3000`，也不要单独启动 Blockly 或识物工坊替代统一入口，否则会绕过统一身份、来源校验和连接背压。

Linux Nginx 可直接使用 `deploy/nginx/competition-platform.conf`，修改域名和证书路径后执行 `nginx -t` 再重新加载。它包含 HTTP 跳转 HTTPS、HSTS、TLS、至少 **64 MiB** 请求体、gzip、静态缓存、Range、超时和安全转发头；Brotli 仅在额外模块已经安装时启用。其他反向代理必须提供等效行为。上线验收时必须通过正式公网域名确认 HTTP 没有跳到云厂商拦截页，并发送一次超过 1 MiB 的请求，确认得到平台 JSON 业务响应而不是代理生成的 413 页面。

上线前至少设置：

```powershell
$env:CHENLONG_PLATFORM_PUBLIC_ORIGIN = 'https://比赛正式域名'
$env:CHENLONG_PLATFORM_TRUSTED_PROXIES = '<直连可信代理的精确 IP；多个用逗号分隔>'
```

只列出实际与本机直连的可信代理 IP。代理必须覆盖客户端自带的 `X-Forwarded-For`、`X-Real-IP`、`CF-Connecting-IP`，不能原样信任浏览器传来的值。临时隧道域名不得写入正式配置。

`/api/health` 中的 `trustedProxyCount` 在正式反代部署时必须大于 0。Python 运行档案默认预算为 4 GiB；`/python/api/health` 的 `runArchiveStorage` 在利用率达到 80% / 95% 时分别报告 `warning` / `critical`。若磁盘空间允许，可用 `CHENLONG_RUN_ARCHIVE_MAX_BYTES` 调整，但不能超过 10 GiB，且必须同步扩大备份空间。

部署后的容器健康检查应访问 `/api/readiness`；它会同时核对统一入口、Python、Blockly 和识物工坊。`/api/health` 仅用于判断统一入口进程是否仍在运行，不能单独作为比赛就绪依据。

## 4. 正式数据与保密边界

交付快照保留正式业务所需内容，但已清除活动登录会话。包内仍包含密码哈希、队伍邀请码、官网身份映射、参赛源码/积木记录、比赛地图、正式成绩、识物模型或保密评测集，因此：

- ZIP 必须加密传输并限制下载人员；
- 解压目录只授予比赛服务账号和授权运维人员权限；
- 不得把源码包、数据目录、清单或备份发送给参赛者；
- 比赛结束后按赛会保留期限归档或安全删除临时副本。

普通交付 ZIP 明确不包含：

- 管理工作区的 `record-backups/` 历史恢复档案；
- 当前部署的 `data/platform-sso-secret.txt`；
- `projects/tmm/.dev.vars` 中的旧管理员初始化密钥；
- 官网 SSO 密钥、成绩 AppSecret、RSA 私钥和测试密钥；
- `.git`、旧交付产物、构建缓存、日志、写锁及冷态复制后不需要的 WAL/SHM。

首次启动会在交付目录内生成新的 `data/platform-sso-secret.txt`。该文件是三个子系统间的内部信任根；生成后必须随本次部署的数据备份并限制读取，不能复制给其他独立环境。RSA 私钥始终由官网保管，本平台只接收官网 RSA 公钥。

## 5. 官网 SSO 与成绩下载配置

官网接口默认关闭。正式启用前，运维必须通过 Windows 服务环境、密码管理器或其他受控机制注入配置；不要把真实值写入 `START-WINDOWS.cmd`、README 或 ZIP。

必须准备：

- `CHENLONG_OFFICIAL_SSO_SECRET`：官网 SSO 独立密钥；
- `CHENLONG_PLATFORM_PUBLIC_ORIGIN`：固定 HTTPS Origin；
- `CHENLONG_SCORE_DOWNLOAD_APPS_FILE`：受控的 AppKey、AppSecret、固定 IP 白名单及 RSA-2048 公钥配置文件；
- `CHENLONG_SCORE_DOWNLOAD_PUBLIC_ORIGIN`：成绩包下载使用的固定 HTTPS Origin；
- `CHENLONG_SCORE_DOWNLOAD_RUNTIME_DIR`：防重放、限额和临时加密包目录；
- `CHENLONG_SCORE_DOWNLOAD_PROMOTIONS_FILE`：权威晋级文件；
- 复赛或增量启用时的 `CHENLONG_SCORE_DOWNLOAD_SNAPSHOT_PATH`：权威冻结快照。

官网仍须确认原接口文档中的错误签名示例、AES-CBC 密文前 16 字节 IV 约定和 `RSA-OAEP-SHA256`。在确认及正式密钥/白名单/晋级文件到位前，不得把内部回环通过误写成官网正式验收完成。完整格式见 `SCORE-DOWNLOAD-API.md` 和 `docs/official-api-specs/`。

## 6. 离线资源边界

Python 的 Pyodide、ONNX Runtime、YOLO、Three.js，以及 Blockly、地图和图标资源都随包提供；服务器构建所需的识物依赖也包含在 Windows 即用包中。因此安装依赖完成后，启动服务不需要访问 CDN。

但识物工坊浏览器端**首次训练**仍需下载约 8 MB 的 MobileNet 基础模型。完全断网赛场必须提前在每台比赛浏览器、每个将使用的浏览器配置文件中完成首次加载并验证缓存，或者在后续版本将该模型改成本地资源。清除浏览器站点数据可能同时清除训练项目和缓存。摄像头仅在 `localhost` 或 HTTPS 安全来源可用；官网 SSO 与成绩交换也需要官网网络连通。

`INSTALL-DEPENDENCIES.cmd` 会访问 npm registry，只能在允许联网时使用；离线部署应直接使用已经包含依赖并通过校验的 Windows 即用包。

## 7. 备份、升级与恢复

制作交付包前和正式升级前必须先停止四个服务，再分别保存一份独立、加密、可恢复的冷备份。`npm run delivery:windows` 不会把 `record-backups/` 放进 ZIP，也不能替代恢复演练。

运行数据至少包括：

- `data/` 中本部署生成的平台内部密钥及必要映射；
- `projects/car-python/.runtime/` 中的正式账户、地图、运行和提交；
- `projects/blockly-page3/.blockly-data/` 中的核心文件和 SQLite 记录库；
- `projects/tmm/.wrangler/state/v3/d1/` 与 `projects/tmm/.wrangler/state/v3/r2/` 中的识物数据、模型和评测集；
- 包外保存的官网调用方配置、成绩运行状态、晋级文件和冻结快照。

SQLite 运行时可能存在 WAL/SHM，不能在服务运行时只复制主数据库。恢复时应停止全部服务、恢复同一时间点的整套数据，并确认目录权限，再启动和检查健康状态。升级程序不要覆盖仍在使用的旧目录；先保留可回退版本和完整备份。

## 8. 验证范围

- `VERIFY-WINDOWS.cmd`：运行统一层检查与测试、Blockly 自动测试、识物构建及自动测试；
- Python 全量回归：在 `projects/car-python` 中另行执行 `npm test`；
- `DELIVERY-MANIFEST.json`：列出包内文件大小和 SHA-256；
- ZIP 同目录 `.sha256`：校验整个压缩包。

自动测试数量会随安全回归补充而变化，不在交付说明中固定宣称最终通过数量。最终签字应以**实际生成的同一个交付 ZIP**解压后执行上述命令的完整输出为准，并在最终比赛服务器和网络上完成容量、磁盘及断电恢复演练。

详细验收边界见 `INTEGRATION-ACCEPTANCE.md`。
