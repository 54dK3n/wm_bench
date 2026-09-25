# 合并验证

Navigation v3 的当前观测反向出口判定已与 Actions v14 的八方向环视合并；Perception v6、Runtime v6、LLM v10 不变。评测器 v3 仅增加 driver v5 来源格式兼容，验收条件不变。

完整大脑测试 447 passed、exit 0，原始输出和最终文件 SHA256 在 `integrated-tests.txt` / `integrated-tests.json`。第一次完整测试为 1 failed / 446 passed，保存在 `integrated-initial-tests.*`：一个旧直线路况 fixture 缺少公开 headingErrorDeg 字段，补 0 后重跑。原有“只选择不算走通、到达后才算完成”断言未改；缺失切线时不能确认反向出口的回归另行保留。

源改动保留现有 15cm 路口关联、15°出口关联和45°方向范围。当前不确定的路口身份仍分开记忆，不改写历史运行。该合并验证不是双球真实验收，正式下一局另建目录。
