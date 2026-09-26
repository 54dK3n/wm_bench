"""Sensor-supported junction identity and directed exploration obligations.

This ledger owns semantic identities. Geometry is a consistency check, never a
connection: only registered motion windows connect anchors. It deliberately
retains ambiguous observations and alias/merge evidence for independent audit.
"""
from __future__ import annotations

import copy
import math


def wrap(a):
    return (a + 180) % 360 - 180


def finite(x):
    return type(x) in (int, float) and math.isfinite(x)


def point(frame):
    o = frame["odometry"]
    return [o["rightCm"] / 100, o["forwardCm"] / 100]


def structure(a, b):
    return (len(a) == len(b)
        and all(sum(abs(wrap(x - y)) <= 5 for y in b) == 1 for x in a)
        and all(sum(abs(wrap(x - y)) <= 5 for x in a) == 1 for y in b))


class RoadEvidence:
    STATES = ("unexplored", "exploring", "verified", "blocked", "unresolved")

    def __init__(self):
        self.nodes, self.anchors, self.exits = {}, {}, {}
        self.frames, self.motions, self.trips = {}, {}, {}
        self.unresolved = []
        self.latest = None
        self.chain = 0
        self.anchor_chains = {}
        self.active_exit_id = None
        self.last_failed_exit_id = None
        self.active_departure_index = None
        self.nonroad_excursion = None

    def problem(self, kind, reason, indices, **fields):
        entry = {"kind": kind, "reason": reason, "observation_indices": list(indices),
                 "resolved": False, "exit_id": self.active_exit_id, **fields}
        if not any(all(old.get(k) == v for k, v in entry.items()) for old in self.unresolved):
            entry["id"] = f"road-unresolved-{len(self.unresolved) + 1}"
            self.unresolved.append(entry)

    def register(self, frame):
        i, road, odo = frame["observation_index"], frame["road"], frame["odometry"]
        if road.get("atNode") is not True or i in self.anchors:
            return
        ident = f"junction-{len(self.nodes) + 1}"
        valid = all(finite(odo.get(k)) for k in ("rightCm", "forwardCm", "headingDeg", "distanceCm", "tick"))
        angles = [e.get("angleDeg") for e in road.get("exits", [])]
        valid = valid and all(finite(a) for a in angles) and road.get("onRoad") is True
        geometric = all(finite(odo.get(k)) for k in ("rightCm", "forwardCm", "headingDeg"))
        headings = [wrap(odo["headingDeg"] + a) for a in angles] if geometric and all(finite(a) for a in angles) else []
        self.nodes[ident] = {"id": ident, "canonical_id": ident, "status": "unresolved",
            "anchor_indices": [i], "merge_evidence_refs": [],
            "position_m": point(frame) if geometric else None}
        self.anchors[i] = {"observation_index": i, "node_id": ident, "candidate_ids": [],
            "position_m": point(frame) if geometric else None,
            "heading_deg": odo.get("headingDeg"), "tick": odo.get("tick"),
            "odometer_cm": odo.get("distanceCm"), "fresh_relative_exits_deg": angles,
            "fresh_headings_deg": headings, "exit_bindings": [], "valid": valid}
        self._bind_exits(self.anchors[i])

    @staticmethod
    def sensor_valid(frame):
        o, s = frame.get("odometry", {}), frame.get("observation", {})
        return (all(finite(o.get(k)) for k in ("rightCm", "forwardCm", "headingDeg", "distanceCm", "tick"))
            and s.get("frameId") is not None and s.get("tick") == o["tick"]
            and frame.get("road", {}).get("tick", o["tick"]) == o["tick"]
            and frame.get("road", {}).get("onRoad") is True)

    @classmethod
    def step_valid(cls, a, b, motion):
        if (b["observation_index"] != a["observation_index"] + 1
                or not cls.sensor_valid(a) or not cls.sensor_valid(b)
                or str(a["observation"]["frameId"]) == str(b["observation"]["frameId"])):
            return False
        x, y = a["odometry"], b["odometry"]
        travel = y["distanceCm"] - x["distanceCm"]
        if travel < 0 or y["tick"] < x["tick"] or math.dist(point(a), point(b)) * 100 > travel + .2:
            return False
        if motion is None:
            return all(x[k] == y[k] for k in ("rightCm", "forwardCm", "headingDeg", "distanceCm", "tick"))
        m, r = motion.get("method"), motion.get("actuator_result", {})
        if (motion.get("before_observation") != a["observation_index"]
                or motion.get("after_observation") != b["observation_index"]
                or m not in {"take_exit", "follow_road", "forward", "backward", "turn"}
                or not isinstance(r, dict) or r.get("error") or r.get("accepted") is False
                or r.get("stoppedBy") in {"collision", "front_clearance", "off_road", "wrong_way"}
                or (r.get("completed") is not True if m in {"forward", "backward", "turn"}
                    else r.get("accepted") is not True)):
            return False
        if m == "turn":
            angle = motion.get("params", {}).get("angleDeg")
            return (finite(angle) and y["tick"] > x["tick"]
                    and abs(wrap(y["headingDeg"] - x["headingDeg"] - angle)) <= .2
                    and math.dist(point(a), point(b)) * 100 <= .2)
        if travel < .1 or y["tick"] <= x["tick"]:
            return False
        if m in {"forward", "backward"}:
            request = motion.get("params", {}).get("distanceCm")
            theta = math.radians(x["headingDeg"])
            dx, dz = y["rightCm"] - x["rightCm"], y["forwardCm"] - x["forwardCm"]
            along = (-math.sin(theta) * dx + math.cos(theta) * dz) * (1 if m == "forward" else -1)
            return (finite(request) and abs(along - request) <= .2
                    and abs(math.cos(theta) * dx + math.sin(theta) * dz) <= .2
                    and abs(wrap(y["headingDeg"] - x["headingDeg"])) <= .2)
        return True

    def canonical(self, ident):
        return self.nodes[ident]["canonical_id"]

    def _bind_exits(self, anchor):
        node = anchor["node_id"]
        anchor["exit_bindings"] = []
        for raw, h in zip(anchor["fresh_relative_exits_deg"], anchor["fresh_headings_deg"]):
            matches = [e for e in self.exits.values() if e["node_id"] == node
                       and abs(wrap(e["heading_deg"] - h)) <= 5]
            if len(matches) == 1:
                e = matches[0]
            else:
                ident = f"{node}-exit-{1 + sum(e['node_id'] == node for e in self.exits.values())}"
                e = {"id": ident, "node_id": node, "heading_deg": h,
                    "state": "unexplored" if not matches and self.nodes[node]["status"] == "confirmed" else "unresolved", "visits": 0,
                    "observation_refs": [], "completion_traversal_ids": []}
                self.exits[ident] = e
            if (e["state"] == "unresolved" and "last_failure" not in e
                    and self.nodes[node]["status"] == "confirmed"):
                e["state"] = "unexplored"
            if anchor["observation_index"] not in e["observation_refs"]:
                e["observation_refs"].append(anchor["observation_index"])
            anchor["exit_bindings"].append({"exit_id": e["id"], "raw_angle_deg": raw})

    def _merge(self, anchor, old, kind, first, last, traversal_ids=()):
        provisional, canonical = anchor["node_id"], self.canonical(old["node_id"])
        ref = {"kind": kind, "from_observation": old["observation_index"],
            "to_observation": anchor["observation_index"], "first_observation": first,
            "last_observation": last, "motion_refs": [
                {"before_observation": a, "after_observation": b} for a, b in self.motions
                if first <= a < b <= last], "traversal_ids": list(traversal_ids)}
        self.nodes[provisional].update(canonical_id=canonical, status="alias", merge_evidence_refs=[ref])
        self.nodes[canonical]["anchor_indices"].append(anchor["observation_index"])
        self.nodes[canonical]["merge_evidence_refs"].append(ref)
        for eid in [eid for eid, e in self.exits.items() if e["node_id"] == provisional]:
            del self.exits[eid]
        anchor["node_id"] = canonical

    @classmethod
    def manipulation_step_valid(cls, before, after, motion):
        """Validate a physical excursion without treating it as road travel."""
        a, b = copy.deepcopy(before), copy.deepcopy(after)
        a["road"]["onRoad"] = b["road"]["onRoad"] = True
        if motion is None or motion.get("method") in {"forward", "backward", "turn"}:
            return cls.step_valid(a, b, motion)
        # Gripper commands do not prove translation; fresh stationary odometry
        # may bridge their sensor interval in an otherwise observed excursion.
        return (motion.get("method") in {"grab", "release"} and cls.sensor_valid(a) and cls.sensor_valid(b)
            and b["observation_index"] == a["observation_index"] + 1
            and str(a["observation"]["frameId"]) != str(b["observation"]["frameId"])
            and all(a["odometry"][k] == b["odometry"][k]
                    for k in ("rightCm", "forwardCm", "headingDeg", "distanceCm")))

    def observe(self, frame, motion=None):
        i = frame["observation_index"]
        if i in self.frames:
            if self.frames[i] != frame:
                self.problem("connection", "conflicting_observation_index", [i])
            return
        self.register(frame)
        previous = self.frames.get(self.latest)
        valid = self.sensor_valid(frame)
        contiguous = previous is not None and self.step_valid(previous, frame, motion)
        stationary_fresh = (previous is not None and valid and self.sensor_valid(previous)
            and i == previous["observation_index"] + 1
            and str(previous["observation"]["frameId"]) != str(frame["observation"]["frameId"])
            and frame["odometry"]["tick"] >= previous["odometry"]["tick"]
            and all(previous["odometry"][k] == frame["odometry"][k]
                    for k in ("rightCm", "forwardCm", "headingDeg", "distanceCm")))
        if previous is not None and not contiguous:
            # A stationary observation after grab/release may change holding;
            # neither operation supplies a road connection or identity merge.
            if not stationary_fresh:
                self.chain += 1
            a, b = previous["odometry"], frame["odometry"]
            if (not valid or any(a.get(k) != b.get(k) for k in
                    ("rightCm", "forwardCm", "headingDeg", "distanceCm"))
                    or b.get("tick", -1) < a.get("tick", 0)
                    or i != previous["observation_index"] + 1):
                self.problem("connection", "motion_or_sensor_continuity_unresolved", [self.latest, i])
        self.frames[i] = copy.deepcopy(frame)
        if motion is not None:
            self.motions[(motion.get("before_observation"), motion.get("after_observation"))] = copy.deepcopy(motion)
        restored_anchor, restored_first = None, None
        if previous is not None:
            basic = self.manipulation_step_valid(previous, frame, motion)
            if (self.nonroad_excursion is None and previous["road"].get("onRoad") is True
                    and frame["road"].get("onRoad") is False and basic):
                self.nonroad_excursion = {"start": previous["observation_index"],
                    "chain": self.anchor_chains.get(previous["observation_index"], self.chain - 1)}
            excursion = self.nonroad_excursion
            if excursion is not None:
                if not basic:
                    self.nonroad_excursion = None
                elif frame["road"].get("onRoad") is True:
                    origin = self.frames[excursion["start"]]
                    old_road, new_road = origin["road"], frame["road"]
                    old_h = [wrap(origin["odometry"]["headingDeg"] + e["angleDeg"]) for e in old_road.get("exits", [])]
                    new_h = [wrap(frame["odometry"]["headingDeg"] + e["angleDeg"]) for e in new_road.get("exits", [])]
                    if (math.dist(point(origin), point(frame)) * 100 <= .2
                            and abs(wrap(origin["odometry"]["headingDeg"] - frame["odometry"]["headingDeg"])) <= .2
                            and old_road.get("atNode") == new_road.get("atNode") and structure(old_h, new_h)):
                        proof = {"kind": "observed_nonroad_return", "first_observation": excursion["start"],
                            "last_observation": i, "motion_refs": [
                                {"before_observation": a, "after_observation": b} for a, b in self.motions
                                if excursion["start"] <= a < b <= i]}
                        for item in self.unresolved:
                            if (item["kind"] == "connection" and item["reason"] == "motion_or_sensor_continuity_unresolved"
                                    and item["observation_indices"]
                                    and min(item["observation_indices"]) >= excursion["start"]
                                    and max(item["observation_indices"]) <= i):
                                item.update(resolved=True, resolution=copy.deepcopy(proof))
                        restored_anchor = self.anchors.get(excursion["start"])
                        restored_first = excursion["start"]
                        self.chain = excursion["chain"]
                    self.nonroad_excursion = None
        anchor = self.anchors.get(i)
        if anchor is not None:
            anchor["valid"] = bool(anchor["valid"] and valid)
            candidate = None
            kind, first, evidence_trips = None, i, []
            if restored_anchor is not None:
                candidate, kind, first = restored_anchor, "observed_nonroad_return", restored_first
            previous_anchor = self.anchors.get(self.latest)
            if (candidate is None and anchor["valid"] and (contiguous or stationary_fresh) and previous_anchor is not None
                    and previous_anchor["valid"]
                    and structure(anchor["fresh_headings_deg"], previous_anchor["fresh_headings_deg"])):
                # Stationary views preserve identity. A translation between
                # identical node views cannot distinguish another stopping
                # point from an adjacent identical junction. Method names or
                # 'entered_road' cannot resolve that physical ambiguity.
                if anchor["position_m"] == previous_anchor["position_m"]:
                    candidate, kind, first = previous_anchor, "continuous_node_episode", self.latest
            prior = [a for j, a in self.anchors.items() if j < i and a["valid"]
                     and structure(a["fresh_headings_deg"], anchor["fresh_headings_deg"])]
            if candidate is None and anchor["valid"] and (contiguous or stationary_fresh):
                exact = [a for a in prior if a["position_m"] == anchor["position_m"]
                         and self.anchor_chains.get(a["observation_index"]) == self.chain]
                identities = {self.canonical(a["node_id"]) for a in exact}
                if len(identities) == 1:
                    candidate = max(exact, key=lambda a: a["observation_index"])
                    kind, first = "structural_revisit", candidate["observation_index"]
            if candidate is None and anchor["valid"] and contiguous and self.active_departure_index is not None:
                start = self.anchors.get(self.active_departure_index)
                supported = []
                for trip in self.trips.values():
                    old_start = self.anchors[trip["departure"]["observation_index"]]
                    old_end = self.anchors[trip["arrival"]["observation_index"]]
                    if start is None:
                        continue
                    old, expected_heading = None, None
                    if (trip["departure"]["exit_id"] == self.active_exit_id
                            and start["node_id"] == old_start["node_id"]):
                        old, expected_heading = old_end, old_end["heading_deg"]
                        departure_gap = math.dist(start["position_m"], old_start["position_m"]) * 100
                    elif start["node_id"] == old_end["node_id"] and self.active_exit_id is not None:
                        h = self.exits[self.active_exit_id]["heading_deg"]
                        if abs(wrap(h - old_end["heading_deg"] - 180)) <= 5:
                            old, expected_heading = old_start, wrap(self.exits[trip["departure"]["exit_id"]]["heading_deg"] + 180)
                            departure_gap = math.dist(start["position_m"], old_end["position_m"]) * 100
                    if old is None or not structure(old["fresh_headings_deg"], anchor["fresh_headings_deg"]):
                        continue
                    gap = math.dist(old["position_m"], anchor["position_m"])
                    travel = anchor["odometer_cm"] - start["odometer_cm"]
                    if (gap < .15 and abs(wrap(anchor["heading_deg"] - expected_heading)) <= 5
                            and abs(travel - trip["travelled_cm"]) <= departure_gap + gap * 100 + .2
                            and self.anchor_chains.get(start["observation_index"]) == self.chain):
                        supported.append((old, trip["id"]))
                if len({a["node_id"] for a, _ in supported}) == 1:
                    candidate = supported[0][0]
                    kind, first = "route_endpoint_revisit", self.active_departure_index
                    evidence_trips = [tid for _, tid in supported]
            if candidate is not None:
                self._merge(anchor, candidate, kind, first, i, evidence_trips)
            else:
                nearby = sorted({self.canonical(a["node_id"]) for a in prior
                    if anchor["position_m"] is not None
                    and math.dist(a["position_m"], anchor["position_m"]) < .15
                    and not (contiguous and self.anchor_chains.get(a["observation_index"]) == self.chain
                        and any(not f["road"].get("atNode") for j, f in self.frames.items()
                                if a["observation_index"] < j < i))})
                if (contiguous and previous_anchor is not None and previous_anchor["valid"]
                        and structure(previous_anchor["fresh_headings_deg"], anchor["fresh_headings_deg"])):
                    nearby = sorted(set(nearby) | {self.canonical(previous_anchor["node_id"])})
                anchor["candidate_ids"] = nearby
                self.nodes[anchor["node_id"]]["status"] = ("confirmed" if anchor["valid"]
                    and anchor["fresh_headings_deg"] and not nearby else "unresolved")
                if nearby or not anchor["valid"] or not anchor["fresh_headings_deg"]:
                    self.problem("node", "junction_identity_unresolved" if nearby else "junction_sensor_or_structure_unavailable",
                                 [i], node_id=anchor["node_id"], candidate_ids=nearby)
            self.anchor_chains[i] = self.chain
            self._bind_exits(anchor)
        self.latest = i

    def choose(self, observation_index, angle, blocked=False):
        anchor = self.anchors.get(observation_index)
        if anchor is None:
            return None
        matches = [b for b in anchor["exit_bindings"] if finite(angle)
                   and abs(wrap(b["raw_angle_deg"] - angle)) <= 5]
        if len(matches) != 1:
            return None
        e = self.exits[matches[0]["exit_id"]]
        e["visits"] += 1
        e["state"] = "blocked" if blocked else "exploring"
        self.active_exit_id = e["id"]
        self.last_failed_exit_id = None
        self.active_departure_index = observation_index
        return e["id"]

    def cancel(self, reason, blocked=False):
        ident = self.active_exit_id or (self.last_failed_exit_id if blocked else None)
        if ident is not None:
            e = self.exits[ident]
            self.last_failed_exit_id = ident
            e["state"] = "blocked" if blocked else "verified" if e["completion_traversal_ids"] else "unresolved"
            e["last_failure"] = reason
            self.active_exit_id = None
            self.active_departure_index = None

    def complete(self, trip):
        a, b = trip["departure"]["observation_index"], trip["arrival"]["observation_index"]
        start, end = self.anchors[a], self.anchors[b]
        matches = [e for e in start["exit_bindings"]
                   if abs(wrap(e["raw_angle_deg"] - trip["observed_departure_angle_deg"])) <= 5]
        if len(matches) != 1:
            return False
        eid = matches[0]["exit_id"]
        row = {"id": trip["trip_id"], "departure": {"observation_index": a, "node_id": start["node_id"],
                "exit_id": eid, "raw_angle": trip["motions"][0]["params"]["angleDeg"]},
            "arrival": {"observation_index": b, "node_id": end["node_id"]},
            "motion_refs": [{"before_observation": m["before_observation"],
                "after_observation": m["after_observation"]} for m in trip["motions"]],
            "first_observation": a, "last_observation": b,
            "observation_indices": list(range(a, b + 1)), "travelled_cm": trip["travelled_cm"]}
        self.trips[row["id"]] = row
        for node in self.nodes.values():
            for proof in node["merge_evidence_refs"]:
                if proof["kind"] == "structural_revisit" and proof["to_observation"] == b:
                    proof["traversal_ids"] = [t["id"] for t in self.trips.values()
                        if proof["first_observation"] <= t["first_observation"]
                        and t["last_observation"] <= proof["last_observation"]]
        e = self.exits[eid]
        e["completion_traversal_ids"].append(row["id"])
        e["state"] = "verified"
        for item in self.unresolved:
            if item.get("exit_id") == eid and item["kind"] == "connection":
                item.update(resolved=True, resolution_traversal_id=row["id"])
        if end["valid"] and not end["candidate_ids"] and not end["fresh_headings_deg"]:
            self.nodes[end["node_id"]]["status"] = "confirmed"
            for item in self.unresolved:
                if item.get("node_id") == end["node_id"]:
                    item.update(resolved=True, resolution_traversal_id=row["id"])
        self.active_exit_id = None
        self.active_departure_index = None
        self.last_failed_exit_id = None
        return True

    def node_views(self):
        return [{"id": n["id"], "position": tuple(n["position_m"] or (0, 0)), "status": n["status"],
            "exits": [{**copy.deepcopy(e), "completed": e["state"] == "verified",
                       "blocked": e["state"] == "blocked"} for e in self.exits.values() if e["node_id"] == n["id"]]}
            for n in self.nodes.values() if n["canonical_id"] == n["id"]]

    def evidence(self):
        return copy.deepcopy({"schema": "brain-road-evidence/v1", "nodes": list(self.nodes.values()),
            "anchors": list(self.anchors.values()), "exits": list(self.exits.values()),
            "traversals": list(self.trips.values()), "unresolved": self.unresolved})

    def status(self):
        counts = {state: sum(e["state"] == state for e in self.exits.values()) for state in self.STATES}
        nodes = sum(n["canonical_id"] == n["id"] and n["status"] == "unresolved" for n in self.nodes.values())
        connections = sum(r["kind"] == "connection" and not r["resolved"] for r in self.unresolved)
        pending = sum(counts[s] for s in self.STATES if s != "verified")
        return {"schema": "brain-road-exploration/v1", "complete": bool(self.nodes) and not (pending or nodes or connections),
            "pending_exit_count": pending, "state_counts": counts,
            "unresolved_node_count": nodes, "unresolved_connection_count": connections}
