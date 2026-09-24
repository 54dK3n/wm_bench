"""Execute the filter bridge after the real platform's async AST conversion."""
import ast
import asyncio
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from demo_preflight import PLATFORM, ROOT


def test_filter_bridge_after_actual_platform_transform_keeps_complete_raw():
    source = (ROOT / "artifacts/inloop/opt-1/round-2/program.py").read_text()
    tree = ast.parse(source)
    names = {node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                and node.name in {"detection_filter_update", "counted_observe"}]
    assert {node.name for node in selected} == {"detection_filter_update", "counted_observe"}
    constants = {target.id: ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                 for target in node.targets if isinstance(target, ast.Name)
                 and target.id in {"CONFIDENCE_FLOORS", "FILTER_VERSION", "DETECTION_FILTER_SHA256"}}
    raw = [{"category": "target", "distanceCm": 60, "bearingDeg": 0, "confidence": .83},
           {"category": "target", "distanceCm": 70, "bearingDeg": 1, "confidence": .84},
           {"category": "distractor", "distanceCm": 100, "bearingDeg": 2, "confidence": .80}]
    output, queries = [], []
    async def odometry():
        return {"tick": 100, "rightCm": 0, "forwardCm": 0, "headingDeg": 0}
    async def motion(_odo):
        return True, [0, 0, 0], None, None
    async def observe(category, confidence):
        queries.append((category, confidence))
        return raw
    namespace = {"math": math, "json": json, "STATE": {"observe_count": 0}, "MAX_OBSERVES": 92,
                 "nav_odometry": odometry, "_observe_motion": motion, "query_observe": observe,
                 "MissionFailure": RuntimeError, "print": output.append, **constants}
    worker = (PLATFORM / "python-worker.js").read_text()
    transformer = worker[worker.index("class AsyncRobotTransformer("):worker.index("student_run_target =")]
    transformer_ns = {"ast": ast}
    exec(transformer, transformer_ns)
    transformed = transformer_ns["AsyncRobotTransformer"](names).visit(ast.Module(body=selected, type_ignores=[]))
    ast.fix_missing_locations(transformed)
    exec(compile(transformed, "filter-platform-test", "exec"), namespace)
    result = asyncio.run(namespace["counted_observe"](confidence=.4))
    assert queries == [(None, 0.0)]
    assert result == raw[1:]
    assert result[0] is raw[1] and result[1] is raw[2]
    logs = [json.loads(line[3:]) for line in output]
    assert logs[0]["event"] == "observe" and logs[0]["raw"] == raw
    assert logs[1]["event"] == "detection_filter"
    assert logs[1]["rejected_indices"] == [0]
    assert namespace["STATE"]["observe_count"] == 1
