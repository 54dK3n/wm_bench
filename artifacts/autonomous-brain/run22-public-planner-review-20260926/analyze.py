#!/usr/bin/env python3
"""Recompute the review using only the saved public prefix and prompt."""
from pathlib import Path
import hashlib
import json

HERE = Path(__file__).resolve().parent


def sha(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def main():
    manifest = json.loads((HERE / "manifest.json").read_text())
    raw = (HERE / manifest["snapshot"]["file"]).read_bytes()
    prompt_bytes = (HERE / manifest["prompt"]["file"]).read_bytes()
    assert sha(raw) == manifest["snapshot"]["sha256"]
    assert sha(prompt_bytes) == manifest["prompt"]["sha256"]
    assert raw.endswith(b"\n")
    rows = [json.loads(line) for line in raw.splitlines()]
    assert [row["round"] for row in rows] == list(range(1, 77))
    prompt = prompt_bytes.decode("utf-8")
    parsed = {}
    request_checks = []
    for row in rows:
        record = row["llm_output"]
        request = record["request"]
        messages = request["messages"]
        sent = json.loads(messages[1]["content"])
        checks = {
            "round": row["round"],
            "request_sha256_matches": sha(canonical(request)) == record["request_sha256"],
            "sent_state_equals_recorded_state": sent == row["state"],
            "sent_prompt_equals_saved_current_prompt": messages[0]["content"] == prompt,
            "model_action_equals_executed_action": record["action"] == row["action"],
        }
        assert all(value for key, value in checks.items() if key != "round"), checks
        request_checks.append(checks)
        parsed[row["round"]] = sent

    target = "storage-zone_062"
    requested = {"action": "go_to", "params": {"object_id": target}}
    standoff_rows = [row for row in rows if row["action"] == requested
                    and row["result"]["success"] is True
                    and row["result"]["reason"] == "target_seen_at_standoff"]
    assert [row["round"] for row in standoff_rows] == list(range(66, 77))

    timeline = []
    for row in rows:
        if row["round"] < 59:
            continue
        sent = parsed[row["round"]]
        evidence = row["result"].get("evidence", {})
        detection = evidence.get("detection") or {}
        timeline.append({
            "round": row["round"], "action": row["action"],
            "success": row["result"]["success"], "reason": row["result"]["reason"],
            "state_simulation_seconds": sent["simulation_seconds"],
            "result_simulation_seconds": row["simulation_seconds"],
            "result_tick": evidence.get("tick"),
            "holding_before": sent["robot"]["holding"],
            "holding_after": evidence.get("holding"),
            "held_object_id": sent["robot"]["held_object_id"],
            "pose_before": sent["robot"]["pose"],
            "selected_storage_before": next((item for item in sent["objects"] if item["id"] == target), None),
            "result_detection": {key: detection.get(key) for key in (
                "track_id", "category", "source", "distance_cm", "bearing_deg", "method", "frame_id")}
                if detection else None,
            "request_sha256": row["llm_output"]["request_sha256"],
        })

    inspected_requests = []
    for number in range(72, 77):
        row, sent = rows[number - 1], parsed[number]
        recent = sent["recent_actions"]
        assert [item["round"] for item in recent] == list(range(number - 5, number))
        assert all(item["action"] == requested and item["success"] is True
                   and item["reason"] == "target_seen_at_standoff" for item in recent)
        assert sent["robot"]["holding"] is True
        inspected_requests.append({
            "round": number, "model": row["llm_output"]["request"]["model"],
            "request_sha256": row["llm_output"]["request_sha256"],
            "holding": sent["robot"]["holding"], "recent_actions_as_sent": recent,
            "selected_action": row["action"],
            "validation_error": row["llm_output"]["validation_error"],
            "transport_error": row["llm_output"]["transport_error"],
        })

    place_rows = [{"round": row["round"], "result": row["result"]}
                  for row in rows if row["action"] and row["action"]["action"] == "place"]
    assert not place_rows
    repeat_rows = [row for row in rows if 67 <= row["round"] <= 76]
    assert len({canonical(parsed[row["round"]]["robot"]["pose"]) for row in repeat_rows}) == 1
    assert {row["result"]["evidence"]["tick"] for row in standoff_rows} == {13545}
    assert {row["simulation_seconds"] for row in standoff_rows} == {270.9}

    snippets = [
        "go_to 沿自建道路到目标前 25–40cm。",
        "place 按当前观测的绿色存放区对准放下，是否送达依据夹爪和球在区内的观测证据。",
        "有持物时，依据当前 objects 中自己的 distance_cm，优先选择最近的 CONFIRMED 存放区",
        "先 go_to 再 place",
        "失败时利用观测改变动作，不要机械重复同一失败动作。",
    ]
    assert all(snippet in prompt for snippet in snippets)
    return {
        "schema": "run22-public-planner-review-analysis/v1",
        "snapshot_sha256": sha(raw), "snapshot_rounds": [1, 76],
        "scope": "Saved public rounds prefix and current prompt only; no model calls or truth exports.",
        "verified_request_count": len(request_checks), "request_checks": request_checks,
        "place_attempt_count": len(place_rows), "place_attempts": place_rows,
        "same_storage_success_standoff_rounds": [row["round"] for row in standoff_rows],
        "same_storage_success_standoff_count": len(standoff_rows),
        "unchanged_simulation_seconds": 270.9, "unchanged_result_tick": 13545,
        "r67_through_r76_pose": parsed[67]["robot"]["pose"],
        "wm_distance_cm_r67_through_r76": sorted({next(item["distance_cm"] for item in parsed[row["round"]]["objects"] if item["id"] == target) for row in repeat_rows}),
        "visual_distance_cm_r66_through_r76": sorted({row["result"]["evidence"]["detection"]["distance_cm"] for row in standoff_rows}),
        "timeline_r59_through_r76": timeline, "actual_requests_r72_through_r76": inspected_requests,
        "earlier_target_standoff_then_pick": [{"round": row["round"], "action": row["action"],
            "success": row["result"]["success"], "reason": row["result"]["reason"]} for row in rows if 43 <= row["round"] <= 47],
        "prompt_evidence": {"exact_snippets": snippets,
            "contains_target_seen_at_standoff_literal": "target_seen_at_standoff" in prompt},
        "limitations": ["No claim that a place action would succeed physically; it was never attempted in this prefix.",
            "The difference between WM object distance and direct observed distance is evidence; its causal role in model repetition is a hypothesis, not a proven model rationale.",
            "This fixed prefix ends at round 76 and makes no statement about later rounds."]}


if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=False, indent=2))
