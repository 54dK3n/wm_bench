"""Instruction-derived task scope and conservative observation ledger counting."""
from __future__ import annotations

import copy
import json
import re


def parse_task(instruction):
    """Recognize the supported delivery task; never infer quantities from sensors."""
    if not isinstance(instruction, str) or not instruction.strip():
        raise ValueError("a natural-language delivery instruction is required")
    text = instruction.strip()
    if "红球" not in text or not any(word in text for word in ("存放区", "储存区")):
        raise ValueError("unsupported task: specify red balls and their storage destination")
    match = re.search(r"([0-9]+|[零一二两三四五六七八九十]+)\s*[个颗只]?\s*红球", text)
    count = None
    if match:
        number = match.group(1)
        chinese = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
                   "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
        count = int(number) if number.isascii() and number.isdigit() else chinese.get(number)
        if count is None or count < 1:
            raise ValueError("unsupported or nonpositive requested quantity")
    # Quantity-free requests retain the unknown-quantity exploration obligation.
    return {"version": "instruction-task/v1", "source_instruction": text,
            "quantity_mode": "known" if count is not None else "unknown",
            "required_count": count, "target_category": "red-ball",
            "destination_category": "storage-zone"}


def completion_progress(objects, action_evidence, task_spec, *, holding,
                        held_object_id=None, pending_grasp=None, nodes=0, unexplored=0):
    """Count validated physical deliveries, not labels, events, or actuator replies.

    Perception owns the pixel/identity validation at transition time. This query
    requires that observation-backed ledger and folds its alias/reacquisition
    identities before counting. It never changes tracking or historical geometry.
    """
    from .actions import completion_evidence, reacquisition_chains

    result = completion_evidence(objects)
    rows = {row["id"]: row for row in objects}
    parents = {oid: oid for oid in rows}

    def root(oid):
        parents.setdefault(oid, oid)
        while parents[oid] != oid:
            oid = parents[oid]
        return oid

    def bind(a, b):
        if isinstance(a, str) and isinstance(b, str):
            parents[root(a)] = root(b)

    chains = reacquisition_chains(objects)
    ambiguous = set()
    for row in objects:
        if row.get("alias_of"):
            bind(row["id"], row["alias_of"])
        if row["id"] in chains:
            bind(row["id"], chains[row["id"]]["terminal"]["id"])
        elif row.get("reacquisition_binding"):
            ambiguous.add(row["id"])
    for event in action_evidence:
        alias = event.get("delivery_alias")
        if isinstance(alias, dict):
            bind(alias.get("witness_id"), event.get("object_id"))
        if event.get("action") == "release_recovery" and event.get("outside_storage") is True:
            bind(event.get("object_id"), event.get("recovered_object_id"))

    picks, delivered, witnesses = {}, {}, {}
    invalid = set()
    for event in action_evidence:
        oid = event.get("object_id")
        if oid not in rows or rows[oid].get("category") != task_spec["target_category"]:
            continue
        canonical = root(oid)
        basis = event.get("evidence") or {}
        if (event.get("action") == "pick" and event.get("holding") is True
                and event.get("original_position_absent") is True
                and basis.get("holding") is True
                and any(basis.get(k) is not None for k in ("post_observation", "after_observation"))):
            picks[canonical] = event
        if event.get("action") != "place" or rows[oid].get("state") != "DELIVERED":
            continue
        placement, release = basis.get("placement"), basis.get("release_observation")
        valid = (canonical in picks and event.get("holding") is False
                 and event.get("ball_in_storage") is True and basis.get("holding") is False
                 and basis.get("candidate_witnesses") == 1
                 and isinstance(placement, dict) and isinstance(release, dict)
                 and placement.get("frame_id") is not None and release.get("frame_id") is not None
                 and placement.get("ball_category") == task_spec["target_category"]
                 and isinstance(placement.get("ball_bbox"), dict)
                 and isinstance(placement.get("storage_bbox"), dict)
                 and isinstance(release.get("preexisting_ball_ids"), list))
        if not valid:
            invalid.add(oid)
            continue
        # One observed ball cannot discharge two distinct identities, even if
        # the same delivered row/event is duplicated by a caller or export.
        witness = json.dumps([placement["frame_id"], placement["ball_bbox"]], sort_keys=True)
        if witness in witnesses and witnesses[witness] != canonical:
            ambiguous.update((oid, delivered[witnesses[witness]]["object_id"]))
        witnesses[witness] = canonical
        delivered[canonical] = {"object_id": oid, "frame_id": placement["frame_id"],
                                "release_frame_id": release["frame_id"],
                                "simulation_time_s": event.get("simulation_time_s")}
    for row in objects:
        if row.get("category") == task_spec["target_category"]:
            if row.get("state") == "DELIVERED" and root(row["id"]) not in delivered:
                invalid.add(row["id"])
            if row.get("state") in {"HELD", "RELEASED_UNVERIFIED"}:
                ambiguous.add(row["id"])
            if (row.get("state") == "LOST" and row.get("ever_confirmed") is True
                    and row["id"] not in chains and root(row["id"]) not in delivered):
                ambiguous.add(row["id"])
    recovered_deliveries = [oid for oid in result["pending_objects"]
                           if rows[oid].get("state") == "LOST" and root(oid) in delivered]
    result["pending_objects"] = [oid for oid in result["pending_objects"] if oid not in recovered_deliveries]
    result["resolved_release_recovery_identities"] = recovered_deliveries
    unmet = []
    if holding is not False or held_object_id is not None or pending_grasp is not None:
        unmet.append("gripper_or_grasp_not_resolved")
    if ambiguous or invalid:
        unmet.append("delivery_identity_or_evidence_unresolved")
    required = task_spec["required_count"]
    if task_spec["quantity_mode"] == "known":
        if len(delivered) < required:
            unmet.append("required_delivery_count_not_met")
    else:
        if result["pending_objects"]:
            unmet.append("observed_targets_pending")
        if not nodes or unexplored:
            unmet.append("road_exploration_incomplete")
    result.update(task_spec=copy.deepcopy(task_spec), required_count=required,
                  delivered_count=len(delivered),
                  delivered_object_ids=sorted(d["object_id"] for d in delivered.values()),
                  delivery_evidence=list(delivered.values()),
                  unresolved_identity_ids=sorted(ambiguous | invalid),
                  ready_for_done=not unmet, unmet_conditions=unmet,
                  unexplored_exits=unexplored)
    return result
