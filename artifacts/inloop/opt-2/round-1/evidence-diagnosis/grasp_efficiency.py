"""Offline native-grab geometry and scan cost; never imports a controller."""
import hashlib
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROUND = HERE.parent
MIN_F, MAX_F, MAX_SIDE, STEP = 4.75, 16.875, 4.75, 6.0
MAX_RADIUS = math.hypot(MAX_F, MAX_SIDE)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def exact_pose(record, tick):
    matches = [i for i in record["inputs"] if i.get("tick") == tick
               and (i.get("startState") or {}).get("tick") == tick]
    assert matches and all(i["startState"]["pose"] == matches[0]["startState"]["pose"] for i in matches)
    return {"pose": matches[0]["startState"]["pose"], "tick": tick,
            "input_seq": [i["seq"] for i in matches]}


def components(package, pose, units):
    dx, dz = package["x"] - pose["x"], package["z"] - pose["z"]
    h = pose["heading"]
    return {"forward_cm": (-dx * math.sin(h) - dz * math.cos(h)) * 100 / units,
            "right_cm": (dx * math.cos(h) - dz * math.sin(h)) * 100 / units,
            "radius_cm": math.hypot(dx, dz) * 100 / units}


def main():
    report_path = ROUND / "opt2_report.json"
    report = json.loads(report_path.read_text())
    scenario = {name: scene["scenario"] for scene in report["scenarios"] for name in scene["members"]}
    inputs, result = {str(report_path): sha(report_path)}, []
    for run in report["runs"]:
        raw_path = ROUND / (run["map"] + ".json")
        raw = json.loads(raw_path.read_text())
        full_path = Path(raw["fullRecordFile"])
        record = json.loads(full_path.read_text())
        inputs.update({str(raw_path): sha(raw_path), str(full_path): sha(full_path)})
        lines = raw["lines"]
        units = record["ruleDefinition"]["unitsPerMeter"]
        starts = [(i, row) for i, row in enumerate(lines) if row.get("event") == "ball_start"]
        for ball in run["balls"]:
            if not ball["grab_attempts"]:
                continue
            start = next(i for i, row in starts if row["ball_index"] == ball["ball_index"])
            end = next((i for i, row in starts if i > start), len(lines))
            package = next(p for p in record["interactionDefinition"]["packages"] if p["id"] == ball["package_id"])
            indexed = list(enumerate(lines[start:end], start))
            log_attempts = [(i, row) for i, row in indexed if row.get("event") == "grab_step"
                            or row.get("event") == "grab_lateral_recovery_step" and "skipped" not in row]
            events = ball["grab_attempt_details"]
            assert len(log_attempts) == len(events)
            attempts, stations = [], []
            for (line_index, row), event in zip(log_attempts, events):
                tick = event["t"] / 20
                pose = exact_pose(record, tick)
                geometry = components(package, pose["pose"], units)
                after_tick = row.get("tick_after_grab", row.get("tick"))
                assert after_tick >= tick
                target_log_index, target = next((i, t) for i in range(line_index - 1, -1, -1)
                    if lines[i].get("event") == "wm_targets" for t in lines[i]["tracks"]
                    if t["id"] == ball["track_id"])
                public_pose = row.get("pose_cm") or [row["pose"][0] * 100, row["pose"][1] * 100, row["pose"][2]]
                dx, dz = target["x"] * 100 - public_pose[0], target["z"] * 100 - public_pose[1]
                heading = math.radians(public_pose[2])
                wm_f, wm_s = dz * math.cos(heading) - dx * math.sin(heading), dx * math.cos(heading) + dz * math.sin(heading)
                attempt = {"raw_line_index": line_index, "kind": row["event"], "native_event": event,
                           "native_exact_pose": pose, "truth": geometry,
                           "wm_logged_track_line": target_log_index,
                           "wm_components_from_rounded_log_cm": {"forward": wm_f, "right": wm_s, "radius": math.hypot(dx, dz)},
                           "wm_exact_logged_radius_cm": 100 * row["wm_distance_m"] if "wm_distance_m" in row else None,
                           "wm_component_basis": "WM target log rounded to 0.001 m; public pose as logged; do not claim exact internal components",
                           "raw": row}
                attempts.append(attempt)
                if row["event"] == "grab_step":
                    scan = next(((i, x) for i, x in indexed if i == line_index + 1 and x.get("event") == "grab_lateral_recovery_start"), None)
                    scan_end = next(((i, x) for i, x in indexed if scan and i > scan[0] and x.get("event") in ("grab_lateral_recovery_end", "grab_step")), None)
                    scan_trials = [(i, x) for i, x in indexed if scan and i > scan[0]
                                   and (scan_end is None or i < scan_end[0]) and x.get("event") == "grab_lateral_recovery_step"]
                    recover_end = scan_end[1] if scan_end and scan_end[1].get("event") == "grab_lateral_recovery_end" else None
                    wm_radius = attempt["wm_exact_logged_radius_cm"]
                    stations.append({"station": row["step"], "raw_line_index": line_index,
                                     "native_event_tick": tick, "after_grab_tick": after_tick,
                                     "accepted": event["accepted"], "truth": geometry,
                                     "wm_components_approx": attempt["wm_components_from_rounded_log_cm"],
                                     "wm_radius_exact_logged_cm": wm_radius,
                                     "truth_cannot_grab_under_any_in_place_heading": geometry["radius_cm"] > MAX_RADIUS,
                                     "proposed_runtime_gate": wm_radius > MAX_RADIUS and wm_f - STEP >= MIN_F and abs(wm_s) <= MAX_SIDE,
                                     "extra_attempts": sum("skipped" not in x for _, x in scan_trials),
                                     "scan_success": any(x.get("holding") == "目标物" for _, x in scan_trials),
                                     "scan_start_line": scan[0] if scan else None,
                                     "scan_end_line": scan_end[0] if recover_end else None,
                                     "scan_seconds": (recover_end["tick"] - scan[1]["tick"]) * .02 if recover_end else 0,
                                     "scan_trial_lines": [i for i, _ in scan_trials]})
            result.append({"map": run["map"], "scenario": scenario[run["map"]], "ball_index": ball["ball_index"],
                           "package_id": ball["package_id"], "position_label": ball["WM_truth_association"]["evidence"]["position_label"],
                           "attempts": attempts, "stations": stations,
                           "scan_seconds": sum(s["scan_seconds"] for s in stations),
                           "extra_scan_grabs": sum(s["extra_attempts"] for s in stations),
                           "grabs_total": len(attempts)})
    assert all(sha(Path(path)) == before for path, before in inputs.items())
    output = {"schema": "opt2-grasp-efficiency/v1", "simulation_runs_started": 0,
              "public_rectangle_cm": [MIN_F, MAX_F, MAX_SIDE], "derived_max_radius_cm": MAX_RADIUS,
              "input_sha256": inputs, "inputs_unchanged": True,
              "candidate_runtime_gate_is_proposal_not_deployed": "after empty original grab: WM radius > hypot(maxForward,maxSide), WM forward - existing 6cm step >= minForward, abs(WM side) <= maxSide",
              "warning": "WM positions are estimates. A runtime far gate cannot prove truth unreachable. This offline analysis is not a counterfactual simulation.",
              "balls": result}
    (HERE / "grasp_efficiency.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    for ball in result:
        print(ball["map"], ball["ball_index"], ball["position_label"], "grabs", ball["grabs_total"], "scansec", ball["scan_seconds"])
        for station in ball["stations"]:
            print("  ", station["raw_line_index"], station["native_event_tick"], "truth", station["truth"], "WM", station["wm_components_approx"], "WMexactR", station["wm_radius_exact_logged_cm"], "gate", station["proposed_runtime_gate"], "extras", station["extra_attempts"])


if __name__ == "__main__":
    main()
