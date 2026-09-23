#!/usr/bin/env python3
"""Verify frozen native measurements and refit with Decimal; no simulation."""
from decimal import Decimal, getcontext
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
getcontext().prec = 40


def read(name):
    return json.loads((HERE / name).read_text())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    plan, freeze = read("plan.json"), read("freeze.json")
    measurements, contract = read("measurements.json"), read("calibration.json")
    rows = measurements["rows"]
    values = [(Decimal(str(r["actualDistanceCm"])),
               Decimal(str(r["actualTurnDeg"])), Decimal(r["elapsedTicks"]))
              for r in rows]
    dd = sum(d*d for d, a, t in values)
    da = sum(d*a for d, a, t in values)
    aa = sum(a*a for d, a, t in values)
    dt = sum(d*t for d, a, t in values)
    at = sum(a*t for d, a, t in values)
    determinant = dd*aa - da*da
    coefficient_a = (dt*aa - da*at) / determinant
    coefficient_b = (dd*at - da*dt) / determinant
    k = coefficient_b / coefficient_a
    residual = max(abs(coefficient_a*d + coefficient_b*a - t)/t
                   for d, a, t in values)
    checks = {
        "plan_hash": sha(HERE / "plan.json") == freeze["planSha256"] == contract["protocol_sha256"],
        "core_hash": sha(plan["source"]["coreFile"]) == contract["source_sha256"],
        "runner_hash": sha(plan["source"]["runnerFile"]) == contract["runner_sha256"],
        "measurements_hash": sha(HERE / "measurements.json") == contract["measurements_sha256"],
        "freeze_before_measurements": freeze["frozenAtUtc"] <= measurements["startedUtc"],
        "all_planned_ids_in_order": [r["id"] for r in rows] == [r["id"] for r in plan["trials"]],
        "groups_all_three": all(sum(r["groupDeg"] == angle for r in rows) == 3 for angle in (0,45,90,180)),
        "all_twelve_qualified": len(rows) == 12 and all(r["qualified"] for r in rows),
        "all_ticks_match": all(r["after"]["tick"]-r["before"]["tick"] == r["elapsedTicks"] == r["nativeMeasurementStepCount"] for r in rows),
        "public_odometry_distance_matches": all(abs(r["actualDistanceCm"]-r["odometryDistanceCm"]) <= 0.1 for r in rows),
        "decimal_k_agrees": abs(float(k)-contract["k_cm_per_deg"]) < 1e-12,
        "decimal_residual_agrees": abs(float(residual)-contract["max_relative_residual"]) < 1e-12,
        "residual_within_frozen_limit": residual <= Decimal(str(plan["fit"]["residualLimit"])),
        "historical_task_diagnosis_preserved": Path(contract["historical_task_diagnosis_preserved"]).exists(),
    }
    for row in rows:
        trial = read("trials/" + row["id"] + ".json")
        checks["trial_" + row["id"]] = (trial["row"] == row and
            len([s for s in trial["steps"] if s["phase"] == "measurement"]) == row["elapsedTicks"] and
            all(s["onRoad"] is True for s in trial["steps"]))
    output = {"all_pass": all(checks.values()), "checks": checks,
              "samples": len(rows), "decimal_k_cm_per_deg": str(k),
              "decimal_max_relative_residual": str(residual),
              "scope": "Offline evidence consistency only; no additional native or task run; no production-authorization decision."}
    (HERE / "offline_checks.json").write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps(output))
    return 0 if output["all_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
