"""Offline-only tests of an explicitly selected package copy, never a simulation."""
from pathlib import Path
import importlib
import json
import os
import socket
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SHADOW = Path(sys.argv[1]).resolve()
sys.dont_write_bytecode = True
sys.path[:0] = [str(SHADOW), str(SHADOW / "tests"), str(ROOT / "vendor/wm_kit_opt2")]
os.environ["WORLD_MODEL_ROOT"] = str(ROOT / "vendor/wm_kit_opt2")

modules = [importlib.import_module("autonomous_brain." + name)
           for name in ("actions", "perception", "run", "llm")]
assert all(Path(module.__file__).is_relative_to(SHADOW) for module in modules)
print(json.dumps({"shadow": os.path.relpath(SHADOW, ROOT),
                  "modules": [os.path.relpath(module.__file__, ROOT) for module in modules],
                  "network": "socket connect/create_connection forbidden; urllib mocked by tests"}))
import pytest

with patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden")), \
     patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")):
    raise SystemExit(pytest.main(["-q", "-p", "no:cacheprovider", *sys.argv[2:]]))
