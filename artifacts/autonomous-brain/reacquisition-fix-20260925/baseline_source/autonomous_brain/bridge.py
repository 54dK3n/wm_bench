"""Limited HTTP capability; no page controller or evaluation API is accepted."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

METHODS = frozenset({"observe", "camera_parameters", "odometry", "local_road",
                     "holding", "grab", "release", "forward", "backward",
                     "turn", "follow_road", "take_exit"})
VERSION = "autonomous-brain-bridge/v1"


class BridgeError(RuntimeError):
    pass


class SimulationLimit(RuntimeError):
    pass


class JsonLog:
    def __init__(self, path: Path):
        self.file = Path(path).open("x", encoding="utf-8")

    def write(self, value):
        self.file.write(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n")
        self.file.flush()

    def close(self):
        self.file.close()


class RobotBridge:
    def __init__(self, config, log_path: Path):
        self.origin = config["origin"].rstrip("/")
        url = urllib.parse.urlsplit(self.origin)
        if url.scheme != "http" or url.hostname not in {"localhost", "127.0.0.1", "::1"} or url.path:
            raise ValueError("Only a local robot bridge origin is allowed")
        self.bridge_id = config.get("bridge_id", config.get("bridgeId"))
        self.token = config.get("client_token", config.get("clientToken"))
        if not self.bridge_id or not self.token:
            raise ValueError("Limited bridge capability is missing")
        self.route = "/api/v1/robot-bridge/" + urllib.parse.quote(self.bridge_id, safe="") + "/commands"
        self.sequence = 0
        self.log = JsonLog(log_path)
        self.step_ms = config.get("simulation_step_ms", config.get("stepMs", 20))
        self.max_seconds = min(1200, config.get("max_simulation_seconds", 1200))
        self.tick = 0

    @property
    def seconds(self):
        return self.tick * self.step_ms / 1000

    def _http(self, route, body=None):
        request = urllib.request.Request(self.origin + route,
            data=None if body is None else json.dumps(body, allow_nan=False).encode(),
            headers={"X-Robot-Bridge-Client": self.token, "Content-Type": "application/json"},
            method="GET" if body is None else "POST")
        # This client has no cookies, controller token, layout, or page access.
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.load(exc)

    def call(self, method, params=None):
        if method not in METHODS:
            raise BridgeError(f"METHOD_NOT_ALLOWED: {method}")
        if self.seconds >= self.max_seconds and method not in {"odometry", "holding", "local_road", "observe"}:
            raise SimulationLimit("simulation_time_limit")
        self.sequence += 1
        request = {"requestId": f"brain-{self.sequence:06d}", "method": method, "params": params or {}}
        entry = {"request": request, "submission": None, "terminal": None}
        try:
            status, result = self._http(self.route, request)
            entry["submission"] = {"status": status, "body": result}
            if status not in (200, 202):
                raise BridgeError(f"{method}: {result.get('error', {}).get('code', status)}")
            deadline = time.monotonic() + 120
            while result.get("status") in {"queued", "dispatched"}:
                if time.monotonic() > deadline:
                    raise BridgeError(f"{method}: unresolved action; stop without resubmitting")
                time.sleep(0.02)
                status, result = self._http(self.route + "/" + request["requestId"])
                if status != 200:
                    raise BridgeError(f"{method}: status query failed ({status})")
            entry["terminal"] = result
            if result.get("status") != "completed":
                raise BridgeError(f"{method}: {result.get('error', {}).get('code', result.get('status'))}")
            value = result["result"]
            if "tick" in value:
                if value["tick"] < self.tick:
                    raise BridgeError("simulation tick moved backwards")
                self.tick = value["tick"]
            return value
        except Exception as exc:
            entry["error"] = str(exc)
            raise
        finally:
            self.log.write(entry)
