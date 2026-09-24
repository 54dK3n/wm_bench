#!/usr/bin/env python3
"""Embed the exact standalone runtime filter, preserving the complete raw log."""
import argparse
import ast
import hashlib
from pathlib import Path

BEGIN = "# BEGIN EXACT STANDALONE DETECTION FILTER\n"
END = "# END EXACT STANDALONE DETECTION FILTER\n"
BRIDGE = '''    # The raw red/blue log above is complete; filtering never mutates it.
    filter_input = list(result or [])
    filter_result = detection_filter_update(filter_input, odometry=odo, road_state=None, tick=odo.get("tick"))
    print("GY " + json.dumps({"event": "detection_filter", "tick": odo.get("tick"),
                              "observe_count": STATE["observe_count"],
                              "filter_sha256": DETECTION_FILTER_SHA256,
                              **filter_result}, ensure_ascii=False))
    result = [filter_input[index] for index in filter_result["kept_indices"]]
'''


def embed(program, module):
    text, source = program.read_text(), module.read_text()
    if not source.endswith("\n"):
        raise ValueError("Standalone filter source must end with newline for exact embedding")
    tree = ast.parse(source)
    if any(isinstance(node, ast.ImportFrom) and node.module == "__future__" for node in tree.body):
        raise ValueError("Standalone filter must be embeddable without future imports")
    digest = hashlib.sha256(source.encode()).hexdigest()
    if BEGIN in text:
        start, end = text.index(BEGIN), text.index(END) + len(END)
        text = text[:start] + BEGIN + source + END + text[end:]
    else:
        index = text.index("def counted_observe(")
        text = text[:index] + BEGIN + source + END + "\n\n" + text[index:]
    constant = f'DETECTION_FILTER_SHA256 = "{digest}"'
    if "DETECTION_FILTER_SHA256 = " in text:
        text = "\n".join(constant if line.startswith("DETECTION_FILTER_SHA256 = ") else line for line in text.split("\n"))
    else:
        text = text.replace("WM_KIT_COMMIT = ", constant + "\nWM_KIT_COMMIT = ", 1)
    old = '    result = [item for item in (result or []) if float(item.get("confidence") or 0.0) >= confidence]\n'
    if BRIDGE not in text:
        if text.count(old) != 1:
            raise ValueError("Expected one original local confidence gate")
        text = text.replace(old, BRIDGE + old, 1)
    ast.parse(text)
    program.write_text(text)
    print(digest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("program", type=Path)
    parser.add_argument("filter", type=Path)
    args = parser.parse_args()
    embed(args.program, args.filter)


if __name__ == "__main__":
    main()
