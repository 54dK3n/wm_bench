#!/usr/bin/env python3
"""Read-only selection/identity diagnosis of saved opt2-r1; never runs a robot."""
import collections
import hashlib
import json
import math
from pathlib import Path
import sys

OUT = Path(__file__).resolve().parent
ROUND = OUT.parent
ROOT = OUT.parents[4]
sys.path.insert(0, str(ROOT / "tools"))
from detection_evaluation import native_truth, label_detection, M5
from p3_offline_choice import evaluate_first_choice


def load(path): return json.loads(Path(path).read_text())
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def wrap(x): return (x + 180) % 360 - 180


def to_odo(package, initial):
    dx, dz = package["x"]-initial["x"], package["z"]-initial["z"]
    c, s = math.cos(initial["heading"]), math.sin(initial["heading"])
    return [(dx*c-dz*s)/8, (-dx*s-dz*c)/8]


def projected(reading, odometry):
    if reading["distanceCm"] >= 100:
        return None
    beta, yaw = math.radians(reading["bearingDeg"]), -math.radians(odometry[2])
    rho = M5["a_cm"] + M5["k"]*reading["distanceCm"] / math.cos(beta)**M5["p"]
    forward, right = M5["L_cm"] + rho*math.cos(beta), rho*math.sin(beta)
    return [(odometry[0]+forward*math.sin(yaw)+right*math.cos(yaw))/100,
            (odometry[1]+forward*math.cos(yaw)-right*math.sin(yaw))/100]


def event_rows(record):
    step = record["simulationDefinition"]["stepMs"]
    return [{"event_index": i, "tick_from_native_t": event["t"]/step, "seconds": event["t"]/1000,
             **event} for i, event in enumerate(record["events"])
            if event.get("interactionType") == "package_grab" or event.get("type") == "package_delivered"]


def run(path):
    raw = load(path); lines = raw["lines"]
    record_path, vision_path = Path(raw["fullRecordFile"]), Path(raw["visionEvidenceFile"])
    record, vision = load(record_path), load(vision_path)
    initial = record["simulationDefinition"]["initialPose"]
    events = event_rows(record)
    grabs = [e for e in events if e.get("type") == "package_grabbed" and e.get("accepted") is True and e.get("objectRole") == "target"]
    deliveries = [e for e in events if e.get("type") == "package_delivered" and e.get("objectRole") == "target"]
    starts = [i for i,e in enumerate(lines) if e.get("event") == "ball_start"]
    ball_of = lambda i: sum(start <= i for start in starts)
    consumed, observations, observation_by_line, observation_by_tick = set(), [], {}, {}
    active_releases = []
    for i,line in enumerate(lines):
        if line.get("event") == "ball_delivered": active_releases.append(line)
        if line.get("event") != "observe": continue
        truth = native_truth(line, vision, consumed, record["runId"])
        image = vision_path.parent / truth.get("image", "")
        item = {"line": i, "tick": line["tick"], "seconds": line["tick"]*.02,
                "ball_index": ball_of(i), "odo": line["odo"], "frame_id": truth.get("frame_id"),
                "exact_render": truth.get("exact_pose"), "image": str(image),
                "image_exists": image.is_file(), "image_hash_matches": image.is_file() and sha(image)==truth.get("image_sha256"),
                "targets": [p for p in truth.get("objectState",{}).get("packages",[]) if p.get("role")=="target"],
                "red": []}
        delivered_ids = {e["packageId"] for e in deliveries if e["tick_from_native_t"] <= line["tick"]}
        for raw_index, reading in enumerate(line["raw"]):
            if reading.get("category") != "target": continue
            label = label_detection(reading,truth)
            point = projected(reading,line["odo"])
            row = {"raw_index": raw_index, "raw": reading, "label": label,
                   "point_odometry_m": point, "runtime_wm_window": 40 <= reading["distanceCm"] < 90,
                   "confirmation_bearing_eligible": abs(reading["bearingDeg"]) <= 35,
                   "capped_planning_is_bearing_only": reading["distanceCm"] >= 100,
                   "matching_delivered_ids": [pid for pid in label["same_color_matches"] if pid in delivered_ids],
                   "matching_remaining_ids": [pid for pid in label["same_color_matches"] if pid not in delivered_ids],
                   "release_region_distances_cm": [math.dist(point,d["expected_release_position"])*100 for d in active_releases] if point else []}
            # Bearing-only matches are the only geometric identity hints used for clipped runtime planning.
            row["bearing_only_target_candidates"] = [g["package_id"] for g in label["geometry"]
                if g["role"] == "target" and g["bearing_error_deg"] <= 3 and abs(g["truth_camera_bearing_deg"]) < 90]
            item["red"].append(row)
        observations.append(item); observation_by_line[i]=item; observation_by_tick.setdefault(line["tick"],[]).append(item)

    def preceding_observation(index):
        return next((ob for ob in reversed(observations) if ob["line"] <= index),None)

    exclusions, selections, tracks, failures, removals = [], [], [], [], []
    for i,line in enumerate(lines):
        kind=line.get("event"); observation=preceding_observation(i)
        if kind == "delivered_target_excluded":
            matches=[r for r in observation["red"] if all(r["raw"].get(k)==line.get(k) for k in ("distanceCm","bearingDeg","confidence","category"))]
            exclusions.append({"line":i,"tick":line["tick"],"ball_index":ball_of(i),"event":line,
                               "observe_line":observation["line"],"matching_raw_count":len(matches),"raw_proof":matches})
        elif kind == "target_selection":
            target=next(c for c in line["wm_candidates"] if c["obj_id"]==line["selected_track_id"])
            points=observation["targets"] if observation and observation["tick"]==line["tick"] else []
            delivered_ids={e["packageId"] for e in deliveries if e["tick_from_native_t"] <= line["tick"]}
            distances=[{"package_id":p["id"],"distance_cm":math.dist([target["x"],target["z"]],to_odo(p,initial))*100,
                        "already_delivered":p["id"] in delivered_ids,"true_odometry_m":to_odo(p,initial)} for p in points]
            matched=[d for d in distances if d["distance_cm"]<=30]
            classification=("remaining_true_target" if len(matched)==1 and not matched[0]["already_delivered"] else
                            "already_delivered_true_target" if len(matched)==1 else "unmatched_tentative_not_CONFIRMED" if distances else "unknown")
            selections.append({"line":i,"tick":line["tick"],"ball_index":line["ball_index"],"track":target,
                "candidate_count":len(line["wm_candidates"]),"status":line["selection"]["status"],
                "execution_reason":line["selection"].get("execution_choice_reason"),
                "runtime_cost_cm":line["selection"].get("selected_cost_cm"),"truth_distances":distances,
                "classification":classification,"observe_line":observation["line"] if observation else None,
                "support_raw":observation["red"] if observation else [],
                "raw_capture_exact":bool(observation and observation["tick"]==line["tick"] and observation["exact_render"])})
        elif kind == "wm_targets":
            tracks.append({"line":i,"tick":observation["tick"] if observation else None,"ball_index":ball_of(i),"tracks":line["tracks"]})
        elif kind in ("confirmation_failed","confirmation_aborted","patrol_failed","ball_end","flow_end","navigation_budget_exhausted"):
            failures.append({"line":i,"tick":line.get("tick",observation["tick"] if observation else None),
                             "tick_scope":"explicit" if "tick" in line else "last_observe_context_not_exact_event_time",
                             "ball_index":ball_of(i),"event":line})
        elif kind == "wm_action_removed":
            prior=[e for e in grabs if e["tick_from_native_t"]<=line["tick"]]
            last=prior[-1] if prior else None
            removals.append({"line":i,"event":line,"native_grab":last,
                             "delay_seconds":line["tick"]*.02-last["seconds"] if last else None})
    stale_ray_continuations=[]
    for i,line in enumerate(lines):
        if line.get("event") != "observe": continue
        next_observe=next((j for j in range(i+1,len(lines)) if lines[j].get("event")=="observe"),len(lines))
        bridge=next(((j,lines[j]) for j in range(i+1,next_observe) if lines[j].get("event")=="target_observations"),None)
        if bridge is None or bridge[1]["seen"] != 0: continue
        before=next(((j,lines[j]) for j in range(i-1,-1,-1) if lines[j].get("event")=="viewpoint_selected"),None)
        after=next(((j,lines[j]) for j in range(i+1,next_observe) if lines[j].get("event")=="viewpoint_selected"),None)
        if before and after and before[1]["goalSource"]==after[1]["goalSource"]=="capped_bearing_only":
            stale_ray_continuations.append({"observe_line":i,"tick":line["tick"],"seconds":line["tick"]*.02,
                "raw":line["raw"],"eligible_red_seen":bridge[1]["seen"],"bridge_line":bridge[0],
                "previous_selected_line":before[0],"previous_selected":before[1],
                "next_selected_line":after[0],"next_selected":after[1],
                "definition":"fresh no-eligible-red frame followed by another capped-ray viewpoint before the next observe"})
    baseline=load(ROOT/f'artifacts/inloop/opt-1/round-2/{path.name}')
    old_record=load(baseline["fullRecordFile"])
    old_events=event_rows(old_record)
    old_grabs=[e for e in old_events if e.get("type")=="package_grabbed" and e.get("accepted") is True and e.get("objectRole")=="target"]
    first=grabs[0] if grabs else None; oldfirst=old_grabs[0] if old_grabs else None
    first_attempts=[e for e in events if e.get("interactionType")=="package_grab" and first and e["seconds"]<=first["seconds"]]
    old_attempts=[e for e in old_events if e.get("interactionType")=="package_grab" and oldfirst and e["seconds"]<=oldfirst["seconds"]]
    balls=[]
    for slot,start in enumerate(starts,1):
        end=starts[slot] if slot<len(starts) else len(lines)
        obs=[o for o in observations if start<=o["line"]<end]
        reds=[r for ob in obs for r in ob["red"]]
        balls.append({"ball_index":slot,"start_line":start,"start_tick":lines[start]["tick"],
                      "observe_count":len(obs),"red_detection_count":len(reds),
                      "red_label_counts":dict(collections.Counter(r["label"]["label"] for r in reds)),
                      "remaining_uncapped_true_in_wm_window":sum(bool(r["matching_remaining_ids"]) and r["runtime_wm_window"] for r in reds),
                      "remaining_capped_bearing_rows":[{"line":o["line"],"tick":o["tick"],"raw":r["raw"],"ids":r["bearing_only_target_candidates"]}
                         for o in obs for r in o["red"] if r["capped_planning_is_bearing_only"] and r["bearing_only_target_candidates"]],
                      "selected":[s for s in selections if s["ball_index"]==slot],
                      "wm_snapshots":[t for t in tracks if t["ball_index"]==slot],
                      "confirmed":[{"line":i,"event":e} for i,e in enumerate(lines) if start<=i<end and e.get("event")=="memory_confirmed"],
                      "exclusion_count":sum(e["ball_index"]==slot for e in exclusions),
                      "failure_events":[f for f in failures if f["ball_index"]==slot]})
    return {"map":path.stem,"source_sha256":{str(p):sha(p) for p in (path,record_path,vision_path)},
            "initial_pose":initial,"initial_target_positions":[{"package_id":p["id"],"odometry_m":to_odo(p,initial)} for p in record["interactionDefinition"]["packages"] if p["role"]=="target"],
            "P3_first_choice":evaluate_first_choice(raw,record),"selections":selections,"balls":balls,
            "observations":observations,"exclusions":exclusions,"wm_action_removals":removals,
            "native_grabs":grabs,"native_deliveries":deliveries,"native_grab_attempts":events,
            "stale_ray_continuations":stale_ray_continuations,
            "flow_end":failures[-1] if failures else None,
            "first_ball_regression":{"previous_first_grab":oldfirst,"current_first_grab":first,
                "same_package_id":bool(first and oldfirst and first["packageId"]==oldfirst["packageId"]),
                "capture_regression":bool(oldfirst and not first),"old_grab_attempts":len(old_attempts),
                "new_grab_attempts":len(first_attempts),"grab_delay_seconds":first["seconds"]-oldfirst["seconds"] if first and oldfirst else None}}


def markdown(report):
    rows=report["runs"]
    text=["# opt2 round1：选择与身份诊断","", "只读离线重算；L均为raw.lines零基索引。原生事件tick由明确的t毫秒/20ms换算；动作结束日志tick另列，不能混作抓起瞬间。","",
          "P3首选真值最优9/10；但10次首选均只有1个WM候选，其中5次代价unknown走唯一目标fallback。因此本轮证明了首次锁定目标的结果一致性，没有实测两已知候选之间的排名。第一球9次真抓取全部保留，0次capture回归；抓取次数/时间增加另列。",
          "", "|布局|首选L/tick|WM候选/状态|所选真包/最优|两真包最优成本cm|第一抓：旧→新秒（次数）|", "|---|---|---|---|---|---|"]
    for r in rows:
        c=r["P3_first_choice"];s=r["selections"][0];reg=r["first_ball_regression"]
        old,new=reg["previous_first_grab"],reg["current_first_grab"]
        costs=" / ".join(x["package_id"].replace("guangyang-","")+"="+str(round(x["best"]["cost_cm"],2)) for x in c["candidates"])
        perf=f'{old["seconds"]:.2f}→{new["seconds"]:.2f} ({reg["old_grab_attempts"]}→{reg["new_grab_attempts"]})' if old and new else "无抓取"
        text.append(f'|{r["map"]}|L{s["line"]}/t{s["tick"]}|{s["candidate_count"]}/{s["status"]}|{c["selected_package_id"]}/{c["match"]}|{costs}|{perf}|')
    text += ["", "|布局|第二球身份/结果|停止原始证据|", "|---|---|---|"]
    for r in rows:
        second=next((b for b in r["balls"] if b["ball_index"]==2),None)
        end=r["flow_end"]; e=end["event"]
        if not second: desc="未启动第二球"
        else:
            desc="; ".join(f'{s["track"]["obj_id"]} {s["classification"]} L{s["line"]}/t{s["tick"]}' for s in second["selected"]) or "未建立/锁定第二球WM轨迹"
            desc+=f'；observe {second["observe_count"]}，合法窗口真剩余目标检测 {second["remaining_uncapped_true_in_wm_window"]}，已送达区域排除 {second["exclusion_count"]}'
        text.append(f'|{r["map"]}|{desc}|L{end["line"]} tick={e.get("tick")} {e.get("reason")}; Q/C={e.get("navigation_queries")}/{e.get("navigation_controls")}|')
    counts=report["summary"]
    text += ["", f'全部排除事件{counts["exclusions_total"]}条：{counts["excluded_delivered_true"]}条严格标签唯一匹配已送达球；{counts["excluded_remaining_true"]}条匹配剩余球；{counts["excluded_no_same_color_match"]}条无严格几何匹配。不把无匹配行强行认作某个球。',
             "", "04/06的第二锁定均为64cm、35.45°、confidence .90：超原确认方位35°，三点接受数0。其M5投影约[1.4194,-.2274]m，既不在原抓取位置，也不是30cm内的新真球；最近已送达球仍约50.8cm远。下一条59cm/35.27°/.92生成另一条tentative轨迹，旧锁定ID已不在活跃快照；未获得任何球2 confirmed。详细距离、原始帧与标签在JSON selections/support_raw。",
             "", "02/08没有球2轨迹：剩余真球仅有100cm封顶方位线索，没有40≤raw<90的真球观测入库。不能把100cm视作定位。04后段也才看见剩余球的封顶方位；06第二球完全未获得剩余球匹配观测。",
             "", "05/10第二次原生grab/delivery分别对应未送达的另一package ID，非重抓已送达球。每次新API撤销均置confidence0/LOST，动作结束tick与原生抓起事件的间隔详见wm_action_removals；没有从旧位置复活同一轨迹的证据。",
             "", "建议（尚未改代码）：保持确认/WM窗口/过滤阈值，区分tentative搜寻候选与通过确认后的身份锁；候选轨迹已LOST或视点证据耗尽时明确解除旧搜寻锁并回到新线索，而不是让残留ID阻止新轨迹。封顶射线的选取与进窗应利用全部公开方位及跨次运动一致性，不能仅取列表第一项后把空帧前的陈旧射线无限保留。已送达区域排除不能盲目扩大半径，附近仍可能有另一真球；这轮没有观察到它误删已匹配剩余球。",
             "", "复算：`PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-1/selection-diagnosis/reproduce.py`。所有原始文件和依赖SHA记录于diagnosis.json。新脚本仅导入现有只读标签/独立oracle函数，不启动仿真，不更改原报告或冻结代码。", ""]
    text += ["封顶射线失联检查（限定下一次observe之前仍继续选射线视点，排除跨巡逻阶段的误计）：", "", "|布局|新帧无eligible red后仍继续的次数|首个证据|", "|---|---|---|"]
    for r in rows:
        events=r["stale_ray_continuations"]
        first=events[0] if events else None
        evidence=(f'L{first["observe_line"]}/t{first["tick"]}: L{first["previous_selected_line"]} {first["previous_selected"]["key"]} → L{first["next_selected_line"]} {first["next_selected"]["key"]}' if first else "无")
        text.append(f'|{r["map"]}|{len(events)}|{evidence}|')
    text += ["", "02/07/08在当前轮完整两球轨迹complete-link分组分别为S02/S06/S07（原opt2_report.json的scenarios/固定容差亦存入本JSON），构成三场景失联射线依据；不是单凭布局名计独立。成功05也出现一次：L664/t11700只有蓝41cm/1.1°/.86、46cm/2.48°/.78、100cm/21.17°/.76，随后仍选oil-south@25.0并最终抓到第二球；因此提前返回巡逻会改变05路径，不能声明离线已证明无回归。10没有这一触发。", "", "修复边界：只在一次真实observe刷新之后判断线索已失联。每轮循环中_planning_goal(pose, [], goal)表示尚未新观察，不能以它清空射线。返回局部进窗失败后由巡逻继续，保持所有原始红蓝、WM窗口、过滤与三点确认不变。空帧WM衰减及LOST锁释放的独立回放见EMPTY_UPDATE_REPLAY.md；不建议在缺少新证据时为旧目标无限扩展全图。", ""]
    return "\n".join(text)


def main():
    runs=[run(path) for path in sorted(ROUND.glob("map-??.json"))]
    excluded=[proof for r in runs for e in r["exclusions"] for proof in e["raw_proof"]]
    report={"scope":"offline diagnostics only; target truth never supplied to runtime", "runs":runs,
            "current_round_scenarios":load(ROUND/"opt2_report.json")["scenarios"],
            "grouping_policy":load(ROUND/"opt2_report.json")["frozen_grouping_policy"],
            "dependency_sha256":{str(p):sha(p) for p in (ROUND/"program.py",ROUND/"opt2_report.json",ROOT/"tools/detection_evaluation.py",ROOT/"tools/p3_offline_choice.py")},
            "summary":{"first_choice_matches":sum(r["P3_first_choice"]["match"] for r in runs),
                       "first_choices_single_candidate":sum(r["selections"][0]["candidate_count"]==1 for r in runs),
                       "first_choice_unknown_cost":sum(r["selections"][0]["status"]=="unknown" for r in runs),
                       "capture_regressions":sum(r["first_ball_regression"]["capture_regression"] for r in runs),
                       "exclusions_total":sum(len(r["exclusions"]) for r in runs),
                       "excluded_delivered_true":sum(bool(p["matching_delivered_ids"]) for p in excluded),
                       "excluded_remaining_true":sum(bool(p["matching_remaining_ids"]) for p in excluded),
                       "excluded_no_same_color_match":sum(p["label"]["label"]=="false" for p in excluded)}}
    (OUT/"diagnosis.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    (OUT/"DIAGNOSIS.md").write_text(markdown(report))
    print(json.dumps(report["summary"],ensure_ascii=False))


if __name__=="__main__": main()
