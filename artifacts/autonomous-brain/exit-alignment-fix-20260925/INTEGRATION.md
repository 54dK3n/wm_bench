# 第十一局前合并验证

以冻结提交 `27d3a4eb3eed854d8101c837bbaf3aafa2e09f18` 为基线，将本目录的出口对准/受阻优先修复与 [归档未确认候选分类](../completion-hypothesis-fix-20260925/REPORT.md) 合并。实际应用五份分文件补丁，跳过独立 Actions 版本补丁；保留抓取 v12 的实测操纵记录、持物复看和归路逻辑。

最终版本：Actions v13、Perception v6、Runtime v6、LLM v10。全部 `tests/test_brain_*.py`：423 passed，exit 0，见 `integrated-tests.txt` / `integrated-tests.json`。最终源码、测试和应用补丁 SHA256 见 `version.json`；候选前后差异与独立回放证据保留在各自目录。

未确认即归档的 LOST 只表示不确定假设退出待办，不表示真实物体不存在或已送达。原始历史仍在，新增检测照常关联/建轨；已确认 LOST、持物、释放未验证和不完整首次帧历史继续阻塞结束。该策略不使用真值、布局或球数，不改变确认与抓放判据。

第十局仍为 FAIL、有效送达 1/2。离线测试并非仿真验收；新局使用 `artifacts/autonomous-brain/map05-run-11`，200 轮/1200 仿真秒上限不变，源码在运行期间冻结。
