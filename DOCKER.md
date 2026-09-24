# Docker 镜像部署

该镜像包含统一入口、Python、Blockly 和识物工坊四个服务。容器只对外监听统一入口 `6190`；三个内部服务继续绑定容器回环地址，不会被单独暴露。

## 快速启动

已有镜像包时：

```powershell
Get-FileHash .\competition-platform-1.0.0-linux-amd64.tar.gz -Algorithm SHA256
docker load -i .\competition-platform-1.0.0-linux-amd64.tar.gz
docker compose up -d --no-build
docker compose ps
```

当前离线包目标架构为 Linux AMD64，适用于常见的 Intel/AMD x64 Docker 主机；ARM64 主机需要重新按目标架构构建。

浏览器打开 `http://127.0.0.1:6190/`。进程存活检查为 `/api/health`，正式就绪检查为 `/api/readiness`。全新空数据首次注册的账号会成为初始化管理员，请先在受控网络完成初始化，再向参赛者开放。

从源码构建时：

```powershell
docker compose build
docker compose up -d
```

停止服务使用 `docker compose down`。不要附加 `-v`；`docker compose down -v` 会删除正式持久化卷。

## 服务器建议与外部准备

以下为本项目按 2,000 个账号、约 500 人同时在线的简化建议，实际规格还要结合学生是否集中进入和服务器公网带宽调整：

| 项目 | 建议 |
| --- | --- |
| 系统 | Linux AMD64，安装 Docker Engine、Docker Compose、Nginx |
| CPU / 内存 | 建议 8 核 / 16 GiB；小规模联调可用 4 核 / 8 GiB |
| 磁盘 | 至少 100 GiB SSD；正式比赛和本机备份建议 200 GiB 以上 |
| 网络 | 至少 100 Mbps；集中开赛建议更高带宽或提前让浏览器完成静态资源缓存 |
| 端口 | 公网仅开放 80、443；6190 只给本机 Nginx，6178、6180、3000 不对外开放 |

部署前需从外部准备：正式域名及 DNS、HTTPS 证书、官网提供的 SSO AppKey/AppSecret、RSA 公钥、IP 白名单及成绩接口资料，以及小学组、初中组、高中组的真实识物评测集。上述内容均不写入镜像；密钥放部署机环境变量或只读机密文件，识物评测集在管理员后台上传。接口字段与联调清单见 [交付说明](./DELIVERY.md) 和 [成绩下载接口说明](./SCORE-DOWNLOAD-API.md)。至少准备一处独立备份位置，并按同一时间点备份全部四个数据卷。

### 最小运维检查

- 每分钟检查一次 `/api/readiness`，异常时同时查看容器重启次数和磁盘余量。
- 监控 Python 运行档案用量；达到 80% 时清理或扩容，95% 时暂停新增运行记录并立即处理。
- 提前监控 HTTPS 证书到期时间；每次更新镜像前对四个数据卷做同一时间点的冷备份，并定期实际演练恢复。
- 开赛前确认三个组别的识物评测集均已上传，后台系统管理显示全部子系统就绪。

## 持久化数据

Compose 创建四个具名卷：

| 卷 | 数据 |
| --- | --- |
| `platform-secret` | 平台内部签名密钥 |
| `python-runtime` | 统一账户、队伍、地图、Python 运行与正式提交 |
| `blockly-data` | Blockly 核心数据、积木和提交记录 |
| `workshop-state` | 识物工坊 D1、R2、模型与评测数据 |

升级镜像不会自动删除这些卷。备份或恢复前必须停止容器，并把四个卷作为同一时间点的完整数据集处理；只复制单个 SQLite 主文件不构成有效热备份。

## 公网与正式比赛

直接通过 `http://服务器IP:6190` 访问时，不要设置固定公网 Origin，并且必须显式设置 `COMPETITION_PLATFORM_BIND_ADDRESS=0.0.0.0`。通过正式 HTTPS 反向代理时，在部署机复制 `docker.env.example` 为不纳入版本库的环境文件，并设置：

```text
COMPETITION_PLATFORM_BIND_ADDRESS=127.0.0.1
CHENLONG_PLATFORM_PUBLIC_ORIGIN=https://比赛正式域名
CHENLONG_PLATFORM_TRUSTED_PROXIES=直连可信代理的精确IP
# 在部署机填写真实密钥；不要将其提交到仓库。
CHENLONG_OFFICIAL_SSO_SECRET=
CHENLONG_RUN_ARCHIVE_MAX_BYTES=8589934592
```

仓库提供可直接安装的 [正式 Nginx 配置](./deploy/nginx/competition-platform.conf)，已经包含 HTTP 跳转 HTTPS、TLS 1.2/1.3、HSTS、`client_max_body_size 64m`、JS/CSS/JSON gzip、静态资源缓存、Range 透传、超时和转发头覆盖。证书采用 Certbot 的标准路径；域名或证书位置不同时先修改文件，再安装并校验：

```bash
sudo install -m 0644 deploy/nginx/competition-platform.conf /etc/nginx/conf.d/competition-platform.conf
sudo nginx -t
sudo systemctl reload nginx
```

Stock Ubuntu Nginx 没有内置 Brotli，示例中只保留了注释项；只有确认已安装并加载 `ngx_brotli` 后才可取消注释，否则 `nginx -t` 会失败。其他反向代理必须提供等效行为。平台自身仍保留 48 MiB 网关上限和 40 MiB Python 解压后记录上限，不应继续调高。

然后使用 `docker compose --env-file <受控环境文件> up -d`。Compose 默认只把 `6190` 绑定到部署机的 `127.0.0.1`；只能由本机 Nginx 代理该端口，不得公开内部端口 `6178`、`6180`、`3000`。只有明确需要从局域网直连时，才把 `COMPETITION_PLATFORM_BIND_ADDRESS` 改为 `0.0.0.0`。

启用官网成绩接口时，在受控环境文件中另外设置：

```text
CHENLONG_SCORE_DOWNLOAD_PUBLIC_ORIGIN=https://比赛正式域名
CHENLONG_SCORE_DOWNLOAD_TRUSTED_PROXIES=直连可信代理的精确IP
CHENLONG_SCORE_DOWNLOAD_APPS_HOST_FILE=/etc/chenlong/secrets/score-download-apps.json
CHENLONG_SCORE_DOWNLOAD_CONFIG_HOST_DIR=/etc/chenlong/official-score
```

`CHENLONG_SCORE_DOWNLOAD_CONFIG_HOST_DIR` 目录中必须有 `promotions.json`；使用冻结成绩快照时，再放入 `frozen-score-snapshot.json`。调用方配置文件可用 `root:1000`、`0640`，动态配置目录可用 `root:1000`、`0750`，其中的文件可用 `0640`，保证容器内 UID 1000 可读且其他用户不可读。仓库提供的覆盖文件会自动设置容器内路径并使用持久化运行目录：

```bash
docker compose --env-file /etc/chenlong/competition-platform.env \
  -f compose.yaml -f deploy/compose.official-api.yaml up -d --no-build
```

如果使用冻结成绩快照，再追加 `-f deploy/compose.official-score-snapshot.yaml`。动态目录采用整体只读挂载，使宿主机通过临时文件原子替换 `promotions.json` 或快照后，容器能读取新文件。官网 SSO、成绩下载密钥和名单文件不能写入镜像或仓库。

`CHENLONG_PLATFORM_TRUSTED_PROXIES` 和 `CHENLONG_SCORE_DOWNLOAD_TRUSTED_PROXIES` 必须填写反向代理连接容器时由容器实际看到的精确源 IP。宿主机 Nginx 经过 Docker 端口映射时，该地址通常是 Compose 网络网关而非 `127.0.0.1`，可用下面命令读取当前容器对应的网关；若代理本身也在容器中，则应检查并固定该代理在同一 Docker 网络中的地址。

```bash
docker inspect "$(docker compose ps -q platform)" \
  --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}'
```

官网调用方的来源白名单单独写在 `score-download-apps.json` 的 `ipAllowlist` 中，可以使用精确 IP 或 CIDR，不能和可信代理配置混用。修改后必须从真实代理链完成一次签名生成、下载、RSA/AES 解密并读取 `score.csv` 的回环；`/api/readiness` 返回 200 只说明子服务就绪，不能代替成绩接口验收。仓库的 `npm run test:live:official` 可执行该回环，但会创建一个 QA 账号和提交记录，并消耗一次当天全量成绩包额度，只应在受控验收环境运行。

Python 运行档案默认预算为 **4 GiB**，可通过 `CHENLONG_RUN_ARCHIVE_MAX_BYTES` 在应用的 10 GiB 硬上限内调整。`/python/api/health` 的 `runArchiveStorage` 会返回已用、剩余、利用率和 `ok` / `warning` / `critical`；80% 起预警，95% 起严重告警。提高预算前必须确认 Docker 卷所在磁盘有足够空间，并为备份再预留一份同等容量。

### 公网验收

把下面域名替换为实际正式域名。检查结果必须分别为：HTTP 301 且仍指向本站、HTTPS 含 HSTS、脚本使用 gzip 和可缓存、Range 返回 206、可信代理数量不为 0。

```bash
curl -I http://competition.chenlongrobot.com/
curl -I https://competition.chenlongrobot.com/
curl -sS -H 'Accept-Encoding: gzip' -D - -o /dev/null https://competition.chenlongrobot.com/python/app.js?v=deploy-check
curl -sS -r 0-1023 -D - -o /dev/null https://competition.chenlongrobot.com/python/vendor/pyodide/pyodide.asm.wasm
curl -sS https://competition.chenlongrobot.com/api/health
curl -sS https://competition.chenlongrobot.com/api/readiness
curl -sS https://competition.chenlongrobot.com/python/api/health
```

`/api/health` 是兼容用的入口存活检查；容器和运维告警使用 `/api/readiness`，它只有在统一入口、Python、Blockly、识物工坊全部正常时才返回 200。统一后台“系统管理”也会展示同一检查结果和部署配置提醒。

若第一个请求跳到 DNSPod 或云厂商拦截页，说明 80 端口、域名备案或云平台入口仍未交给这份 Nginx，不能仅凭 HTTPS 可访问就判定上线完成。健康响应中的 `officialSsoConfigured: false` 表示真实官网 SSO 密钥尚未注入；不得用伪造密钥把它改成 `true`。

## 导入、导出与校验

导出当前镜像：

```powershell
docker save -o competition-platform-1.0.0-linux-amd64.tar competition-platform:1.0.0
Get-FileHash .\competition-platform-1.0.0-linux-amd64.tar -Algorithm SHA256
```

正式交付只保留可直接被 `docker load` 读取的 `.tar.gz` 和对应 `.sha256` 文件；未压缩 `.tar` 属于构建中间文件，不需要提交。

镜像包只包含程序和预构建依赖，不包含当前开发机的账号、成绩、模型、备份或密钥。正式迁移数据必须另做加密冷备份。
