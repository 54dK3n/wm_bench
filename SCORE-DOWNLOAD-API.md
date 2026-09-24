# 官网成绩打包下载接口

本接口实现 `get_all_scores_api.md` 与 `scores.md` 的服务端核心。它只接受官网后端调用，不提供浏览器登录态调用方式。

## 接口

### 生成成绩包

- 方法与路径：`POST /v1/score/batch-download`
- `Content-Type`：`application/json; charset=utf-8`
- 请求头：`AppKey`、10 位秒级 `Timestamp`、64 位小写 SHA256 `Sign`
- 请求体：

```json
{
  "competition_stage": "preliminary",
  "group_type": "primary",
  "pull_type": "all"
}
```

参数约束：

- `competition_stage` 必填，只能是 `preliminary` 或 `rematch`；
- `group_type` 可省略，只能是 `primary`、`junior`、`high`；
- `pull_type` 可省略，默认为 `all`，也可为 `increment`；
- `pull_type=increment` 时必须提供 `last_update_time`；增量结果只包含 `evaluate_finish_time > last_update_time` 的记录；
- 不接受未定义参数，一次最多导出 50,000 行。

接口规范中的“单日最多 5 次”只统计成功生成的 `pull_type=all` 全量包；生成失败会释放全量额度。`pull_type=increment` 不占用这 5 次额度，并使用独立的每 AppKey 60 次/60 秒频控（签名五分钟防重放仍同时生效），避免增量同步挤占赛会全量归档额度或被高频滥用。

实时三服务数据源只接受 `preliminary + all`。原因是运行中的本地服务没有覆盖队名、组别、官网身份映射和晋级名单变更的统一权威游标；对实时源请求 `rematch` 或 `increment` 会返回 `5002`，不会静默漏行。复赛或增量拉取必须使用赛会发布的带赛段冻结快照，并在任意字段变化时同步推进该行的 `evaluate_finish_time`。

成功响应保持约定字段：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total": 1,
    "download_url": "https://<比赛域名>/v1/score/download/<随机令牌>",
    "file_size": 1024,
    "encrypt_password": "<RSA-OAEP-SHA256 加密后的 AES 密钥 Base64>",
    "expire_time": 1726675200,
    "snapshot_time": 1726588800
  }
}
```

### 下载成绩包

对 `download_url` 发起 `GET`。`AppKey` 请求头可省略；若提供，必须与生成该文件的 AppKey 一致。下载请求可以来自该 AppKey 配置中的任意白名单 IP，因此官网 A 机生成后可由同一白名单中的 B 机下载。

下载鉴权由 256 位随机 URL 令牌和该文件所属 AppKey 的来源 IP/CIDR 白名单共同完成。服务端只保存令牌 SHA256，不提供目录列表，令牌无法按顺序遍历。链接有效期为 24 小时；AppKey 被停用后，其既有链接也立即不可下载。

附件规范只给出下载 URL，没有要求下载阶段再次签名。本实现因此兼容不携带 AppKey 的官网客户端，同时仍执行令牌所属 AppKey 的 IP 白名单。若官网最终要求下载 URL 可跨白名单或必须二次签名，应在联调时书面确认后再冻结协议，不能临时放宽。

## 签名

1. 收集请求体中实际出现的参数，以及请求头 `AppKey`、`Timestamp`，不包含 `Sign`；
2. 参数名按 ASCII 升序排列；
3. 以 `key=value&key=value` 连接，末尾追加 `&AppSecret=<调用方密钥>`；
4. 对 UTF-8 字节计算 SHA256，输出 64 位小写十六进制字符串。

例如，参数名的固定排序结果为：

```text
AppKey=...&Timestamp=...&competition_stage=preliminary&pull_type=all&AppSecret=...
```

服务器使用常量时间比较签名。时间戳允许误差为正负 5 分钟；同一 `AppKey + Sign` 在 5 分钟窗口内只能使用一次。防重放和日限额通过原子状态文件保存，进程重启后仍有效。

每个 AppKey 按北京时间自然日最多生成 5 个成功成绩包；正在生成的请求也会先占用名额，避免并发绕过。生成失败会释放日名额，但原签名仍不可重放，调用方应使用新时间戳重新签名。

## CSV 与计分口径

解密后的 ZIP 只包含 UTF-8（带 BOM）的 `score.csv`，字段顺序固定为：

```text
user_id,team_id,team_name,group_type,score_task1,score_task2,total_score,group_rank,promote_status,evaluate_finish_time
```

所有分数字段按接口约定输出整数。统一平台四项各占总分 25%，映射为：

- `score_task1 = round((编程任务1 + 编程任务2 + 编程任务3) / 4)`，范围 0–75；
- `score_task2 = round(识物工坊得分 / 4)`，范围 0–25；
- `total_score = score_task1 + score_task2`，范围 0–100。

这里的 `round` 是 JavaScript `Math.round` 对非负分数的规则，即 `.5` 向上取整；两个贡献字段分别取整后再相加。统一后台总分直接复用同一函数。例如三项编程合计 198、识物工坊 66 时，`score_task1=50`、`score_task2=17`、`total_score=67`，后台与成绩包均显示 67。

`group_rank` 必须分别在 `primary`、`junior`、`high` 三个组内计算。`promote_status` 属于赛事晋级政策，必须由权威成绩数据源提供，平台不会自行猜测晋级名额。

排名以队伍为单位计算，同分采用竞赛排名（例如 `1, 1, 3`）。一个队伍可以有多个官网用户：CSV 为每个唯一 `user_id` 输出一行，同队各行的 `team_id`、成绩、名次、晋级状态及完成时间完全一致，不会因队员人数重复占用名次。

文本单元格会进行 CSV 公式注入防护。`evaluate_finish_time` 为秒级时间戳，并且不得晚于本次 `snapshot_time`。

## 文件加密格式

1. 服务端生成标准 ZIP；
2. 使用 `crypto.randomBytes(32)` 生成 32 字节 AES 密钥；
3. 使用随机 16 字节 IV 和 AES-256-CBC 加密完整 ZIP；
4. 下载文件的前 16 字节是 IV，后续全部字节是 CBC 密文；
5. AES 密钥使用调用方 RSA-2048 公钥、RSA-OAEP-SHA256 加密，结果以 Base64 放入 `encrypt_password`。

官网解密顺序：RSA 私钥解出**原始 32 字节** AES 密钥（不能按 UTF-8 字符串处理）→ 读取下载文件前 16 字节 IV → 只把第 17 字节起的其余数据作为 AES-256-CBC 密文解密 → 得到标准 ZIP → 解压 `score.csv`。不要把前 16 字节 IV 一并送入解密器；这种错误会在解密结果开头留下 16 字节垃圾数据，部分解压软件会把它显示成“空 ZIP”。正确解密结果的前四字节必须是十六进制 `50 4B 03 04`；若该标记出现在偏移 16，说明 IV 切分错误。

AES-CBC 按接口规范提供保密性，但自身不提供认证加密。部署必须使用 HTTPS，下载 URL 不应写入公开日志或发送给浏览器端。

附件只指定 AES-256-CBC 与 RSA-2048，并未单列 IV 传输字段或 OAEP 摘要。本实现约定“文件前 16 字节为随机 IV”，RSA 使用 OAEP-SHA256；这两项已经过自动解密回环，但仍须由官网书面确认互操作格式后再作为正式协议冻结。

## 安全配置

代码中没有示例或默认 AppSecret、RSA 公钥。推荐用仅服务账户可读的 JSON 文件配置：

```json
{
  "<官网 AppKey>": {
    "enabled": true,
    "appSecret": "<至少 32 字节，通过安全渠道下发>",
    "ipAllowlist": ["<官网服务器固定 IP 或 CIDR 网段>"],
    "rsaPublicKey": "<官网 RSA-2048 SPKI PEM 公钥>"
  }
}
```

环境变量：

|变量|作用|
|---|---|
|`CHENLONG_SCORE_DOWNLOAD_APPS_FILE`|调用方配置 JSON 路径，推荐|
|`CHENLONG_SCORE_DOWNLOAD_APPS_JSON`|内联 JSON；不能与文件配置同时使用|
|`CHENLONG_SCORE_DOWNLOAD_PUBLIC_ORIGIN`|生成下载链接使用的 HTTPS Origin|
|`CHENLONG_SCORE_DOWNLOAD_RUNTIME_DIR`|防重放、日限额和加密文件保存目录|
|`CHENLONG_SCORE_DOWNLOAD_TRUSTED_PROXIES`|允许提供 `X-Forwarded-For` 的精确代理 IP，逗号分隔|
|`CHENLONG_SCORE_DOWNLOAD_SNAPSHOT_PATH`|权威成绩快照 JSON 路径|
|`CHENLONG_SCORE_DOWNLOAD_PROMOTIONS_FILE`|按赛段保存权威晋级状态的 JSON 文件|

`ipAllowlist` 同时接受精确 IPv4/IPv6 地址和 CIDR 网段，例如 `203.0.113.10`、`203.0.113.0/24`、`2001:db8::/32`。配置错误会阻止服务启动。不配置调用方时接口保持关闭状态；只有明确列入 `CHENLONG_SCORE_DOWNLOAD_TRUSTED_PROXIES` 的直连代理才能提供 `X-Forwarded-For`，其他客户端发送该头不会改变来源 IP。可信代理自身仍必须配置为精确 IP，不能使用 CIDR。

## 成绩与官网身份数据源

正式统一网关默认直接读取当前三个比赛服务：Python 通过仅限回环地址、30 秒 HMAC 和防重放的只读内部接口读取正式提交的最佳分聚合；Blockly 与识物工坊通过短时、绑定受众的内部管理员凭据读取。每个分页源和识物总览都会完整读取两次并比较 SHA256，统一账户中会影响成绩的官网映射、队伍和组别字段以及晋级文件也在读取前后复核；发生变化会重试三次，仍无法得到稳定视图则返回 `5002`。登录会话、密码哈希等与成绩无关的数据不会造成误重试。有效的记录 `teamId` 是提交时不可变归属，优先于账号当前队伍，因而 SSO 后续转队不会搬走 Python 或 Blockly 历史成绩；仅当旧 Python 记录把所有者用户 ID 误存于 `teamId`、该值并非任何真实队伍时，才按 `ownerUserId` 回退到当前账户队伍。编程任务取同队 Python/Blockly 正式提交的最高分，识物工坊取当前服务端评分。

官网 SSO 已把 `officialUserId` 和 `officialTeamId` 持久化到统一账户库。实时导出只输出具备完整官网身份映射的普通用户，绝不会把 `usr_*` / `tea_*` 本地编号冒充官网编号；同队多个官网账号会分别输出。实时源默认仅支持初赛全量，且必须配置权威晋级文件；缺少文件时失败关闭，不会把未知晋级状态静默写成全 0。文件按 `stages.preliminary`、`stages.rematch` 分区，列出的队伍值为 `0` 或 `1`，未列出的队伍视为未晋级，系统不会按排名自行推断名额。

如需使用赛会确认后的冻结快照，配置 `CHENLONG_SCORE_DOWNLOAD_SNAPSHOT_PATH` 后会替代实时三服务数据源。也可在嵌入式部署时注入下列接口；核心不会将本地临时账号 ID 自动当作官网 ID：

```js
const scoreDataSource = {
  async listScoreRows({
    competitionStage,
    groupType,
    pullType,
    lastUpdateTime,
    snapshotTime,
    maximumRows
  }) {
    return { rows: [], snapshotTime };
  }
};
```

`rows` 必须已经包含官网 `user_id`、官网 `team_id` 及权威排名/晋级状态。若成绩源只有本地 ID，可使用 `createMappedScoreDataSource(scoreDataSource, identityDataSource)`；身份源实现 `resolveMany(rows, context)`，按输入顺序返回官网字段映射。也可以使用 `createJsonScoreDataSource({ filePath, identityDataSource })` 读取快照。

快照文件结构：

```json
{
  "schemaVersion": "chenlong.official-score-snapshot/v1",
  "snapshot_time": 1726588800,
  "incremental_complete": true,
  "rows": [
    {
      "competition_stage": "preliminary",
      "user_id": "<官网用户 ID>",
      "team_id": "<官网队伍 ID>",
      "team_name": "<队伍名称>",
      "group_type": "primary",
      "score_task1": 60,
      "score_task2": 20,
      "total_score": 80,
      "group_rank": 1,
      "promote_status": 1,
      "evaluate_finish_time": 1726588700
    }
  ]
}
```

快照文件必须以同目录临时文件写完后原子替换，不能原地覆盖。读取端会连续读取两份完整文件并校验文件身份与 SHA256；持续变化时返回 `5002`。全量导出可省略 `incremental_complete`。只有快照发布流程能保证**成绩、队名、组别、官网用户/队伍映射、晋级状态任一变化都会推进相应行的 `evaluate_finish_time`**时，才可写入 `"incremental_complete": true`；否则增量请求会失败关闭。快照还必须至少包含所请求赛段的一行，避免把“赛段未发布”静默导出为空包。

实时源遇到官网身份关系冲突、子服务不可用、记录结构不一致或快照超限时返回 `5002`，不会降级导出不可信身份。当前持久化协调器面向统一平台的单 Node 进程；若未来部署多个网关实例，防重放、日限额与下载元数据必须迁移到共享且支持原子事务的存储。

## 自动测试

`tests/score-download.test.js` 全部使用临时目录、临时 RSA 密钥和内存成绩源，覆盖：

- ASCII 签名、时间窗口、严格小写签名与并发防重放；
- 全量包每日 5 次上限、生成失败后的额度释放，以及不占全量额度的独立增量频控；
- 来源 IP 白名单、可信代理、可选 AppKey，以及白名单 A 机生成/B 机下载；
- 50,000 行上限、组别/增量筛选和 CSV 公式防护；
- 同队多用户按队排名展开、跨队用户 ID 冲突拒绝及 Python 旧记录的所有者归队；
- 超过一万条历史运行的最佳分聚合、活动会话与保留归档容量分离，以及分页源变化检测；
- AES-256-CBC 解密、RSA-OAEP-SHA256 解包、ZIP 中央目录/CRC/`score.csv` 回环，以及误把 IV 一并解密的回归诊断；
- 统一网关公开路由、初赛全量实时读取、复赛/增量冻结快照优先级、快照稳定性与外部身份映射接口。

测试不会读取或写入正式账号、比赛记录或正式成绩文件。
