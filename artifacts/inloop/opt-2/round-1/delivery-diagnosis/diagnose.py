#!/usr/bin/env python3
"""Offline delivery/second-ball extraction. Writes only beside this new script."""
import ast
from collections import Counter
import hashlib
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROUND = OUT.parent
ROOT = ROUND.parents[3]
PREVIOUS = ROOT / "artifacts/inloop/opt-1/round-2"


def load(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def event_rows(lines, names, start=0, end=None):
    return [{"line_index": i, **row} for i, row in enumerate(lines)
            if start <= i < (len(lines) if end is None else end) and row.get("event") in names]


def counts(rows, field):
    return dict(Counter(str(row.get(field)) for row in rows))


def run():
    report = load(ROUND / "opt2_report.json")
    group = {name: row["scenario"] for row in report["scenarios"] for name in row["members"]}
    source = ROUND / "program.py"
    tree = ast.parse(source.read_text())
    functions = {node.name: {"line": node.lineno, "end_line": node.end_lineno}
                 for node in tree.body if isinstance(node, ast.FunctionDef)}
    rows = []
    for path in sorted(ROUND.glob("map-??.json")):
        raw = load(path)
        native_path = Path(raw["fullRecordFile"])
        native = load(native_path)
        inputs, events, lines = native["inputs"], native["events"], raw["lines"]
        queries = [{"input_index": i, **item} for i, item in enumerate(inputs) if item.get("type") == "navigation_query"]
        grabs = [{"event_index": i, **item} for i, item in enumerate(events) if item.get("type") == "package_grabbed" and item.get("accepted") and item.get("objectRole") == "target"]
        delivered = [{"event_index": i, **item} for i, item in enumerate(events) if item.get("type") == "package_delivered" and item.get("objectRole") == "target"]
        delivery_logs = event_rows(lines, {"delivery_phase_start"})
        phases = []
        for offset, start in enumerate(delivery_logs):
            next_ball = next((i for i in range(start["line_index"] + 1, len(lines)) if lines[i].get("event") == "ball_start"), len(lines))
            grab_log = next(row for row in reversed(event_rows(lines, {"ball_grabbed"}, end=start["line_index"])))
            tick_start = grab_log["tick"]
            tick_end = lines[next_ball]["tick"] if next_ball < len(lines) else native["simulationEndTick"]
            selected = event_rows(lines, {"delivery_candidate_selected"}, start["line_index"], next_ball)
            previews = event_rows(lines, {"delivery_release_preview"}, start["line_index"], next_ball)
            travel = event_rows(lines, {"delivery_candidate_travel", "delivery_candidate_unreachable", "viewpoint_unreachable",
                                       "viewpoint_take_exit", "viewpoint_direction_blocked", "viewpoint_local_blocked"}, start["line_index"], next_ball)
            rejected = [row for row in event_rows(lines, {"delivery_candidate_rejected"}, start["line_index"], next_ball)
                        if row.get("reason") != "already_tried"]
            # Boundary queries can occur before/after a printed stage at the same
            # tick. Strict start inequality avoids calling them delivery work.
            phase_queries = [q for q in queries if tick_start < q["tick"] <= tick_end]
            preview_groups = []
            for key in dict.fromkeys(row["key"] for row in previews):
                matches = [row for row in previews if row["key"] == key]
                preview_groups.append({"key": key, "count": len(matches), "first_line": matches[0]["line_index"],
                    "last_line": matches[-1]["line_index"], "first_tick": matches[0]["preview"]["tick"],
                    "last_tick": matches[-1]["preview"]["tick"], "pose": matches[0]["pose"],
                    "road": matches[0]["road"], "accepted_delivery": any(row["preview"].get("wouldCompleteDelivery") for row in matches)})
            canonical_current = start["road"]["roadId"]
            prior_road = None
            follow_by_road = Counter()
            previous_take_exit = []
            current_queries = []
            for index, item in enumerate(inputs):
                if item.get("tick", -1) > tick_start:
                    break
                if item.get("method") == "road_state":
                    prior_road = item["result"].get("roadId")
                    if prior_road == canonical_current:
                        current_queries.append({"input_index": index, "seq": item["seq"], "tick": item["tick"],
                                                "roadProgressCm": item["result"].get("roadProgressCm")})
                if item.get("method") == "follow_road":
                    follow_by_road[prior_road] += 1
                if item.get("method") == "take_exit" and item.get("args", {}).get("roadId") == canonical_current:
                    previous_take_exit.append({"input_index": index, **item})
            native_exits = [{"input_index": i, **item} for i, item in enumerate(inputs)
                            if item.get("method") == "take_exit" and tick_start <= item.get("tick", -1) < tick_end]
            phases.append({"ball_index": grab_log["ball_index"], "start_line": start["line_index"], "end_line_exclusive": next_ball,
                "start_tick": tick_start, "end_tick": tick_end, "start_state": start, "candidate_count": len(selected),
                "selected": selected, "travel": travel, "rejections": rejected, "preview_count": len(previews),
                "preview_groups": preview_groups, "post_start_query_count": len(phase_queries),
                "post_start_query_methods": counts(phase_queries, "method"), "native_take_exits": native_exits,
                "current_road_before_delivery": {"roadId": canonical_current, "follow_road_counts_by_previous_public_road": dict(follow_by_road),
                    "take_exit_to_current_road": previous_take_exit, "current_road_public_queries": current_queries},
                "finish": event_rows(lines, {"delivery_search_failed", "delivery_leave_complete", "delivery_leave_failed", "ball_delivered", "ball_end", "flow_end"}, start["line_index"], next_ball)})
        ball_starts = event_rows(lines, {"ball_start"})
        second = None
        if len(ball_starts) >= 2:
            start = ball_starts[1]
            part = lines[start["line_index"]:]
            selected = event_rows(lines, {"viewpoint_selected"}, start["line_index"])
            second_queries = [q for q in queries if q["tick"] >= start["tick"]]
            second = {"start": start, "observe_count": sum(item.get("event") == "observe" for item in part),
                "query_count_inclusive_tick": len(second_queries), "query_methods": counts(second_queries, "method"),
                "selected_count": len(selected), "goal_sources": counts(selected, "goalSource"),
                "selected_roads": counts(selected, "roadId"), "viewpoint_failure_reasons": counts([item for item in part if item.get("event") == "viewpoint_failed"], "reason"),
                "exclusions": event_rows(lines, {"delivered_target_excluded"}, start["line_index"]),
                "phase_events": event_rows(lines, {"ball_selection", "ball_confirmed", "ball_grabbed", "ball_delivered", "ball_end", "flow_end", "confirmation_failed", "viewpoint_exploration_exhausted"}, start["line_index"])}
        previous_path = PREVIOUS / path.name
        previous = load(previous_path)
        old_deliveries = [{"event_index": i, **item} for i, item in enumerate(previous["record"]["events"])
                          if item.get("type") == "package_delivered" and item.get("objectRole") == "target"]
        rows.append({"map": path.stem, "scenario": group[path.stem], "inputs": {"raw": str(path), "raw_sha256": sha(path),
            "native": str(native_path), "native_sha256": sha(native_path), "previous_raw": str(previous_path), "previous_raw_sha256": sha(previous_path)},
            "raw_lines": len(lines), "native_inputs": len(inputs), "native_events": len(events),
            "simulation_end_tick": native["simulationEndTick"], "duration_seconds": native.get("result", {}).get("durationSeconds"),
            "grabs": grabs, "deliveries": delivered, "revocations": [item for item in events if item.get("type") == "package_delivery_revoked"],
            "flow_end": event_rows(lines, {"flow_end"}), "first_delivery_regression": bool(old_deliveries and not delivered),
            "previous_first_delivery": old_deliveries[:1], "delivery_phases": phases, "second_ball": second})
    result = {"schema": "opt2-round1-delivery-diagnosis/v1", "scope": "full native/raw read; no simulator; new diagnosis files only",
        "index_convention": "zero-based raw lines/native inputs/events; source lines one-based",
        "query_boundary_policy": "delivery tick_start < tick <= tick_end; second ball tick >= ball_start may share boundary queries; counts are explicit intervals, not hidden source ownership",
        "frozen_program": str(source), "frozen_program_sha256": sha(source), "function_locations": functions,
        "first_delivery_layouts": [row["map"] for row in rows if row["deliveries"]],
        "two_delivery_layouts": [row["map"] for row in rows if len({item["packageId"] for item in row["deliveries"]}) == 2],
        "first_delivery_regressions": [row["map"] for row in rows if row["first_delivery_regression"]], "runs": rows}
    (OUT / "diagnosis.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ("first_delivery_layouts", "two_delivery_layouts", "first_delivery_regressions")}, ensure_ascii=False))


if __name__ == "__main__":
    run()
