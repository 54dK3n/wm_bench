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
                        held_object_id=None, pending_grasp=None, nodes=0, unexplored=0,
                        exploration=None, observed_detections=None, discovery_evidence=None):
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
    discovery_unresolved, visible_ambiguities, untracked_ids, unexplained_current = [], [], [], []
    explained_archives = {}
    # A never-confirmed archive can acquire a separately confirmed successor
    # through the discovery ledger; its original records remain immutable.
    if isinstance(discovery_evidence, dict) and discovery_evidence.get("schema") == "brain-discovery-evidence/v2":
        records = discovery_evidence.get("records", [])
        resolutions = {r.get("discovery_id"): r for r in discovery_evidence.get("resolutions", [])
                       if isinstance(r, dict)}
        for old in result["retired_unconfirmed_hypotheses"]:
            sources = [r for r in records if r.get("initial_object_id") == old["object_id"]]
            proofs = [resolutions.get(r.get("id")) for r in sources]
            targets = {p.get("canonical_object_id") for p in proofs if isinstance(p, dict)}
            if (sources and len(targets) == 1 and all(isinstance(p, dict)
                    and p.get("previous_object_id") == old["object_id"]
                    and p.get("rule") == "independent_views_original_pixels_unique_identity/v1"
                    and len(p.get("support_refs", [])) >= 2
                    and p.get("motion_boundaries") == [] for p in proofs)):
                target = next(iter(targets))
                if target in rows and root(target) in delivered:
                    explained_archives[old["object_id"]] = target
    if task_spec["quantity_mode"] == "known":
        if len(delivered) < required:
            unmet.append("required_delivery_count_not_met")
    else:
        if (not isinstance(discovery_evidence, dict)
                or discovery_evidence.get("schema") not in {"brain-discovery-evidence/v1", "brain-discovery-evidence/v2"}
                or not isinstance(discovery_evidence.get("unresolved"), list)):
            unmet.append("untracked_discovery_evidence_missing")
        elif discovery_evidence["unresolved"]:
            untracked_ids = [item.get("id") if isinstance(item, dict) else None
                             for item in discovery_evidence["unresolved"]]
            unmet.append("untracked_target_discoveries_unresolved")
        if result["pending_objects"]:
            unmet.append("observed_targets_pending")
        discovery_unresolved = sorted({item["object_id"] for item in
            result["retired_unconfirmed_hypotheses"] if root(item["object_id"]) not in delivered
            and item["object_id"] not in explained_archives})
        if discovery_unresolved:
            unmet.append("unconfirmed_discoveries_unresolved")
        if not isinstance(observed_detections, list) or any(
                not isinstance(item, dict) for item in observed_detections):
            unmet.append("current_target_observation_missing")
        else:
            visible_ambiguities = [{"frame_id": item.get("frame_id"),
                "track_id": item.get("track_id"),
                "candidate_ids": copy.deepcopy(item["identity_ambiguity"].get("candidate_ids", []))}
                for item in observed_detections if item.get("category") == task_spec["target_category"]
                and isinstance(item.get("identity_ambiguity"), dict) and item["identity_ambiguity"]]
            if visible_ambiguities:
                unmet.append("current_target_identity_ambiguity")
            unexplained_current = [{"frame_id": item.get("frame_id"), "bbox": copy.deepcopy(item.get("bbox")),
                "discovery_id": item.get("discovery_id"), "track_id": item.get("track_id")}
                for item in observed_detections if item.get("category") == task_spec["target_category"]
                and (not isinstance(item.get("track_id"), str) or root(item["track_id"]) not in rows
                     or item.get("identity_ambiguity"))]
            if unexplained_current:
                unmet.append("current_target_discovery_unexplained")
        states = (exploration or {}).get("state_counts") if isinstance(exploration, dict) else None
        count_keys = ("pending_exit_count", "unresolved_node_count", "unresolved_connection_count")
        valid_exploration = (isinstance(exploration, dict)
            and exploration.get("schema") == "brain-road-exploration/v1"
            and exploration.get("complete") is True and isinstance(states, dict)
            and set(states) == {"unexplored", "exploring", "verified", "blocked", "unresolved"}
            and all(type(value) is int and value >= 0 for value in states.values())
            and all(type(exploration.get(key)) is int and exploration[key] == 0 for key in count_keys)
            and sum(value for key, value in states.items() if key != "verified") == 0)
        if not nodes or unexplored or not valid_exploration:
            unmet.append("road_exploration_incomplete")
    result.update(task_spec=copy.deepcopy(task_spec), required_count=required,
                  delivered_count=len(delivered),
                  delivered_object_ids=sorted(d["object_id"] for d in delivered.values()),
                  delivery_evidence=list(delivered.values()),
                  unresolved_identity_ids=sorted(ambiguous | invalid),
                  unresolved_discovery_ids=discovery_unresolved,
                  untracked_discovery_ids=untracked_ids,
                  current_target_ambiguities=visible_ambiguities,
                  current_unexplained_discoveries=unexplained_current,
                  resolved_discovery_hypotheses=explained_archives,
                  exploration=copy.deepcopy(exploration),
                  ready_for_done=not unmet, unmet_conditions=unmet,
                  unexplored_exits=unexplored)
    return result
