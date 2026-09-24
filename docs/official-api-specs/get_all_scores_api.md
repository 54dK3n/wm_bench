
# 比赛系统 选手成绩打包下载接口文档

> **存档与勘误：** 本文件是官网原始附件存档，不是本平台的最终实现说明。原文未明确 IV 传输位置与 RSA-OAEP 摘要，且“用 AES 密钥解压 ZIP”的表述不完整。联调和解密必须以仓库根目录的 [`SCORE-DOWNLOAD-API.md`](../../SCORE-DOWNLOAD-API.md) 为准：下载文件为 `[16 字节 IV][AES-256-CBC 密文]`，RSA 使用 OAEP-SHA256，解密时不得把 IV 一并送入 AES 解密器。

**提供方**：比赛评测系统
**调用方**：大赛官网后端服务

### 1. 接口说明

本接口用于官网后台批量拉取指定赛段的全部参赛队伍最终成绩，请求后一次性生成加密压缩包并返回下载信息。支持最大 5 万条记录全量导出。

### 2. 安全规范

#### 2.1 基础鉴权规则

1. 调用方需提前申请`AppKey`、`AppSecret`，以及交换 RSA 公私钥对（官网生成，私钥官网留存，公钥提供给比赛系统）。

2. 所有请求必须携带`AppKey`、时间戳、参数签名，三者校验通过方可访问。

3. 仅配置在白名单内的官网服务器 IP 可调用本接口。

4. 请求时间戳与服务器时间差超过 5 分钟，直接拒绝；相同签名 5 分钟内仅有效一次。

5. 单日全量打包调用上限 5 次。

#### 2.2 加密规则

1. **文件加密**：成绩压缩包采用 AES-256-CBC 加密，密钥为 32 位随机字符串。

2. **密钥传输**：AES 密钥使用官网提供的 RSA 公钥（2048 位）加密，Base64 编码后放入响应字段`encrypt_password`，不返回明文密码。

3. **可选请求加密**：如需加密请求体，使用比赛系统公钥加密请求体后 Base64 传输，默认不开启。

### 3. 接口详情

#### 3.1 请求信息

|项|值|
|---|---|
|请求地址|`https://api.xxxx.internal/v1/score/batch-download`|
|请求方式|POST|
|Content-Type|`application/json; charset=utf-8`|

#### 3.2 请求头

|字段|类型|必填|说明|
|---|---|---|---|
|AppKey|string|是|分配给官网的唯一身份标识|
|Timestamp|int|是|10 位秒级时间戳|
|Sign|string|是|SHA256 参数签名，算法见附录|

#### 3.3 请求参数

|字段|类型|必填|说明|
|---|---|---|---|
|competition_stage|string|是|赛段标识：`preliminary`= 初赛，`rematch`= 复赛|
|group_type|string|否|组别筛选：`primary`/`junior`/`high`；不传返回所有组别|
|pull_type|string|否|拉取类型：`all`= 全量，`increment`= 增量；默认`all`|
|last_update_time|int|否|增量拉取起始时间戳，`pull_type=increment`时必填|

**请求示例**

```json
{
    "competition_stage": "preliminary",
    "pull_type": "all"
}
```

#### 3.4 响应参数

|字段|类型|说明|
|---|---|---|
|code|int|状态码，200 = 成功|
|message|string|状态描述|
|data|object|响应数据体|
|├ total|int|打包包含的成绩总条数|
|├ download_url|string|加密压缩包下载地址，有效期 24 小时|
|├ file_size|long|文件大小，单位：字节|
|├ encrypt_password|string|RSA 公钥加密后的 AES 解压密钥，Base64 编码|
|├ expire_time|int|下载链接过期时间戳|
|├ snapshot_time|int|数据快照时间戳|

**成功响应示例**

```json
{
    "code": 200,
    "message": "success",
    "data": {
        "total": 25600,
        "download_url": "https://race-file.xxxx.internal/score/preliminary_20260925.zip",
        "file_size": 12582912,
        "encrypt_password": "U2FsdGVkX1+8xQz...N6bA==",
        "expire_time": 1726675200,
        "snapshot_time": 1726588800
    }
}
```

#### 3.5 压缩包内文件说明

压缩包内为`score.csv`，UTF-8 编码，字段如下：

|字段|类型|说明|
|---|---|---|
|user_id|string|官网用户唯一 ID|
|team_id|string|队伍唯一 ID|
|team_name|string|队伍名称|
|group_type|string|参赛组别|
|score_task1|int|赛题一得分|
|score_task2|int|赛题二得分|
|total_score|int|总成绩|
|group_rank|int|组内排名|
|promote_status|int|晋级状态：0 = 未晋级，1 = 晋级|
|evaluate_finish_time|int|评测完成时间戳|

### 4. 错误码

|错误码|说明|处理建议|
|---|---|---|
|200|请求成功|-|
|4001|参数缺失或格式错误|检查必填参数与枚举值|
|4002|AppKey 无效或已禁用|核对 AppKey|
|4003|签名校验失败|检查签名算法、参数排序、AppSecret|
|4004|请求时间戳过期|同步服务器时间后重试|
|4005|IP 不在白名单|提交官网服务器 IP 至运维加白|
|4006|调用频率超限|降低调用频率，单日不超过 5 次|
|5001|服务器内部错误|稍后重试，或联系运维|
|5002|成绩数据正在生成|等待 1-2 分钟后重试|

### 5. 完整调用流程示例

1. **官网侧生成请求签名**

    - 参数按 ASCII 字典序排序：`competition_stage=preliminary&pull_type=all`

    - 拼接请求头与密钥：`AppKey=official_web&competition_stage=preliminary&pull_type=all&Timestamp=1726588800&AppSecret=xxxxxx`

    - SHA256 计算得到`Sign`。

2. **发送请求**
携带请求头与参数，POST 调用接口。

3. **比赛系统处理**

    - 校验 AppKey、签名、时间戳、IP 白名单；

    - 查询成绩数据，生成 CSV；

    - 生成随机 32 位 AES 密钥，加密 ZIP 文件；

    - 用官网 RSA 公钥加密 AES 密钥，Base64 编码得到`encrypt_password`；

    - 返回响应。

4. **官网侧解密**

    - 下载 ZIP 文件；

    - 用官网 RSA 私钥解密`encrypt_password`，得到 AES 明文密钥；

    - 用 AES 密钥解压 ZIP，得到成绩 CSV。

### 附录：签名算法

1. 收集所有请求参数（包含请求头`AppKey`、`Timestamp`，不含`Sign`）；

2. 参数名按 ASCII 字典序升序排列，拼接为`key=value&key=value`格式字符串；

3. 字符串末尾拼接`&AppSecret=你的密钥`；

4. 对最终字符串做 SHA256 哈希，结果转小写，即为`Sign`。
