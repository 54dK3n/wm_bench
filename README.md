# 辰龙竞赛统一平台

统一平台保留三个独立比赛引擎，同时提供一个登录入口、一套队伍身份和一个管理后台：

- 赛题一：Python 编程（原服务 `6178`）
- 赛题一：Blockly 积木编程（原服务 `6180`）
- 赛题二：识物工坊（原服务 `3000`）
- 统一入口：`http://127.0.0.1:6190/`

面向参赛学生的网站文案和简明操作说明见 [《赛事手册（学生版）》](./docs/赛事手册-学生版.md)。

Python 账户库仍是用户名、密码、队伍、小组和会话的唯一数据源。Python 的 8 / 10 / 12 套地图池也是正式地图源；网关按相同算法把每队的三套地图签名发送给 Blockly，因此两种编程方式看到同队同图。

## 容量基线

当前本机部署按 **2,000 个注册账号、500 人同时在线**设计：

- 参赛组别统一为 `primary`（小学组）、`junior`（初中组）和 `high`（高中组）。旧 `primary_low`、`primary_high`、`primary_school` 及原小学分段中文值会在服务启动时安全合并为 `primary`，原队伍、用户和成绩归属不变。

- 统一账户默认允许 2,000 个账号和 8,000 个活动登录会话；密码计算使用有界 FIFO，不会因报名或登录高峰无限占用 CPU。账号、会话和管理员改用户等写操作通过单写 FIFO 按最多 32 项或 10 毫秒合并原子落盘，只有持久化成功后才返回登录 Cookie。
- 统一网关允许较大的连接等待队列，同时把每个子系统的并发连接限制为 128；500 个同时身份请求的自动测试全部成功。静态大文件采用流式传输，不再整文件缓存在网关内存中。
- Python 普通单局可同时保留 600 个活动场次，校验默认使用 4 个 Worker，额外请求进入 512 位、90 秒的 FIFO。活动场次配额与历史归档数量完全分离；原始记录只受明确的磁盘字节预算保护（默认 4 GiB，可用 `CHENLONG_RUN_ARCHIVE_MAX_BYTES` 在不超过 10 GiB 范围内按比赛磁盘容量配置），健康接口会在利用率达到 80% / 95% 时报告预警/严重告警。官网成绩使用从全部耐久归档构建并随新提交增量维护的“用户 × 提交时队伍 × 任务”最佳分索引，不会在一万条处截断、因后续低分覆盖旧高分，或因 SSO 后续转队搬动历史归属。
- Blockly 的账户、队伍、会话和地图继续采用小型核心文件批写；运行记录已拆入带 WAL 和组合索引的 SQLite，不再随每次保存同步重写整份 JSON。核心文件与记录库使用同一随机数据库身份绑定，删除或替换数据库会拒绝启动。500 人同时保存加提交可完整持久化，另有 2,000 账号 × 每账号 12 条、共 24,000 条记录的迁移与索引回归；个人与后台记录分页读取，旧接口最多兼容返回最近 1,000 条。
- 识物工坊对无变化的统一身份不重复写库，评测集并发读取共用缓存，模型评分进入 2 个并行槽、4,096 个排队位置的可恢复去重后台队列。Vite/Miniflare 子服务必须放在统一网关背压之后使用。

`GET /api/health` 只表示统一入口进程仍在运行；`GET /api/readiness` 会同时检查 Python、Blockly、识物工坊，任一子系统不可用即返回 HTTP 503。Docker 健康检查和正式监控应使用 `/api/readiness`。

这些是单机竞赛服务的有界容量，不等同于面向互联网的无限横向扩展。比赛前仍应使用最终比赛电脑、磁盘和局域网做一次 500 人压测，并提前关闭不需要的实时杀毒扫描目录。公网只能暴露统一入口 `6190`，不要把三个子服务直接提供给参赛者，否则会绕过网关的连接背压和统一身份校验。

## 2026-08-28 验收状态

本机与当时的 Cloudflare 临时入口均完成了真实请求联调。测试覆盖三个小组的注册、邀请码入队、管理员整队修改、Python 运行场次、Blockly 保存与正式提交、个人/后台成绩、CSV、官网 SSO、官网加密成绩下载和识物工坊模型上传评分。识物工坊实际提交了 2 个约 514 KB 的模型包，均完成持久化和评分（测试模型结果为 12 / 24、50 / 100、评测版本 2）。多轮联调产生的测试账号、记录和模型已经从正式数据中清除并完整归档，未把测试分数留在正式榜单。

公网曾出现的“请求来源不受信任”已修复：网关先校验浏览器看到的外部 HTTPS Origin，再向子服务改写内部 Origin；Python 登录、Blockly 记录写入/退出、管理员修改和识物提交均有回归。转发客户端 IP 只接受来自明确配置的可信直连代理，浏览器伪造的转发头不会被采信。

当前“2,000 个账号、500 人同时在线”来自隔离数据上的本机自动容量测试，不代表 Cloudflare 临时隧道已经完成 500 人公网压测。临时域名可能随隧道重启失效，也不能替代正式 HTTPS 域名、固定白名单和最终赛场网络复测。详细结果和仍待官网确认的事项见 [INTEGRATION-ACCEPTANCE.md](./INTEGRATION-ACCEPTANCE.md)。

本目录是三个项目的统一管理层。原项目保留各自的运行引擎和数据格式，统一层负责身份、入口、地图契约、成绩汇总与后台，避免复制三套大型资源：

```text
competition-platform/          统一入口、后台、迁移与一键启动
├─ projects/
│  ├─ car-python/              赛题一 Python、正式账户与地图源
│  ├─ blockly-page3/           赛题一 Blockly
│  └─ tmm/                     赛题二识物工坊
└─ record-backups/             历史数据与整合备份
```

## 一键启动

统一平台最低要求 **Node.js 22.13**。Windows 新机先在本目录确认版本并执行交付验证：

```powershell
node --version
.\VERIFY-WINDOWS.cmd
```

若验证只因缺少 `projects/tmm/node_modules` 而停止，在允许联网时运行 `INSTALL-DEPENDENCIES.cmd`，再重新运行验证。离线机器应直接使用已经包含依赖并通过校验的 Windows 即用包。

正式 Windows 即用包已经包含与 Windows x64 匹配的依赖，不需要重复安装；源代码包、依赖被删除的包或换到其他系统/CPU 架构时必须重新执行 `npm ci`，不能复制另一台机器的 `node_modules`。然后双击 `START-WINDOWS.cmd`，或在本目录运行：

```powershell
npm run start:all
```

第一次运行会在 `data/platform-sso-secret.txt` 生成平台内部签名密钥，以后重复使用同一密钥。此文件不要上传或发给选手。

启动器依次检查 `6178`、`6180`、`3000`、`6190`：

- 服务已正确运行时直接复用；
- 端口空闲时才启动对应项目；
- 端口被其他程序占用时停止并报告，不会结束或覆盖现有进程。

整合平台需要 Node.js 22.13 或更新版本（Blockly 使用内置 SQLite，识物工坊的依赖也声明了该最低版本）。三个子项目均使用相对路径：

- `projects/car-python`
- `projects/blockly-page3`
- `projects/tmm`

启动器会给 Blockly 和识物工坊注入同一份短时签名密钥，并在启动后实际验证三方身份。集成运行请使用 `npm run start:all`；不要单独使用识物工坊的 `npm start` 代替本地集成启动。正式服务器部署识物工坊时，应通过 Cloudflare Worker / Wrangler 注入 D1、R2 和密钥绑定。

## Docker 启动

仓库提供 `Dockerfile` 与 `compose.yaml`。镜像内预构建识物工坊，只发布统一入口 `6190`，并用四个独立卷持久化平台密钥、Python/统一账户数据、Blockly 数据和识物 D1/R2 数据：

```powershell
docker compose build
docker compose up -d
```

容器不会打包开发机上的账号、成绩、模型、密钥或历史备份。完整的镜像导入、正式 HTTPS 配置、卷备份和升级注意事项见 [DOCKER.md](./DOCKER.md)。

## 单独启动网关

如三个子系统已经由其他方式运行，可设置同一签名密钥后仅启动网关：

```powershell
$env:CHENLONG_PLATFORM_SSO_SECRET = "至少32字节的内部密钥"
$env:CHENLONG_OFFICIAL_SSO_SECRET = "官网约定的独立随机密钥（至少16字节）"
npm start
```

可选配置：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 网关监听地址 |
| `PORT` | `6190` | 网关端口 |
| `CHENLONG_PYTHON_ORIGIN` | `http://127.0.0.1:6178` | Python 服务源站 |
| `CHENLONG_BLOCKLY_ORIGIN` | `http://127.0.0.1:6180` | Blockly 服务源站 |
| `CHENLONG_WORKSHOP_ORIGIN` | `http://127.0.0.1:3000` | 识物工坊源站 |
| `CHENLONG_PLATFORM_PUBLIC_ORIGIN` | 按请求 Host 判断 | 公网固定 Origin，临时隧道部署时建议设置 |
| `CHENLONG_PLATFORM_TRUSTED_PROXIES` | 空 | 可提供真实客户端 IP 头的直连可信代理精确 IP，逗号分隔；未配置时忽略外部伪造头 |
| `CHENLONG_RUN_ARCHIVE_MAX_BYTES` | `4294967296` | Python 运行记录总预算；80% / 95% 时由健康接口预警，最大 10 GiB |
| `CHENLONG_PYTHON_AUTH_STORE` | `projects/car-python/.runtime/auth/auth-store.json` | 只读补充稳定 `teamId` |
| `CHENLONG_OFFICIAL_SSO_SECRET` | 无（官网 SSO 关闭） | 官网 `/sso/jump` 的独立 SHA-256 签名密钥 |

Blockly 和识物工坊必须使用同一个 `PLATFORM_SSO_SECRET`。签名身份有效期很短，并分别绑定 `blockly`、`workshop` 受众，不能跨子系统复用。启动器会把 HTTPS 的 `CHENLONG_PLATFORM_PUBLIC_ORIGIN` 同步为 Python 的 `CHENLONG_PUBLIC_ORIGIN`，并强制启用 Secure Cookie；配置官网 SSO 后缺少 HTTPS Origin 会拒绝启动。`CHENLONG_OFFICIAL_SSO_ALLOW_INSECURE_TEST_MODE=true` 只供隔离的本机自动化测试使用，正式部署禁止设置。

## 页面与接口

- `/login.html`：统一登录、注册、创建或加入队伍
- `/sso/jump`：官网签名免密跳转入口（成功后进入 `/portal.html`）
- `/portal.html`：赛题入口、个人最高成绩、队伍邀请码
- `/admin.html`：用户筛选与队伍/小组修改、四项总分、地图分配、CSV 导出
- `/python/*`：Python 项目代理
- `/blockly/*`：Blockly 项目代理
- `/workshop/*`：识物工坊代理
- `/api/platform/me`：统一当前身份
- `/api/platform/scores/me`：个人三项编程成绩和识物提交状态
- `/api/platform/admin/users`：统一用户列表（管理员）
- `/api/platform/admin/users/:userId`：修改普通用户队伍和小组（管理员，`PATCH`）
- `/api/platform/admin/overview?page=N`：每页 15 队的统一成绩
- `/api/platform/admin/export`：导出全部队伍 CSV
- `POST /v1/score/batch-download`：官网后端签名获取加密成绩包
- `/blockly/api/maps`：把 Python 队伍地图转换为 Blockly 严格七字段地图契约

官网 SSO 联调必须按 UTF-8 原文计算 SHA256。收到的 `sso_jump_api.md` 中示例参数对应的实际签名是 `e4c9060a5bb1a25e11d3cc70b7aeac1917fda4a83e9036c3923ae032c05ba2f3`；文件内给出的 `a7c2…b0c1d` 不是该明文的 SHA256。平台实现遵循文档算法并把前一个值固化为互操作测试向量，正式联调前必须请官网确认并修正文档示例，不能为了匹配错误示例改变算法。SSO 只接受六个规定参数，校验正负 5 分钟时间窗、一次性重放和审计日志，不创建本地密码。同一官网用户首次登录后会固定绑定官网队伍编号；后续 SSO 可以更新同队名称和小组并同步全队，但不能自动把用户转入另一个官网队伍。正式转队必须由管理员离线审核，避免浏览器跳转把历史成绩归属搬到新队。

任务1、2、3分别取同队 Python 与 Blockly 正式提交的较高分；识物工坊取当前服务端评分。四项各占总分 25%，缺少的项目按 0 分计入，满分 100 分。由于官网成绩字段必须为整数，编程三项贡献与识物贡献分别按 `.5` 向上四舍五入后相加；统一后台复用同一计分函数，显示值、排名、后台 CSV 与官网加密成绩包保持一致。

官网成绩包接口读取三项成绩和统一账户中由官网 SSO 保存的用户/队伍编号；同队多个账号分别出行但共享队伍名次。运行中的三服务只提供初赛全量稳定快照，且必须配置权威晋级名单；复赛和增量拉取使用赛会冻结快照，避免漏掉改队名、改组、官网映射或晋级状态。接口校验 AppKey、时间戳、签名、重放、固定 IP 白名单和 50,000 行上限；全量包每日最多成功生成 5 次，增量包使用独立频控。接口仅面向官网后端，需单独配置 AppSecret、RSA-2048 公钥和 HTTPS 地址。

官网附件只指定 AES-256-CBC 和 RSA-2048，**没有规定 AES IV 的传输格式，也没有规定 RSA padding / OAEP 摘要**。当前经过自动和真实解密回环的约定是“加密文件前 16 个原始字节为 IV”，AES 密钥使用 `RSA-OAEP-SHA256` 加密。回环只证明平台实现自洽；官网必须书面确认 IV 前缀和 RSA-OAEP-SHA256 后才能冻结正式协议。完整签名、限额、加密文件格式及部署配置见 [SCORE-DOWNLOAD-API.md](./SCORE-DOWNLOAD-API.md)。

参赛小组属于队伍而不是单个用户：使用邀请码加入时自动继承队伍小组，管理员修改任一队员的小组时会同步整队。统一模式下 Blockly 后台只查看积木提交、生成代码和积木结构；8 / 10 / 12 套比赛地图统一在 Python 地图后台编辑。

## 已有数据与迁移

旧 Python、Blockly 和识物工坊数据已经合并到正式账户源，旧识物提交通过永久映射关联到统一队伍编号。管理工作区中的迁移前数据有可恢复备份：

- 首次整合备份：`record-backups/integrated-platform-20260827T173116Z`
- 识物队伍关联备份：`record-backups/integrated-platform-links-20260827T180035Z`
- 2026-08-28 真实联调清理归档：`record-backups/live-qa-cleanup-20260828T070411`
- 历史编号映射：`data/legacy-id-map.json`

真实联调清理归档包含清理前的统一账户、Blockly 核心文件与 SQLite/WAL/SHM、全部 Python 场次、识物 D1/R2 副本、官网 SSO 运行状态、删除清单和被删除的 2 个模型包。归档结果记录本轮清除了 39 个测试账号、33 个测试队伍、39 个测试会话、34 条 Blockly SQLite 记录和 1 个 Python 测试场次；这些数字用于审计，不表示正式参赛数据被删除。

`record-backups/` 只留在受控管理工作区，普通交付 ZIP 明确不包含它。交付包内的正式数据快照不是恢复备份；制作交付包前仍须另外完成并验证一份加密备份。

重新执行完整迁移前先运行 `npm run migrate` 查看只读预览，再明确使用 `node tools/migrate-legacy-data.js --apply`。若只需要把既有识物队伍映射补入本地 D1，可运行 `npm run migrate:workshop-links`；该命令会先备份数据库，并拒绝覆盖冲突关联。

### 验收测试数据清理

清理前必须先停止 Python 和 Blockly 服务。先执行只读预览：

```powershell
node tools/cleanup-test-data.js
```

确认数量后，使用 `record-backups` 下一个全新目录执行：

```powershell
node tools/cleanup-test-data.js --apply --archive record-backups/cleanup-YYYYMMDD-HHMMSS
```

清理器识别 `accept_`、`mate_`、`live_user_`、`qa_` 测试账户以及明确的联调程序标记，同时支持旧版 JSON 记录和新版 SQLite 记录库。正式写入前会备份账户文件、Blockly 核心文件、SQLite/WAL/SHM 和全部 Python 场次；归档目录必须为新目录或空目录，数据在计划后发生变化也会拒绝执行。

`--before YYYY-MM-DD` 会额外清理该日期之前的非管理员记录；Python 场次依次按 `submittedAt`、`savedAt`、`updatedAt`、`createdAt` 判断。管理员记录默认始终保留，只有明确添加 `--include-admin` 才会纳入测试标记、日期和管理员 Python 场次清理。

## 安全边界

- 浏览器写请求会先核对统一入口的外部 Origin，再将 Origin 改写为对应内部源站；配置的公网 HTTPS Origin 会贯穿 Python 登录、Blockly 写入/退出和管理员修改；
- `X-Forwarded-For`、`X-Real-IP`、`CF-Connecting-IP` 等外部头默认不可信；只有请求直连 IP 在 `CHENLONG_PLATFORM_TRUSTED_PROXIES` 中时才使用规范化后的客户端地址；
- 客户端不能自行提供平台身份或地图签名头，网关会删除后重新签发；
- 管理员接口先由 Python 统一会话确认角色；
- CSV 对公式前缀做转义；
- 官网 SSO 和成绩下载使用彼此独立的密钥，均校验时间窗和重放；成绩接口额外要求固定 IP 白名单；
- 统一网关只读兼容 `chenlong.auth-store/v4` / `v5`；Python 服务启动时会把旧版本原子迁移为包含四组与官网身份映射的 `v5`，网关不会绕过服务直接写账户 JSON。

## 官网正式启用清单

代码和本平台内部回环已经具备，但正式启用仍依赖官网/赛会提供下列外部资料：

1. 独立的正式 SSO 密钥、成绩 AppKey/AppSecret 和官网 RSA-2048 公钥；RSA 私钥只保留在官网侧。
2. 官网调用服务器的精确 IP 白名单、反向代理拓扑和固定 HTTPS 域名；正式环境设置 `CHENLONG_PLATFORM_PUBLIC_ORIGIN` 和可信直连代理，不使用临时隧道域名。
3. 官网确认 `sso_jump_api.md` 中错误的示例签名，并书面确认“密文前 16 字节为 AES-CBC IV”和 `RSA-OAEP-SHA256`。
4. 初赛、复赛的权威晋级文件；缺少时正式成绩导出会失败关闭，不会猜测晋级状态。
5. 复赛和增量冻结快照、赛段截止时间及重发流程。快照必须在成绩、队名、小组、官网身份映射或晋级状态任一变化时推进对应行的 `evaluate_finish_time`。
6. 在最终比赛服务器和网络上完成 500 人容量、磁盘、断电恢复及备份恢复演练；识物工坊长期运行应使用 Cloudflare Worker / Wrangler 注入正式 D1、R2 和密钥绑定。

## 检查与测试

```powershell
npm run check
npm test
```

启动整套系统后可进行无新增记录的在线验收：

```powershell
$env:CHENLONG_LIVE_USER_PASSWORD = "测试用户密码"
$env:CHENLONG_LIVE_ADMIN_PASSWORD = "管理员密码"
$env:CHENLONG_LIVE_CREATE_RECORD = "0"
npm run test:live
```

`npm test` 使用随机临时端口和临时账户库，不启动或停止正式的 `6178`、`6180`、`3000`、`6190` 服务。测试数量会随安全回归补充而变化；文档中的历史数量只用于说明当时覆盖范围，最终交付以生成包内 `VERIFY-WINDOWS.cmd` 和各项目全量测试的实际输出为准。

下列两项是**真实写入验收**，会创建测试账号、正式 Blockly 记录、Python 场次或识物模型，不能当成只读健康检查：

```powershell
npm run test:live:multi
npm run test:live:official
```

`test:live:multi` 需要设置真实测试用户/管理员密码；`test:live:official` 还需要测试 SSO 密钥、成绩 AppKey/AppSecret 和与测试公钥对应的 RSA 私钥文件。只应使用专门的 QA 标记数据，执行后先停止 Python/Blockly 写服务，再预览并用 `tools/cleanup-test-data.js` 归档清理。正式比赛进行期间不要运行真实写入验收或清理器。

本次整合的详细验收结果见 `INTEGRATION-ACCEPTANCE.md`。

## 交付包

Blockly 9.3.3、Three.js 0.160.0 和 Lucide 0.468.0 已固定在 `projects/blockly-page3/vendor/`，并附带许可证；参赛页面不再从 CDN 执行脚本，因此赛场断网不影响 Blockly、地图或图标加载。Python 的 Pyodide、ONNX Runtime、YOLO、Three.js 等浏览器资源也随项目本地提供。

识物工坊的服务器依赖随 Windows 即用包提供，但浏览器**首次训练**仍会下载约 8 MB 的 MobileNet 基础模型；这部分不能被描述为完全离线。无外网赛场必须提前在所有比赛浏览器中完成首次加载并验证缓存，或者在后续版本把基础模型改为本地资源。摄像头只在 `localhost` 或 HTTPS 安全来源可用；官网 SSO 和成绩下载也必须能够访问官网网络。

制作交付包前必须正常停止全部四个服务，再运行：

```powershell
npm run delivery:windows
```

该命令会对 Blockly、D1 和 R2 数据库执行冷态 WAL checkpoint，复制当前用户、队伍、地图、正式成绩和识物评测集，清除交付副本中的活动登录会话，并从 `package-lock.json` 干净安装 Windows x64 识物依赖。最终 ZIP 和 `.sha256` 默认输出到平台目录同级的 `deliverables/`；校验和只能验证完整性，不能替代加密传输。

交付包明确排除历史 `record-backups/`、当前平台密钥、`.dev.vars`、官网密钥、审计重放状态、Git 历史、旧产物、构建缓存、日志、锁及 WAL/SHM。包内包含 `DELIVERY.md`、一键启动/安装/验证脚本、逐文件 SHA-256 清单和官网原始接口规范。详情见 [DELIVERY.md](./DELIVERY.md)。
