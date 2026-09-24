# 广阳岛综合任务2：无感知固定路线版。
# 仅使用基础行驶、整数角度转向和抓放；行驶距离以厘米为单位，并保留 1 位小数。
# 当前已发布地图实测：13/13，95.7 分，
# 0 次碰撞、0 次违规、223.9 秒。
# 地图由管理员修改后，需要重新生成与测试路线。

# 目标物1
robot.right_angle(13)
robot.forward(28.1)
robot.right_angle(80)
robot.forward(81.6)
robot.right_angle(68)
robot.grab()
robot.right_angle(19)
robot.forward(12.2)
robot.left_angle(43)
robot.release()

# 目标物2
robot.right_angle(178)
robot.forward(24.4)
robot.left_angle(43)
robot.forward(179.1)
robot.right_angle(36)
robot.forward(33.8)
robot.left_angle(38)
robot.grab()
robot.left_angle(150)
robot.forward(55.3)
robot.left_angle(29)
robot.forward(174.4)
robot.right_angle(87)
robot.forward(13.1)
robot.left_angle(41)
robot.release()

# 混淆物1
robot.left_angle(120)
robot.forward(78.8)
robot.left_angle(104)
robot.forward(110.6)
robot.right_angle(93)
robot.forward(59.1)
robot.right_angle(83)
robot.forward(63.8)
robot.left_angle(89)
robot.grab()
robot.left_angle(145)
robot.forward(9.4)
robot.left_angle(37)
robot.release()

# 混淆物2
robot.right_angle(92)
robot.forward(64.7)
robot.left_angle(90)
robot.forward(90.9)
robot.grab()
robot.left_angle(101)
robot.forward(7.5)
robot.right_angle(12)
robot.release()

# 途径点2
robot.right_angle(122)
robot.forward(32.8)
robot.right_angle(62)
robot.forward(99.4)
robot.right_angle(54)
robot.forward(22.5)

# 途径点3
robot.right_angle(54)
robot.forward(39.4)
robot.left_angle(56)
robot.forward(11.2)

# 途径点4
robot.right_angle(22)
robot.forward(45.0)
robot.right_angle(54)
robot.forward(49.7)

# 途径点5
robot.right_angle(77)
robot.forward(60.0)
robot.left_angle(13)
robot.forward(35.6)
robot.right_angle(73)
robot.forward(114.4)

# 途径点6
robot.right_angle(180)
robot.forward(124.7)

# 返航
robot.right_angle(180)
robot.forward(151.9)

print("广阳岛综合任务2路线执行完成")
