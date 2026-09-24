#!/usr/bin/env python3
"""把 wm_kit 某个提交里的 world_model 包打成 zip，替换任务程序里内嵌的 base64，并写入提交哈希。

    python3 tools/embed_world_model.py programs/world_model_target_delivery.py [--src ~/wm_kit] [--rev HEAD]

文件清单与原内嵌 zip 相同；内容取自 git 提交（不是工作区），工作区与提交不一致时拒绝，
保证 program_version 行打印的 wm_kit_commit 与内嵌包逐字节对应。zip 条目时间戳固定，同一提交得到同一 SHA256。
"""
import argparse
import base64
import hashlib
import io
import re
import subprocess
import zipfile
from pathlib import Path

BLOB = re.compile(r'b64decode\("([^"]+)"\)')
COMMIT = re.compile(r'^WM_KIT_COMMIT = "[^"]*"$', re.M)


def git(src, *args, binary=False):
    out = subprocess.run(["git", "-C", src, *args], capture_output=True, check=True)
    return out.stdout if binary else out.stdout.decode().strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("program")
    ap.add_argument("--src", default=str(Path.home() / "wm_kit"))
    ap.add_argument("--rev", default="HEAD")
    args = ap.parse_args()
    program = Path(args.program)
    text = program.read_text(encoding="utf-8")
    match = BLOB.search(text)
    assert match, "program has no embedded world_model zip"
    assert COMMIT.search(text), "program has no WM_KIT_COMMIT line"
    commit = git(args.src, "rev-parse", args.rev)
    old = zipfile.ZipFile(io.BytesIO(base64.b64decode(match.group(1))))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as new:
        for name in old.namelist():
            data = git(args.src, "show", f"{commit}:{name}", binary=True)
            work = (Path(args.src) / name).read_bytes()
            if work != data:
                raise SystemExit(f"{name}: 工作区与 {commit[:10]} 不一致，先提交")
            if data != old.read(name):
                print(f"updated {name}")
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            new.writestr(info, data)
    raw = buf.getvalue()
    blob = base64.b64encode(raw).decode("ascii")
    text = text[:match.start(1)] + blob + text[match.end(1):]
    text = COMMIT.sub(f'WM_KIT_COMMIT = "{commit}"', text, count=1)
    program.write_text(text, encoding="utf-8")
    print(f"wm_kit_commit={commit} wm_embed_sha256={hashlib.sha256(raw).hexdigest()}")


if __name__ == "__main__":
    main()
