"""Odometry breadcrumbs and junction observations; no preloaded road graph."""
from __future__ import annotations

import heapq
import math

VERSION = "autonomous-brain-navigation/v2"


def wrap(angle):
    return (angle + 180) % 360 - 180


def position(odo):
    return (odo["rightCm"] / 100, odo["forwardCm"] / 100)


def distance(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def heading_to(a, b):
    # Public odometry/turn: positive left; x right, z forward.
    return -math.degrees(math.atan2(b[0] - a[0], b[1] - a[1]))


class RoadMemory:
    def __init__(self):
        self.nodes = []
        self.vertices = []
        self.edges = {}
        self.last_vertex = None
        self.last_position = None
        self.blocked = []
        self.active_exit = None

    def update(self, odo, road):
        p = position(odo)
        if self.active_exit:
            previous = self.active_exit["last_position"]
            if distance(p, previous) > 1e-6:
                # Keep the final observed movement direction through stationary
                # observations/turns, including when both endpoints are nodes.
                self.active_exit["reverse_heading"] = heading_to(p, previous)
                self.active_exit["last_position"] = p
        if road["onRoad"]:
            choices = [(distance(p, vertex), i) for i, vertex in enumerate(self.vertices)]
            closest = min(choices, default=(math.inf, None))
            if closest[0] < 0.08:
                current = closest[1]
            else:
                current = len(self.vertices)
                self.vertices.append(p)
                self.edges[current] = {}
            if self.last_vertex is not None and current != self.last_vertex:
                gap = distance(self.vertices[current], self.vertices[self.last_vertex])
                # Edges encode only an actually traversed consecutive segment.
                if self.last_position is not None and distance(p, self.last_position) <= 0.60:
                    self.edges[current][self.last_vertex] = gap
                    self.edges[self.last_vertex][current] = gap
            self.last_vertex = current
        else:
            self.last_vertex = None
        self.last_position = p
        if road.get("atNode") and road["exits"]:
            node = min(self.nodes, key=lambda n: distance(p, n["position"]), default=None)
            if node is None or distance(p, node["position"]) >= 0.15:
                node = {"id": f"junction-{len(self.nodes)+1}", "position": p, "exits": []}
                self.nodes.append(node)
            for raw in road["exits"]:
                heading = wrap(odo["headingDeg"] + raw["angleDeg"])
                if not any(abs(wrap(e["heading_deg"] - heading)) < 15 for e in node["exits"]):
                    node["exits"].append({"heading_deg": heading, "visits": 0, "completed": False, "blocked": False})
            if self.active_exit:
                origin = self.active_exit["node"]
                # A sensor step can cross the whole segment without observing
                # atNode=False. Distinct odometry positions establish arrival.
                if distance(node["position"], origin["position"]) >= 0.15:
                    self.active_exit["exit"]["completed"] = True
                    # The reverse exit was traversed too; its bearing comes
                    # from the actual final odometry segment, not a map ID.
                    reverse = self.active_exit["reverse_heading"]
                    if reverse is not None:
                        candidate = min(node["exits"], key=lambda e: abs(wrap(e["heading_deg"] - reverse)))
                        if abs(wrap(candidate["heading_deg"] - reverse)) < 45:
                            candidate["completed"] = True
                    self.active_exit = None
                elif self.active_exit["departed"]:
                    self.active_exit = None
        elif self.active_exit:
            self.active_exit["departed"] = True

    def current_node(self, odo):
        p = position(odo)
        return next((n for n in self.nodes if distance(p, n["position"]) < 0.15), None)

    def exits(self, odo, road):
        node = self.current_node(odo)
        result = []
        for raw in road.get("exits", []):
            heading = wrap(odo["headingDeg"] + raw["angleDeg"])
            saved = next((e for e in (node or {}).get("exits", [])
                          if abs(wrap(e["heading_deg"] - heading)) < 15), None)
            result.append({"angle_deg": raw["angleDeg"], "heading_deg": heading,
                           "visits": saved["visits"] if saved else 0,
                           "completed": saved["completed"] if saved else False,
                           "blocked": saved["blocked"] if saved else False})
        return result

    def chosen(self, odo, angle, blocked=False):
        node = self.current_node(odo)
        if not node:
            return
        heading = wrap(odo["headingDeg"] + angle)
        for exit in node["exits"]:
            if abs(wrap(exit["heading_deg"] - heading)) < 15:
                exit["visits"] += 1
                exit["blocked"] |= blocked
                self.active_exit = {"node": node, "exit": exit, "departed": False,
                                    "last_position": position(odo), "reverse_heading": None}

    def mark_blocked(self):
        if self.active_exit:
            self.active_exit["exit"]["blocked"] = True
            self.active_exit = None

    def route_to(self, odo, target):
        """Shortest recorded path to the visited road point nearest target."""
        if not self.vertices:
            return []
        start = min(range(len(self.vertices)), key=lambda i: distance(position(odo), self.vertices[i]))
        goal = min(range(len(self.vertices)), key=lambda i: distance(target, self.vertices[i]))
        costs, previous, queue = {start: 0}, {}, [(0, start)]
        while queue:
            cost, node = heapq.heappop(queue)
            if cost != costs[node]:
                continue
            if node == goal:
                path = [node]
                while node != start:
                    node = previous[node]
                    path.append(node)
                return [self.vertices[i] for i in reversed(path)]
            for other, length in self.edges[node].items():
                if cost + length < costs.get(other, math.inf):
                    costs[other] = cost + length
                    previous[other] = node
                    heapq.heappush(queue, (cost + length, other))
        return []

    def summary(self):
        return [{"id": n["id"], "position_m": {"x": round(n["position"][0], 3), "z": round(n["position"][1], 3)},
                 "exits": [dict(e, heading_deg=round(e["heading_deg"], 1)) for e in n["exits"]]}
                for n in self.nodes]

    def unexplored(self):
        return sum(not e["completed"] and not e["blocked"] for n in self.nodes for e in n["exits"])
