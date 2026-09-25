# Run14 离线堆叠几何诊断

本记录解释已经结束的 Run14 中，第二次释放后仍只有一个红色连通框的现象。最终样本与平台几何仅用于离线评测；下述堆叠机制、球体尺寸和真实对象信息不得作为大脑运行输入或调参依据。本文不提供布局坐标，也不据此替代相机交付见证。

## 最终几何复算

证据：`artifacts/autonomous-brain/map05-run-14/map-05-run-1/samples.json.gz`，共 5,143 条样本；末条 `seq=7970`、`t=455900` 毫秒、`tick=22795`、`cameraFrameId=580`。末条两个 target 记录的水平中心重合，`stackLevel` 分别为 0 和 1。

| 派生量 | 数值 |
| --- | ---: |
| 水平中心间距 | 0 cm |
| 每个可见球体半径 | 2.75 cm |
| 上下球心垂直间距，即三维中心间距 | 4.375 cm |
| 两半径之和 | 5.5 cm |
| 沿球心连线的重叠长度 | 1.125 cm |

换算与渲染依据均来自平台源码：

- `workspaces/guangyang-platform/projects/car-python/competition-core.js:6866`：每米 8 个世界单位，故每单位 12.5 cm。
- `workspaces/guangyang-platform/projects/car-python/app.js:10912`：可见球体 `SphereGeometry` 半径为 0.22 单位，换算为 2.75 cm。
- `workspaces/guangyang-platform/projects/car-python/app.js:1022`、`:10966`、`:11541`：层间高度为 0.35 单位；球体放置高度为共同基准高度加层号乘层间高度，释放后缩放恢复为 1。
- `workspaces/guangyang-platform/projects/car-python/app.js:1017` 的 0.28 单位是默认碰撞半径（3.5 cm），不能代替可见球体半径进行上述渲染复算。

因此这不是两颗相离的地面球：最终记录对应的两个渲染球体体积相交。这是模拟器渲染几何结论，不是对真实刚体物理的推断。

## 形成机制及像素检测的限制

`workspaces/guangyang-platform/projects/car-python/competition-core.js:2965` 的 `previewRelease()` 会查找释放点附近的已有堆叠；匹配后采用已有堆叠的水平位置，并将新球层号设为原最高层加一。`workspaces/guangyang-platform/projects/car-python/app.js:11512` 的 `releasePackageFromRobot()` 接收这一结果并按层号设置可见球体高度。最终样本中的相同水平位置及层号 0/1 与该机制一致。

`workspaces/guangyang-platform/projects/car-python/vision-pixel-core.js:444` 的检测流程先生成颜色掩码，再于 `:487` 使用四邻接连通分量，每个分量返回一个框；它没有把相连的同色球体拆成不同实例的步骤。相交的同色球体投影可能持续相连，所以改变观察方位不能保证获得两个独立红框。光照、遮挡、阈值采样与栅格化仍影响实际掩码；这里不宣称任何相机位置下一定永远只有一个检测框。

## 与大脑相机日志的一致性

以下仅来自 `artifacts/autonomous-brain/map05-run-14/map-05-run-1/brain/observations.jsonl`；像素框依次为 `(x, y, w, h)`：

| 观测 | holding | 红框 | 检测的旧交付身份 |
| --- | --- | --- | --- |
| 545 | true | (372, 208, 68, 56) | target_029 |
| 555，释放前 | true | (122, 248, 222, 232) | target_029 |
| 556，释放后 | false | (106, 82, 240, 398) | target_029 |
| 557，后退复核 | false | (256, 156, 72, 108) | target_029 |
| 571，完成原归路 | false | (372, 156, 70, 108) | target_029 |

观测 545–571 共 27 帧，每帧均只有一个 `red-ball` 检测。释放前后同一姿态的框明显向上扩展；后退及归路后仍只有一个标记为旧交付身份的红框。这与离线堆叠解释一致，但单凭该框不能让大脑推断其中包含两球，或声称新球已被独立验证。

第 75 轮的失败因此必须保留为“新释放球没有独立像素见证”，不能用离线真实交付数回填成功。原有椭圆区域、排除旧球、同帧唯一见证与空夹爪判据不因本诊断改变。
