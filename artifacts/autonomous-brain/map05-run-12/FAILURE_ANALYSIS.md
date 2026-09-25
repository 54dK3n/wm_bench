# Run12 失败分析 — 模型修正请求传输重试耗尽

本局为 **FAIL，独立有效交付0/2**。第14轮首次模型输出尝试 go_to 尚未确认的 target_024，被状态校验拒绝；随后的修正请求经历一次连接提前关闭和两次HTTP 502，达到原有2次传输重试上限后抛出 LLMRequestError，该轮 action=null。本局没有评测方停止，也没有成功 done。

driver v5 已完成正式导出：status=complete、evidenceExport.complete=true，五个数据集均完成，没有导出失败、stopError或controllerErrors。brain 失败与完整导出是两个独立事实。不能将本局描述为外部中止、轮数/时间上限触发，或源代码运行中修改。

| 指标 | 复算结果 |
|---|---:|
| 轮数 / 模型调用 | 14 / 17 |
| 模型累计请求耗时 | 326.578321878秒 |
| brain 墙钟用时 | 361.237445333秒 |
| 仿真 / 观测 / 已记录动作执行 | 45.98秒 / 70 / 43 |
| 动作失败 / 模型执行错误 / 外部停止错误 | 1 / 1 / 0 |
| 抓取 / 放置 / 有效交付 | 0 / 0 / 0 |
| 终端sample tick / record结束tick | 2299 / 2299 |
| 请求上限 | 200轮 / 1200仿真秒，均未达到 |

## 第14轮请求序列

| 调用 | 决策尝试 | 结果 | 传输重试索引 / 上限 | 请求耗时（秒） |
|---|---:|---|---|---:|
| 14 | 1 | go_to(target_024)；go_to requires a CONFIRMED object | 0 / 2 | 19.744593625 |
| 15 | 2 | RemoteDisconnected | 0 / 2 | 39.924974125 |
| 16 | 2 | HTTPError HTTP502 | 1 / 2 | 64.854015459 |
| 17 | 2 | HTTPError HTTP502；重试耗尽 | 2 / 2 | 67.247829833 |

重试前延迟分别为0、1、2秒。这三次是同一修正请求的传输尝试；前13轮各有一个正常模型输出。整个失败决策期间仿真时间保持45.98秒，模型没有执行这条未确认目标的 go_to。此处能确定的是保存的HTTP/传输错误，不能仅凭记录确定服务端的底层故障原因。

另一次失败发生于r9：explore 的 follow_road 因front_clearance停止，移动13.8cm、58ticks；执行道路回退恢复，3个恢复步骤后重新观测到路口，末段3.2cm、21ticks，结果为 road_blocked_returned_to_junction。依据在obs34→40、最终obs41。该轮不是模型传输错误，也没有导致本次终止。

## 逐球事件与评测边界

独立 evaluator v3 从本局record事件和最终位置重算，而非接受driver的success标记：两颗目标都没有有效交付事件，最终均在存放区外且未夹持。原生事件只有run_started和run_finished；没有grab或delivery事件，motions内也没有grab或release调用。

- 第一颗真值目标首次可唯一对应的原始视觉观测为r2/obs5，2.76秒；WM的target_024首次入库是r11/obs53，34.58秒。二者不是同一时间口径。该轨迹还有obs66的观测，但始终没有CONFIRMED、抓取或交付事件。
- 第二颗目标没有可唯一对应的原始视觉或WM轨迹时间点；保留空值，不能把未匹配等同于已证明没有出现在图像中。
- 最后一轮状态仍有pending_objects=[target_024]，5个记账路口、7个未探索出口。
- CONFIRMED红球位置误差样本为0，均值、RMSE及最大值为null，不报告零误差。
- 独立Judge没有可对照的pick/place动作：eligible=0、match=0、假阳性=0、假阴性=0、unverifiable=0；14轮均不在抓放对照范围。不能据此声称所有动作都经过真值验证。

完整逐球时间线、失败动作及来源哈希见 `report/REPORT.md` 和 `report/evaluation.json`。真实模型输入/输出、原始状态、动作与依据在 `map-05-run-1/brain/`；评测真值仅离线使用，未送入brain。

## 证据与源码完整性

冻结提交 `885c24f8d2b58870fe42c42d434610f9dab96a27` 的七个brain文件及driver共8文件，与运行前manifest、运行后sourceManifest和brain自记哈希逐项匹配；sourcesUnchanged=true。平台与capture函数的前后哈希也一致。详细证明见 `source-commit.json`，不以当前工作树内容代替冻结版本。

四份gzip均读至末尾通过完整性检查，压缩和展开长度/SHA256逐项匹配evidence.json；envelope字节哈希也匹配。record原始压缩文件为17,645,182字节，展开25,185,137字节，低于100MiB，无需分片。record SHA256：

```text
f65ed8daa46096d30f6565305076cdca434f814c0fae0420a38d0387934a1e8e
```

record完整，最后sample与结束tick相等。native拒绝调用0，非白名单已接受调用0；brain记录324条bridge请求，非白名单请求0。

严格离线模型重放PASS：14/14轮、17/17调用，精确复现末轮action=null与错误，除mode外完整记录一致且全部耗尽；网络调用0、环境读取尝试0、源证据未变。重放不是任务验收，也不重放物理仿真。

归档指标由日志条数、elapsed_s求和、最大公开观测仿真时间及独立record评测复算；见 `run-metrics.json`。压缩包校验见 `archive-integrity.json`。前11局索引条目及33份既有报告逐项保留，见 `archive-checks.json`；Run11缺失导出的限制没有被本局证据替代。
