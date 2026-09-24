
# 比赛系统 单点登录比赛评测系统，跳转接口规范

**提供方**：比赛评测系统
**调用方**：大赛官网
**适用场景**：官网已登录用户点击「进入比赛系统」，免二次登录跳转至比赛系统

## 1. 跳转方式

官网后台生成带签名的跳转 URL，用户点击后通过浏览器**302 重定向 / 直接跳转**至比赛系统，比赛系统校验通过后自动登录并进入比赛首页。

跳转入口地址：

```Plain Text
https://race.example.com/sso/jump
```

## 2. 跳转参数

所有参数以 URL Query 参数形式携带，参数如下：

|参数名|类型|必填|说明|
|---|---|---|---|
|user_id|string|是|官网用户唯一 ID|
|team_id|string|是|参赛队伍唯一 ID|
|group_type|string|是|参赛组别：`primary`/`junior`/`high`|
|team_name|string|是|队伍名称，需 URL 编码|
|timestamp|int|是|10 位秒级时间戳，链接生成时间|
|sign|string|是|SHA256 签名，算法见下文|

## 3. 签名算法

签名密钥为双方约定的 `SSO_SECRET`（仅存双方服务端，不外露）。

计算步骤：

1. 收集所有业务参数（`user_id`、`team_id`、`group_type`、`team_name`、`timestamp`），**不包含****`sign`****本身**；

2. 参数名按 **ASCII 字典序升序** 排列；

3. 拼接为 `key=value&key=value` 格式字符串；

4. 字符串末尾拼接 `&secret=SSO_SECRET`；

5. 对最终字符串做 **SHA256** 哈希计算，结果转小写，即为 `sign`。

## 4. 比赛系统侧校验逻辑

1. **参数完整性校验**：检查所有必填参数是否缺失，缺失直接返回错误；

2. **时间戳校验**：`timestamp`与当前服务器时间差超过 **5 分钟**，判定链接过期，拒绝登录；

3. **签名校验**：按相同算法重算签名，与传入的`sign`对比，不一致则拒绝；

4. **防重放校验**：同一`user_id`+`timestamp`+`sign`组合，5 分钟内仅允许使用 1 次，防止链接泄露后重复使用；

5. **校验通过**：

    - 在比赛系统本地创建 / 更新用户映射（仅存 user_id、team_id、group_type、team_name，不存密码）；

    - 生成本地会话（session/token）；

    - 自动跳转至比赛系统首页 / 任务页面。

## 5. 错误处理

校验失败时，统一跳转至错误提示页面，返回错误码与说明：

|错误码|说明|
|---|---|
|1001|参数缺失|
|1002|链接已过期|
|1003|签名校验失败|
|1004|用户无对应参赛权限|
|1005|链接已失效（禁止重复使用）|

## 6. 完整示例

### 已知条件

- SSO_SECRET = `RaceJump@2026#Secret`

- 参数值：
user_id = U10086
team_id = T20260100
group_type = primary
team_name = 实验二小一队
timestamp = 1726590000

### 步骤 1：参数排序拼接

```Plain Text
group_type=primary&team_id=T20260100&team_name=实验二小一队&timestamp=1726590000&user_id=U10086
```

### 步骤 2：拼接密钥

```Plain Text
group_type=primary&team_id=T20260100&team_name=实验二小一队&timestamp=1726590000&user_id=U10086&secret=RaceJump@2026#Secret
```

### 步骤 3：计算签名

SHA256 结果：`f9c5661d236b4cd1536f869612f926cdf93b7106a1cb861b2c1139f8586988d0`

### 最终跳转链接

```Plain Text
https://race.example.com/sso/jump?user_id=U10086&team_id=T20260100&group_type=primary&team_name=%E5%AE%9E%E9%AA%8C%E4%BA%8C%E5%B0%8F%E4%B8%80%E9%98%9F&timestamp=1726590000&sign=f9c5661d236b4cd1536f869612f926cdf93b7106a1cb861b2c1139f8586988d0
```

## 7. 安全补充说明

1. `SSO_SECRET`与成绩接口的`AppSecret`分开设置，互不通用；

2. 链接有效期固定 5 分钟，最长不超过 10 分钟；

3. 比赛系统需记录所有跳转日志（user_id、时间、IP、结果），便于审计排查；

4. 生产环境必须 HTTPS 传输，防止参数链路窃听。
