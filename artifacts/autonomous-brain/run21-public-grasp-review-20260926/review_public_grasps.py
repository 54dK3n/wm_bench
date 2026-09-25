"""Recompute a fixed public Run21 prefix; no simulator, model, or truth inputs.

Run from the repository root with python3 -B <this file>. Input hashes cover
exact original JSONL bytes, not reserialized JSON or growing whole files.
"""
from itertools import islice
import hashlib
import json
import math
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def prefix_bytes(spec):
    with (ROOT / spec["path"]).open("rb") as source:
        rows = list(islice(source, spec["prefix_lines"]))
    assert len(rows) == spec["prefix_lines"] and all(row.endswith(b"\n") for row in rows)
    raw = b"".join(rows)
    assert len(raw) == spec["prefix_bytes"]
    assert hashlib.sha256(raw).hexdigest() == spec["prefix_sha256"]
    return raw


def full_region(box):
    return (box["x"] > 0 and box["y"] > 0 and box["x"] + box["w"] < 640
            and box["y"] + box["h"] < 480 and box["w"] >= 3 and box["h"] >= 3)


def pixel_q(ball, zone):
    ground_contact = (ball["x"] + ball["w"] / 2, ball["y"] + ball["h"])
    return (((ground_contact[0] - zone["x"] - zone["w"] / 2) / (zone["w"] / 2)) ** 2
            + ((ground_contact[1] - zone["y"] - zone["h"] / 2) / (zone["h"] / 2)) ** 2)


def point(row):
    return row["position_m"]["x"], row["position_m"]["z"]


def robot_point(observation):
    odo = observation["odometry"]
    return odo["rightCm"] / 100, odo["forwardCm"] / 100


def fresh(observation):
    assert observation["odometry"]["tick"] == observation["road"]["tick"] == observation["observation"]["tick"]


def main():
    manifest = json.loads((HERE / "input-manifest.json").read_text())
    loaded = {name: [json.loads(row) for row in prefix_bytes(spec).splitlines()]
              for name, spec in manifest["inputs"].items()}
    rounds, observations, motions = (loaded[name] for name in (
        "rounds.jsonl", "observations.jsonl", "motions.jsonl"))
    assert [r["round"] for r in rounds] == list(range(1, 101))
    assert [o["observation_index"] for o in observations] == list(range(1, 665))
    assert all(m["after_observation"] <= 664 and m["round"] <= 100 for m in motions)
    obs = {o["observation_index"]: o for o in observations}
    by_pair = {(m["before_observation"], m["after_observation"]): m for m in motions}
    assert len(by_pair) == len(motions)
    picks, places = [], []

    for row in rounds:
        action = row["action"]
        if action is None or action["action"] not in {"pick", "place"}:
            continue
        evidence = row["result"]["evidence"]
        start, post, final = (obs[evidence[k]] for k in (
            "before_observation", "after_observation", "final_observation"))
        for snapshot in (start, post, final):
            fresh(snapshot)
        assert str(evidence["frame_id"]) == str(post["observation"]["frameId"])
        assert evidence["tick"] == post["observation"]["tick"]
        assert final["road"]["onRoad"] is True
        trajectory = evidence.get("pick_trajectory", evidence.get("place_trajectory", []))
        detailed_trajectory = []
        for step in trajectory:
            before, after = (obs[step[k]] for k in ("before_observation", "after_observation"))
            motion = by_pair[(step["before_observation"], step["after_observation"])]
            assert motion["method"] == step["method"] and motion["params"] == step["params"]
            assert before["odometry"] == step["before"] and after["odometry"] == step["after"]
            assert before["road"]["onRoad"] == step["before_on_road"]
            assert after["road"]["onRoad"] == step["after_on_road"]
            fresh(before); fresh(after)
            detailed_trajectory.append({**motion, "holding_before": before["holding"]["holding"],
                "holding_after": after["holding"]["holding"], "on_road_before": before["road"]["onRoad"],
                "on_road_after": after["road"]["onRoad"],
                "measured_pose_displacement_cm": math.dist(robot_point(before), robot_point(after)) * 100,
                "odometer_delta_cm": after["odometry"]["distanceCm"] - before["odometry"]["distanceCm"]})
        if action["action"] == "pick":
            identity = action["params"]["object_id"]
            target = next(o for o in start["objects"] if o["id"] == identity)
            original = point(target)
            assert target["state"] == "CONFIRMED"
            initial = next(o for o in row["state"]["objects"] if o["id"] == identity)
            assert initial["status"] == "CONFIRMED" and initial["ever_confirmed"] is True
            assert not start["holding"]["holding"] and start["road"]["onRoad"]
            attempts = []
            for attempt in evidence["attempts"]:
                before, after = (obs[attempt[k]] for k in ("before_observation", "after_observation"))
                motion = by_pair[(attempt["before_observation"], attempt["after_observation"])]
                alignment = attempt["alignment"]; detection = alignment["detection"]
                assert motion["method"] == "grab" and motion["params"] == {}
                assert not before["holding"]["holding"]
                assert after["holding"]["holding"] == attempt["holding"]
                assert detection in before["perception"]["detections"]
                assert detection["track_id"] == identity
                assert str(detection["frame_id"]) == str(before["observation"]["frameId"])
                measured_range = math.dist(original, robot_point(before)) * 100
                assert abs(measured_range - alignment["remembered_distance_cm"]) < 1e-8
                assert measured_range <= 22.5 and abs(alignment["bearing_deg"]) <= 3
                attempts.append({"attempt": attempt["attempt"],
                    "before_observation": attempt["before_observation"], "after_observation": attempt["after_observation"],
                    "holding_before": False, "holding_after": attempt["holding"],
                    "remembered_range_recomputed_cm": measured_range,
                    "fresh_bearing_deg": alignment["bearing_deg"], "fresh_detection": detection,
                    "actuator_result": motion["actuator_result"]})
            held_index = next(a["after_observation"] for a in attempts if a["holding_after"])
            retreat = [m for m in motions if held_index <= m["before_observation"]
                       < m["after_observation"] <= evidence["post_observation"]]
            assert len(retreat) == 5
            assert all(m["method"] == "backward" and m["params"]["distanceCm"] == 6
                       and obs[m["after_observation"]]["holding"]["holding"] for m in retreat)
            actual_retreat = post["odometry"]["distanceCm"] - obs[held_index]["odometry"]["distanceCm"]
            assert abs(actual_retreat - 30) < 1e-8
            same_category = [d for d in post["perception"]["detections"]
                             if d["category"] == target["category"] and "position_m" in d]
            matches = [d for d in same_category if math.dist(original, point(d)) < .15]
            assert not matches and evidence["old_position_matches"] == 0 and post["holding"]["holding"]
            assert next(o for o in final["objects"] if o["id"] == identity)["state"] == "HELD"
            assert evidence["road_return"]["reason"] == "already_on_observed_road"
            assert evidence["road_return"]["motions"] == [] and post["road"]["onRoad"]
            earlier_confirmed = [o["observation_index"] for o in observations if o["observation_index"] <= start["observation_index"]
                and any(t["id"] == identity and t["state"] == "CONFIRMED" for t in o["objects"])]
            picks.append({"round": row["round"], "action": action, "source_initial_observation": start["observation_index"],
                "initial_CONFIRMED": True, "ever_confirmed": True, "first_observed_CONFIRMED_index": min(earlier_confirmed),
                "original_position_m": original, "attempts": attempts, "retreat_observations": [held_index, evidence["post_observation"]],
                "requested_retreat_cm": 30, "observed_retreat_distanceCm": actual_retreat,
                "old_position_observation": evidence["post_observation"], "old_position_gate_m": .15,
                "old_position_matches": 0, "same_category_observed_positions": [d["position_m"] for d in same_category],
                "post_holding": True, "post_onRoad": True, "road_return": evidence["road_return"],
                "final_observation": evidence["final_observation"], "final_state": "HELD",
                "trajectory_checked_against_original_motions": detailed_trajectory})
            continue

        identity = row["state"]["robot"]["held_object_id"]
        assert start["holding"]["holding"]
        assert next(o for o in row["state"]["objects"] if o["id"] == identity)["status"] == "HELD"
        aim = evidence["release_aim"]
        source = next(o for o in observations if str(o["observation"]["frameId"]) == str(aim["source_frame"]))
        greens = [d for d in source["perception"]["detections"] if d["category"] == "storage-zone"]
        complete = [d for d in greens if full_region(d["bbox"])]
        releases = [m for m in motions if evidence["before_observation"] <= m["before_observation"]
                    < m["after_observation"] <= evidence["after_observation"] and m["method"] == "release"]
        if not row["result"]["success"]:
            assert row["round"] == 45 and not releases and not trajectory and not complete
            assert post["holding"]["holding"] and post["road"]["onRoad"]
            places.append({"round": 45, "action": action, "held_object_id": identity,
                "success": False, "reason": row["result"]["reason"], "source_observation": source["observation_index"],
                "green_bboxes": [d["bbox"] for d in greens], "complete_green_count": 0,
                "release_count": 0, "motion_count": 0, "still_holding": True, "onRoad": True,
                "final_observation": evidence["final_observation"], "road_return": evidence["road_return"]})
            continue
        assert len(releases) == 1 and aim["source_region"] in complete
        areas = sorted([d["bbox"]["w"] * d["bbox"]["h"] for d in complete], reverse=True)
        assert len(areas) == 1 or areas[0] > areas[1]
        u, v = aim["pixel"]["u"], aim["pixel"]["v"]
        assert all(not (b["x"] - b["w"] / 2 <= u <= b["x"] + 1.5 * b["w"]
                       and b["y"] - b["h"] / 2 <= v <= b["y"] + 1.5 * b["h"])
                   for b in aim["occupied_boxes"])
        release = releases[0]; before = obs[release["before_observation"]]; after = obs[release["after_observation"]]
        assert before["holding"]["holding"] and not after["holding"]["holding"] and not post["holding"]["holding"]
        excluded = evidence["release_observation"]["preexisting_ball_ids"]
        assert excluded == sorted(o["id"] for o in before["objects"] if o["category"] == "red-ball" and o["id"] != identity)
        assert str(evidence["release_observation"]["frame_id"]) == str(after["observation"]["frameId"])
        backward = by_pair[(release["after_observation"], evidence["post_observation"])]
        assert backward["method"] == "backward" and backward["params"]["distanceCm"] == 25
        assert abs(post["odometry"]["distanceCm"] - after["odometry"]["distanceCm"] - 25) < 1e-8
        candidates, red_rows = [], []
        for ball in post["perception"]["detections"]:
            if ball["category"] != "red-ball":
                continue
            old = bool(ball.get("known_delivered_object_id")) or ball.get("track_id") in excluded
            zones = [{"bbox": zone["bbox"], "q": pixel_q(ball["bbox"], zone["bbox"]),
                      "complete": full_region(zone["bbox"])}
                     for zone in post["perception"]["detections"] if zone["category"] == "storage-zone"]
            for zone in zones:
                if "position_m" in ball and not old and zone["complete"] and zone["q"] <= .64:
                    candidates.append((ball, zone))
            red_rows.append({"bbox": ball["bbox"], "frame_id": ball["frame_id"], "track_id": ball.get("track_id"),
                "known_delivered_object_id": ball.get("known_delivered_object_id"),
                "excluded_as_preexisting": old, "zone_checks": zones})
        assert len(candidates) == evidence["candidate_witnesses"] == 1
        ball, zone = candidates[0]
        assert ball["bbox"] == evidence["placement"]["ball_bbox"] and zone["bbox"] == evidence["placement"]["storage_bbox"]
        assert str(evidence["placement"]["frame_id"]) == str(post["observation"]["frameId"])
        assert evidence["road_return"]["reason"] == "already_on_observed_road"
        assert evidence["road_return"]["motions"] == [] and post["road"]["onRoad"]
        assert next(o for o in final["objects"] if o["id"] == identity)["state"] == "DELIVERED"
        places.append({"round": row["round"], "action": action, "held_object_id": identity, "success": True,
            "source_observation": source["observation_index"], "release_aim": aim,
            "source_complete_green_areas_px2": areas, "aim_pixel_outside_all_expanded_occupied_boxes": True,
            "release_motion": release, "holding_before_release": True, "holding_after_release": False,
            "reobservation_index": evidence["post_observation"], "backward_cm": 25,
            "preexisting_ball_ids_exact": excluded, "post_red_detections": red_rows,
            "unique_witness_count": 1, "unique_witness_q": zone["q"], "pixel_threshold": .64,
            "road_return": evidence["road_return"], "post_onRoad": True,
            "final_observation": evidence["final_observation"], "final_state": "DELIVERED",
            "trajectory_checked_against_original_motions": detailed_trajectory})

    assert [p["round"] for p in picks] == [25, 97]
    assert [p["round"] for p in places] == [45, 53, 99]
    last = observations[-1]
    final_targets = [{k: o.get(k) for k in ("id", "state", "ever_confirmed")}
                     for o in last["objects"] if o["id"] in {"target_021", "target_112"}]
    assert len(final_targets) == 2 and all(o["state"] == "DELIVERED" for o in final_targets)
    assert not last["holding"]["holding"] and last["road"]["onRoad"]
    for spec in manifest["inputs"].values():
        prefix_bytes(spec)  # Growth is allowed; rewriting any reviewed byte is not.
    result = {"schema": "run21-public-grasp-prefix-review/v1", "allPass": True,
        "scope": {"rounds": 100, "observations": 664, "motions": 464}, "prefixes_unchanged": True,
        "source_prefixes": manifest["inputs"], "picks": picks, "places": places,
        "final_public_state": {"observation_index": 664, "holding": False, "onRoad": True, "targets": final_targets},
        "truth_record_layout_inputs": False, "simulation_or_network_calls": 0,
        "physical_task_acceptance": False,
        "interpretation": "All recorded public manipulation witnesses recompute; this does not identify physical objects from truth, validate whole-task completion, or change any active-run evidence."}
    (HERE / "checks.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"allPass": True, "rounds": 100, "observations": 664, "motions": 464,
        "pick_rounds": [25, 97], "place_rounds": [45, 53, 99], "unique_release_pixel_q": [
            p["unique_witness_q"] for p in places if p["success"]], "physical_task_acceptance": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
