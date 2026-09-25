"""One-action decisions, complete JSONL transcripts, and network-free replay.

Configuration follows octos: LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.  The
orchestrator is deliberately not imported.  Call ``decide(state)`` once per
observation round and execute its returned ``{action, params}`` elsewhere.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import time
from typing import Any
import urllib.error
import urllib.request


VERSION = "autonomous-brain-llm/v2"
SUPPORTED_TRANSCRIPT_VERSIONS = {"autonomous-brain-llm/v1", VERSION}
SYSTEM_PROMPT = """你在真实传感器约束下控制小车，每轮只决定一个动作。环境事实仅来自下面的状态 JSON；不能假定物体总数、布局或未观测信息。
只输出一个 JSON 对象，严格格式：{"action":"动作名","params":{}}，不加说明、代码块或额外字段。
动作：explore 的 params 为 {} 或 {"exit_angle":相对当前朝向的有限数字角度}；look_around、place、done 的 params 必须为 {}；go_to、pick 的 params 必须为 {"object_id":"物体表中的 id"}。
explore 沿路前进至下一路口或发现新物体；有出口时优先选择尚未探索的出口。look_around 分次转向并观测；仅原地看不能取得确认所需的不同观测位置，应结合 explore 换位置。go_to 沿自建道路到目标前 25–40cm。go_to 和 pick 只能选择当前状态为 CONFIRMED 的物体。pick 先观测对准再抓，最多三次；是否抓到依据夹爪和再次观测。place 按当前观测的绿色存放区对准放下，是否送达依据夹爪和球在区内的观测证据。
按任务选择物体；有持物时先寻找绿色存放区，确认后 go_to 再 place。继续探索未知路口和出口，不能因为暂时没看见目标就 done。只有没有未探索路段、所有已确认的任务目标都已送达且没有待确认目标时才 done。检查最近动作的结果；失败时利用观测改变动作，不要机械重复同一失败动作。未持物不能 place，持物不能 pick。
状态中的位置来自 WorldModel，出口角度相对小车当前朝向；最近动作至多五轮。不要访问平台真值或要求任何额外接口。"""


class ActionValidationError(ValueError):
    """A model output does not satisfy the one-action contract."""


class LLMOutputError(RuntimeError):
    """Both the initial completion and its single repair were invalid."""


class LLMRequestError(RuntimeError):
    """A request failed; the caller must stop rather than execute an action."""


class ReplayError(RuntimeError):
    """A replay is incomplete, corrupt or does not match the current input."""


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def _reject_constant(value: str) -> None:
    raise ValueError(f"Non-finite JSON number: {value}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def _strict_loads(text: str) -> Any:
    return json.loads(text, object_pairs_hook=_unique_object,
                      parse_constant=_reject_constant)


def _finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _partial_response_text(error: BaseException) -> str | None:
    partial = getattr(error, "partial", None)
    return bytes(partial).decode("utf-8", errors="replace") if isinstance(partial, (bytes, bytearray)) else None


def validate_action(action: Any, state: dict[str, Any]) -> dict[str, Any]:
    """Validate shape, finite angles, existing ids and CONFIRMED preconditions.

    Main-loop action guards still own physical preconditions and the final
    completion criterion.  No information outside this sensor-derived state
    is consulted here.
    """
    if not isinstance(action, dict) or set(action) != {"action", "params"}:
        raise ActionValidationError("Expected exactly action and params fields")
    name, params = action["action"], action["params"]
    if not isinstance(name, str) or name not in {
            "explore", "look_around", "go_to", "pick", "place", "done"}:
        raise ActionValidationError("Unknown action name")
    if not isinstance(params, dict):
        raise ActionValidationError("params must be an object")
    if name == "explore":
        if not set(params).issubset({"exit_angle"}):
            raise ActionValidationError("explore only accepts exit_angle")
        if "exit_angle" in params:
            angle = params["exit_angle"]
            if not _finite_number(angle):
                raise ActionValidationError("exit_angle must be a finite number")
    elif name in {"go_to", "pick"}:
        if set(params) != {"object_id"}:
            raise ActionValidationError(f"{name} requires only object_id")
        object_id = params["object_id"]
        if not isinstance(object_id, str) or not object_id.strip():
            raise ActionValidationError("object_id must be a non-empty string")
        matches = [obj for obj in state["objects"] if obj.get("id") == object_id]
        if len(matches) != 1:
            raise ActionValidationError("object_id must identify one current WorldModel object")
        if str(matches[0].get("status", "")).upper() != "CONFIRMED":
            raise ActionValidationError(f"{name} requires a CONFIRMED object")
    elif params:
        raise ActionValidationError(f"{name} accepts no parameters")
    return {"action": name, "params": dict(params)}


def _prepare_state(state: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(state, dict):
        raise ValueError("state must be an object")
    required = {"task", "objects", "robot", "junction_history", "recent_actions"}
    missing = sorted(required - set(state))
    if missing:
        raise ValueError(f"state missing fields: {', '.join(missing)}")
    if not isinstance(state["task"], str) or not state["task"].strip():
        raise ValueError("state.task must be a non-empty string")
    if (not isinstance(state["objects"], list)
            or not all(isinstance(obj, dict) for obj in state["objects"])):
        raise ValueError("state.objects must be a list of objects")
    if not isinstance(state["robot"], dict):
        raise ValueError("state.robot must be an object")
    if not isinstance(state["recent_actions"], list):
        raise ValueError("state.recent_actions must be a list")
    # Round-trip ensures a detached finite JSON snapshot before any request.
    prepared = dict(state)
    prepared["recent_actions"] = state["recent_actions"][-5:]
    return _strict_loads(_canonical(prepared))


class LLMClient:
    """Standard-library OpenAI-compatible client with strict transcript replay.

    ``log_path`` is a new JSONL file, opened exclusively to prevent accidental
    mixing of runs. ``replay_path`` selects a recorded transcript and never
    reads API credentials or makes requests. Replay may use a live transcript
    or another replay transcript. Compatible v1 transcripts retain their
    recorded version when replayed; the code version is independently tracked
    by the run's source SHA256. Inputs and re-derived output validation must
    match exactly. Call ``assert_replay_consumed`` at the end of a full replay.

    Only invalid model outputs get one repair request. Transport and HTTP
    errors stop immediately (including unsupported JSON-mode errors); there
    are no hidden retries or fallback model/temperature/format settings.
    """

    def __init__(self, log_path: str | Path, replay_path: str | Path | None = None,
                 timeout_s: float = 60, *, model: str | None = None) -> None:
        if not _finite_number(timeout_s) or timeout_s <= 0:
            raise ValueError("timeout_s must be positive and finite")
        self.timeout_s = timeout_s
        self.call_count = 0
        self.decision_count = 0
        self.total_elapsed_s = 0.0
        self.last_record: dict[str, Any] | None = None
        self._replay: list[dict[str, Any]] | None = None
        self._replay_cursor = 0
        self._closed = False
        self._terminal = False
        self._base_url = ""
        self._api_key = ""
        if replay_path is not None:
            if Path(log_path).resolve() == Path(replay_path).resolve():
                raise ReplayError("Replay source and destination must differ")
            try:
                self._replay = [_strict_loads(line) for line in
                                Path(replay_path).read_text(encoding="utf-8").splitlines()
                                if line.strip()]
            except (OSError, ValueError) as exc:
                raise ReplayError("Cannot read a complete replay transcript") from exc
            if not self._replay:
                raise ReplayError("Replay transcript is empty")
            if any(not isinstance(item, dict) or item.get("version") not in SUPPORTED_TRANSCRIPT_VERSIONS
                   for item in self._replay):
                raise ReplayError("Replay transcript version is unsupported")
            if not isinstance(self._replay[0].get("request"), dict):
                raise ReplayError("Replay is missing its request object")
            self.model = model or self._replay[0].get("request", {}).get("model")
        else:
            self._base_url = os.environ.get("LLM_BASE_URL", "").rstrip("/")
            self._api_key = os.environ.get("LLM_API_KEY", "")
            self.model = model or os.environ.get("LLM_MODEL", "gpt-4o-mini")
            if not self._base_url or not self._api_key:
                raise ValueError("Set LLM_BASE_URL and LLM_API_KEY before a live run")
        if not isinstance(self.model, str) or not self.model.strip():
            raise ValueError("LLM_MODEL must be a non-empty string")
        destination = Path(log_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        self._log = destination.open("x", encoding="utf-8")

    def __enter__(self) -> "LLMClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def close(self) -> None:
        if not self._closed:
            self._log.close()
            self._closed = True

    def assert_replay_consumed(self) -> None:
        if self._replay is not None and self._replay_cursor != len(self._replay):
            raise ReplayError("Replay ended before all recorded calls were consumed")

    def _write(self, record: dict[str, Any]) -> None:
        self._log.write(_canonical(record) + "\n")
        self._log.flush()
        self.last_record = record
        self.call_count += 1
        self.total_elapsed_s += record["elapsed_s"]

    @staticmethod
    def _decode_response(body: str) -> tuple[str, str | None]:
        try:
            payload = _strict_loads(body)
            choices = payload["choices"]
            if not isinstance(choices, list) or len(choices) != 1:
                raise ValueError("Expected exactly one completion choice")
            message = choices[0]["message"]
            if message.get("tool_calls") or message.get("function_call"):
                raise ValueError("Tool calls are not permitted")
            raw = message["content"]
            if not isinstance(raw, str):
                raise ValueError("Completion content must be text")
            return raw, payload.get("model")
        except (ValueError, KeyError, TypeError, IndexError, AttributeError) as exc:
            raise ActionValidationError("Response must contain one textual JSON completion") from exc

    def _call(self, request: dict[str, Any], state: dict[str, Any],
              attempt: int) -> dict[str, Any]:
        replay_record = None
        request_hash = hashlib.sha256(_canonical(request).encode("utf-8")).hexdigest()
        record = {"version": VERSION, "call_index": self.call_count + 1,
                  "decision_index": self.decision_count, "attempt": attempt,
                  "mode": "replay" if self._replay is not None else "live",
                  "request": request, "request_sha256": request_hash,
                  "response_body": None, "response_model": None,
                  "raw_output": None, "action": None,
                  "validation_error": None, "transport_error": None,
                  "elapsed_s": 0.0}
        if self._replay is not None:
            if self._replay_cursor >= len(self._replay):
                raise ReplayError("Replay exhausted before this decision")
            replay_record = self._replay[self._replay_cursor]
            record["version"] = replay_record["version"]
            for field in ("call_index", "decision_index", "attempt", "request", "request_sha256"):
                if replay_record.get(field) != record[field]:
                    raise ReplayError(f"Replay input mismatch: {field}")
            elapsed = replay_record.get("elapsed_s")
            if not _finite_number(elapsed) or elapsed < 0:
                raise ReplayError("Replay has invalid elapsed_s")
            record["elapsed_s"] = elapsed
            record["response_body"] = replay_record.get("response_body")
            record["transport_error"] = replay_record.get("transport_error")
            self._replay_cursor += 1
        else:
            outbound = urllib.request.Request(
                f"{self._base_url}/chat/completions",
                data=_canonical(request).encode("utf-8"),
                headers={"Content-Type": "application/json",
                         "Authorization": f"Bearer {self._api_key}"}, method="POST")
            start = time.perf_counter()
            try:
                with urllib.request.urlopen(outbound, timeout=self.timeout_s) as response:
                    record["response_body"] = response.read().decode("utf-8")
            except urllib.error.HTTPError as exc:
                record["transport_error"] = {"type": "HTTPError", "status": exc.code}
                try:
                    record["response_body"] = exc.read().decode("utf-8", errors="replace")
                except (http.client.HTTPException, OSError, UnicodeError) as read_error:
                    record["response_body"] = _partial_response_text(read_error)
                    record["transport_error"]["body_read_error"] = type(read_error).__name__
            except http.client.HTTPException as exc:
                record["response_body"] = _partial_response_text(exc)
                record["transport_error"] = {"type": type(exc).__name__}
            except (urllib.error.URLError, TimeoutError, OSError, UnicodeError) as exc:
                # Exception text may include endpoint credentials; log only its type.
                record["transport_error"] = {"type": type(exc).__name__}
            finally:
                record["elapsed_s"] = time.perf_counter() - start

        if record["transport_error"] is None:
            try:
                raw, response_model = self._decode_response(record["response_body"])
                record["raw_output"] = raw
                record["response_model"] = response_model
                try:
                    parsed = _strict_loads(raw)
                except (ValueError, TypeError) as exc:
                    raise ActionValidationError("Completion is not a strict JSON object") from exc
                record["action"] = validate_action(parsed, state)
            except ActionValidationError as exc:
                record["validation_error"] = str(exc)
        if replay_record is not None:
            for field in ("raw_output", "action", "validation_error", "response_model"):
                if replay_record.get(field) != record[field]:
                    raise ReplayError(f"Replay output validation mismatch: {field}")
        self._write(record)
        if record["transport_error"] is not None:
            error = record["transport_error"]
            status = f" HTTP {error['status']}" if "status" in error else ""
            raise LLMRequestError(f"LLM request failed: {error['type']}{status}; see transcript")
        return record

    def decide(self, state: dict[str, Any]) -> dict[str, Any]:
        if self._closed:
            raise RuntimeError("LLM client is closed")
        if self._terminal:
            raise RuntimeError("LLM client stopped after an error; start a new run")
        prepared = _prepare_state(state)
        messages = [{"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": _canonical(prepared)}]
        self.decision_count += 1
        try:
            for attempt in (1, 2):
                request = {"model": self.model, "temperature": 0,
                           "response_format": {"type": "json_object"},
                           "messages": list(messages)}
                result = self._call(request, prepared, attempt)
                if result["validation_error"] is None:
                    return result["action"]
                if attempt == 1:
                    # Keep the exact original text in both transcript and repair input.
                    messages.extend([
                        {"role": "assistant", "content": result["raw_output"] or ""},
                        {"role": "user", "content":
                         "上一个输出不合法：" + result["validation_error"] +
                         "。仅修复为一个合法动作 JSON；遵守给定状态及 action/params 契约。"}])
            raise LLMOutputError("LLM output invalid after one repair; see transcript")
        except (LLMOutputError, LLMRequestError, ReplayError):
            self._terminal = True
            raise
