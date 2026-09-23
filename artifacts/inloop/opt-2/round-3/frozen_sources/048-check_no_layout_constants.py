#!/usr/bin/env python3
"""离线检查程序及其 base64 ZIP 内所有 Python 源码的布局坐标字面量。

AST 保留数字的实际正负号，不按行长跳过源码；检查列表/元组（含跨行）、
x/z 字典或关键字，以及同一行相邻数字中的坐标对。成对容差仍为场景单位
0.02，按对应单位换算；单值绝对值的 0.5% 近似只供人工复核，不算违规。
报告位置表只在这个离线工具中，绝不注入被检查的程序。此检查不执行程序，
也不声称能发现刻意计算或编码隐藏的坐标。
"""
import ast
import base64
import hashlib
import io
import json
import math
import sys
import zipfile
from pathlib import Path

POS = {"A": (-9.87, -6.72), "B": (9.31, -3.26), "C": (10.08, 1.26), "D": (12.82, 5.64),
       "E": (0.51, 4.43), "F": (-6.29, -5.48), "G": (-6.75, -0.76)}


def frames(start, units_per_meter=8.0):
    h = start["heading"]
    f0, r0 = (-math.sin(h), -math.cos(h)), (math.cos(h), -math.sin(h))
    for key, (x, z) in POS.items():
        dx, dz = x - start["x"], z - start["z"]
        right, fwd = dx * r0[0] + dz * r0[1], dx * f0[0] + dz * f0[1]
        yield key, "world", (x, z)
        yield key, "world_m", (x / units_per_meter, z / units_per_meter)
        yield key, "world_cm", (x * 100 / units_per_meter, z * 100 / units_per_meter)
        yield key, "odo_m", (right / units_per_meter, fwd / units_per_meter)
        yield key, "odo_cm", (right * 100 / units_per_meter, fwd * 100 / units_per_meter)


def references():
    """真值路径相对工具所属仓库定位，允许从任意工作目录调用。"""
    truth_dir = Path(__file__).resolve().parents[1] / "artifacts/truth/R2-GYI-MVP-02"
    paths = sorted(truth_dir.glob("map-*.json"))
    if not paths:
        raise FileNotFoundError(f"没有布局真值文件: {truth_dir}")
    refs = {}
    for path in paths:
        layout = json.loads(path.read_text(encoding="utf-8"))
        units = float(layout["unitsPerMeter"])
        for key, frame, (x, z) in frames(layout["start"], units):
            scale = 100 / units if frame.endswith("_cm") else 1 / units if frame.endswith("_m") else 1
            ref = (key, frame, x, z, 0.02 * scale)
            refs.setdefault(ref, []).append(path.stem)
    return refs, paths


def literal_number(node):
    """只折叠字面量的一元正负号，不猜测符号，也不执行表达式。"""
    if isinstance(node, ast.Constant) and type(node.value) in (int, float):
        return float(node.value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = literal_number(node.operand)
        if value is not None:
            return -value if isinstance(node.op, ast.USub) else value
    return None


class NumericLiterals(ast.NodeVisitor):
    def __init__(self):
        self.items = []

    def visit_UnaryOp(self, node):
        value = literal_number(node)
        if value is None:
            self.generic_visit(node)
        else:
            self.items.append((node, value))

    def visit_Constant(self, node):
        value = literal_number(node)
        if value is not None:
            self.items.append((node, value))


def coordinate_pairs(tree, numbers):
    """结构中的相邻数值能跨行；保留原工具对同一行相邻数值的检查。"""
    pairs = {}

    def add(left, right, kind):
        a, b = literal_number(left), literal_number(right)
        if a is None or b is None:
            return
        identity = (left.lineno, left.col_offset, right.lineno, right.col_offset)
        pairs.setdefault(identity, (left, a, right, b, kind))

    for node in ast.walk(tree):
        if isinstance(node, (ast.List, ast.Tuple)):
            for left, right in zip(node.elts, node.elts[1:]):
                add(left, right, type(node).__name__.lower())
        elif isinstance(node, ast.Dict):
            values = {key.value: value for key, value in zip(node.keys, node.values)
                      if isinstance(key, ast.Constant) and isinstance(key.value, str)}
            if "x" in values and "z" in values:
                add(values["x"], values["z"], "dict_x_z")
        elif isinstance(node, ast.Call):
            values = {arg.arg: arg.value for arg in node.keywords}
            if "x" in values and "z" in values:
                add(values["x"], values["z"], "keyword_x_z")
    for (left, _a), (right, _b) in zip(numbers, numbers[1:]):
        if left.lineno == right.lineno:
            add(left, right, "same_line")
    return pairs.values()


def embedded_sources(tree, source_name):
    """只读取字面 base64 ZIP，不解压落盘，不运行任何包代码。"""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else None
        if name != "b64decode" or not isinstance(node.args[0], ast.Constant):
            continue
        payload = node.args[0].value
        if not isinstance(payload, (str, bytes)):
            continue
        data = base64.b64decode(payload, validate=True)
        stream = io.BytesIO(data)
        if not zipfile.is_zipfile(stream):
            continue
        with zipfile.ZipFile(stream) as archive:
            for entry in archive.infolist():
                if entry.filename.endswith(".py"):
                    label = f"{source_name}::zip@{node.lineno}/{entry.filename}"
                    text = archive.read(entry).decode("utf-8-sig")
                    yield label, ast.parse(text, filename=label)


def scan_source(source_name, tree, refs):
    visitor = NumericLiterals()
    visitor.visit(tree)
    numbers = sorted(visitor.items, key=lambda item: (item[0].lineno, item[0].col_offset))
    violations, review = [], []
    for left, a, right, b, kind in coordinate_pairs(tree, numbers):
        for (key, frame, x, z, tolerance), layouts in refs.items():
            if abs(a - x) < tolerance and abs(b - z) < tolerance:
                violations.append({"source": source_name, "line": left.lineno,
                                   "end_line": right.lineno, "values": [a, b], "kind": kind,
                                   "position": key, "frame": frame, "reference": [x, z],
                                   "tolerance": tolerance, "layouts": layouts})
    for node, value in numbers:
        if abs(value) < 1.0:
            continue
        for (key, frame, x, z, _tolerance), _layouts in refs.items():
            for axis, component in (("x", x), ("z", z)):
                if abs(component) >= 1.0 and abs(abs(value) - abs(component)) < 0.005 * abs(component):
                    review.append({"source": source_name, "line": node.lineno, "value": value,
                                   "position": key, "frame": frame, "axis": axis,
                                   "reference": component})
    return {"source": source_name, "numeric_literals": len(numbers)}, violations, review


def main(path):
    refs, truth_paths = references()
    program_bytes = Path(path).read_bytes()
    tree = ast.parse(program_bytes.decode("utf-8-sig"), filename=path)
    sources = [(path, tree), *embedded_sources(tree, path)]
    violations, review = [], []
    scanned = []
    for source_name, source_tree in sources:
        info, pairs, singles = scan_source(source_name, source_tree, refs)
        scanned.append(info)
        violations.extend(pairs)
        review.extend(singles)
    print(json.dumps({"file": path, "program_sha256": hashlib.sha256(program_bytes).hexdigest(),
                      "numeric_literals": sum(item["numeric_literals"] for item in scanned),
                      "scanned_sources": scanned, "embedded_python_files": len(scanned) - 1,
                      "truth_files": [str(p) for p in truth_paths], "pair_violations": violations,
                      "single_value_near_matches": review}, ensure_ascii=False, indent=1))
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
