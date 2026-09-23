#!/usr/bin/env python3
"""Build the two-target program only from a passing, measured P3 calibration."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "artifacts/inloop/opt-1/round-2/program.py"
FRAGMENTS = ("target_selection.py", "opt2_flow_fragment.py", "opt2_delivery_fragment.py",
             "opt2_grasp_fragment.py")


def build(calibration, version, output, wm_src):
    data = json.loads(calibration.read_text())
    k = data.get("k_cm_per_deg")
    if (data.get("all_pass") is not True or type(k) not in (float, int)
            or not math.isfinite(k) or k < 0):
        raise ValueError("A passing native-controller measurement and finite measured k are required")
    source = BASE.read_text()
    source = source.replace('PROGRAM_VERSION = "wm-opt1-r2-20260924"',
                            'PROGRAM_VERSION = ' + json.dumps(version), 1)
    constants = ('TURN_COST_K = ' + repr(k) + '\nTURN_CALIBRATION_SHA256 = "' +
                 hashlib.sha256(calibration.read_bytes()).hexdigest() + '"\n')
    source = source.replace('WM_KIT_COMMIT = ', constants + 'WM_KIT_COMMIT = ', 1)
    source = source.replace('    "wm_embed_sha256": WM_EMBED_SHA256,',
                            '    "wm_embed_sha256": WM_EMBED_SHA256,\n'
                            '    "turn_cost_k": TURN_COST_K,\n'
                            '    "turn_calibration_sha256": TURN_CALIBRATION_SHA256,', 1)
    # All raw detections and the frozen filter decisions have already been logged.
    bridge = ('    if targets_only:\n'
              '        return [item for item in (result or []) if _is_target(item)]')
    assert source.count(bridge) == 1
    source = source.replace(bridge,
                            '    result = _demo_filter_observations(result, odometry_to_pose(odo))\n' + bridge)
    loop_start = source.index('    # v27 抓取闭环：grab → holding()')
    loop_end = source.index('\ndef _finish_flow(success, stage, reason=None):', loop_start)
    source = source[:loop_start] + '    return _opt2_grab_loop()\n\n' + source[loop_end:]
    source = source[:source.index('\ndef _finish_flow(success, stage, reason=None):')]
    for name in FRAGMENTS:
        text = (ROOT / "programs" / name).read_text()
        source += '\n# BEGIN EXACT OPT2 FRAGMENT: ' + name + '\n' + text
        source += '# END EXACT OPT2 FRAGMENT: ' + name + '\n'
    source += ('\ntry:\n    run_target_flow()\n'
               'except MissionFailure as failure:\n    _finish_flow(False, "constraint", str(failure))\n')
    output.write_text(source)
    subprocess.run([sys.executable, str(ROOT / "tools/embed_world_model.py"), str(output),
                    "--src", str(wm_src)], check=True)
    manifest = {"base": str(BASE), "base_sha256": hashlib.sha256(BASE.read_bytes()).hexdigest(),
                "calibration": str(calibration.resolve()), "calibration_sha256": hashlib.sha256(calibration.read_bytes()).hexdigest(),
                "version": version, "k_cm_per_deg": k,
                "wm_source": str(wm_src.resolve()),
                "fragments": {name: hashlib.sha256((ROOT / "programs" / name).read_bytes()).hexdigest()
                              for name in FRAGMENTS},
                "program": str(output.resolve()), "program_sha256": hashlib.sha256(output.read_bytes()).hexdigest()}
    output.with_suffix('.build.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--wm-src", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=ROOT / "programs/world_model_opt2.py")
    args = parser.parse_args()
    print(json.dumps(build(args.calibration, args.version, args.out, args.wm_src), ensure_ascii=False))
