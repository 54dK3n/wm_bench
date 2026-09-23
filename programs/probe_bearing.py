# 1.2 / 1.3 在环采样：按已知角度旋转并 observe()，记录 odometry 与观测。
import json
def dump(step):
    print('GY ' + json.dumps({'step': step, 'observe': robot.observe(), 'odometry': robot.odometry()}, ensure_ascii=False))
dump('h0')
seq = [('left', 5), ('left', 5), ('left', 10), ('left', 10), ('right', 30), ('right', 5), ('right', 5), ('right', 10), ('right', 10), ('left', 30)]
for i, (side, deg) in enumerate(seq):
    if side == 'left':
        robot.left_angle(deg)
    else:
        robot.right_angle(deg)
    dump('rot%d' % i)
robot.forward(40)
dump('fwd40')
for i, (side, deg) in enumerate([('left', 3), ('left', 4), ('right', 14), ('left', 7), ('right', 20), ('left', 20)]):
    if side == 'left':
        robot.left_angle(deg)
    else:
        robot.right_angle(deg)
    dump('rotb%d' % i)
print('GY_DONE')
