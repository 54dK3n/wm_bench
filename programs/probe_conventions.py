# 坐标约定探针：确定 headingDeg / rightCm / bearingDeg 的符号关系（平台事实，测试侧标定）。
import json
def dump(step):
    print('GY ' + json.dumps({'step': step, 'observe': robot.observe(), 'odometry': robot.odometry(), 'road': robot.road_state()}, ensure_ascii=False))
dump('start')
robot.left_angle(30)
dump('after_left_30')
robot.right_angle(60)
dump('after_right_60')
robot.left_angle(30)
dump('back_to_0')
robot.right_angle(90)
dump('after_right_90')
robot.forward(30)
dump('after_right_90_forward_30')
robot.backward(30)
robot.left_angle(90)
dump('back_to_start')
print('GY_DONE')
