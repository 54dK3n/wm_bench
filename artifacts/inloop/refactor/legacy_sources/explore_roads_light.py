# 2.1 在环采集：沿道路随机游走并四处观察，逐步打印 observe/odometry。
# 只用公开接口；不含任何布局坐标；不做任务动作。评分不作数（视觉证据账本已关闭）。
import json
import random
rng = random.Random(20260916)
counter = [0]
def dump(tag, extra):
    rec = {'step': counter[0], 'tag': tag, 'observe': robot.observe(), 'odometry': robot.odometry(), 'control': extra}
    print('GY ' + json.dumps(rec, ensure_ascii=False))
    counter[0] = counter[0] + 1
def look_around():
    robot.left_angle(35)
    dump('look_left', None)
    robot.right_angle(70)
    dump('look_right', None)
    robot.left_angle(35)
    dump('look_center', None)
def exit_key(e):
    return (visited.get(e['roadId'], 0), rng.random())
dump('start', None)
look_around()
controls = 0
visited = {}
while controls < 40:
    r = robot.follow_road(60, 40, False)
    controls = controls + 1
    dump('follow', r)
    stopped = r['stoppedBy']
    if stopped == 'junction' or stopped == 'road_end':
        st = robot.road_state()
        if stopped == 'junction' and not st['atNode']:
            robot.forward(2)
            st = robot.road_state()
        exits = []
        for e in st['exits']:
            if e['roadId']:
                exits.append(e)
        if len(exits) == 0:
            robot.backward(20)
            dump('backoff', None)
            continue
        best = None
        best_key = None
        for e in exits:
            k = exit_key(e)
            if best is None or k < best_key:
                best = e
                best_key = k
        chosen = best['roadId']
        visited[chosen] = visited.get(chosen, 0) + 1
        t = robot.take_exit(chosen, 30, False)
        controls = controls + 1
        dump('exit', t)
        look_around()
    elif stopped == 'front_clearance' or stopped == 'collision' or stopped == 'off_road' or stopped == 'wrong_way':
        robot.backward(25)
        dump('backoff', None)
        st = robot.road_state()
        exits = []
        for e in st['exits']:
            if e['roadId']:
                exits.append(e)
        if len(exits) > 0 and st['atNode']:
            chosen = rng.choice(exits)['roadId']
            t = robot.take_exit(chosen, 30, False)
            controls = controls + 1
            dump('exit', t)
        else:
            robot.left_angle(180)
            dump('uturn', None)
    elif stopped == 'time_limit' or stopped == 'safety_limit':
        break
    if counter[0] % 20 == 0:
        look_around()
print('GY_DONE')
