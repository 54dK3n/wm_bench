# 八方向环视合并验证

独立审查后合并 Actions v14。合并时所有大脑测试 431 passed、exit 0，完整输出和 SHA256 见 `integrated-tests.*`。源码改动只涉及版本、8×45°扫描与结果名称；候选视角选择、M5、距离范围和三个独立位置确认要求不变。

随后与 Navigation v3 合并的最终检查见 [联合验证](../navigation-reverse-fix-20260925/INTEGRATION.md)。第十一局保留原来的四方向代码与失败状态，扫描缺口不被未经验证地解释为该局未完成的唯一原因。
