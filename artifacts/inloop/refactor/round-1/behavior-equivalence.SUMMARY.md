# C 原生行为等价比较

结果：FAIL

最小门限：10 个布局原生记录齐全、无执行错误；每条 inputs/events 的所有字段及顺序完全相等；原生总得分完全相同。
不归一化 seq、t、tick、evidenceId、真实输入、API 参数/返回或事件字段。日志和完整终局结果只作诊断，不新增门限。

| 布局 | inputs 旧/新 | inputs | events 旧/新 | events | 得分 旧/新 | 结果 |
|---|---:|---|---:|---|---:|---|
| map-01 | 1396/1396 | FAIL | 9/9 | PASS | 40/40 | FAIL |
| map-02 | 1514/1503 | FAIL | 13/13 | FAIL | 49.2/49.2 | FAIL |
| map-03 | 766/766 | FAIL | 12/12 | PASS | 46.2/46.2 | FAIL |
| map-04 | 860/860 | FAIL | 6/6 | PASS | 43.1/43.1 | FAIL |
| map-05 | 1118/906 | FAIL | 9/6 | FAIL | 46.2/43.1 | FAIL |
| map-06 | 903/903 | FAIL | 10/10 | PASS | 55.4/55.4 | FAIL |
| map-07 | 366/366 | FAIL | 2/2 | PASS | 40/40 | FAIL |
| map-08 | 923/782 | FAIL | 6/7 | FAIL | 43.1/46.2 | FAIL |
| map-09 | 1435/1434 | FAIL | 16/16 | FAIL | 46.2/46.2 | FAIL |
| map-10 | 1008/1002 | FAIL | 11/11 | FAIL | 49.2/49.2 | FAIL |

program_version 日志仅允许 version、file_sha256、wm_kit_commit、wm_embed_sha256 四个代码身份值不同；wm_kit_commit 明确视为代码提交身份。该日志比较属于诊断。
turn_cost_k、turn_calibration_sha256、log_conventions 及平台版本没有例外。完整字段差异、错误和文件哈希见同名 JSON。
