#!/usr/bin/env python3
"""测距标定分析：读 inloop_driver 生成的 *.calib.json，出误差表、拟合修正、留 1/3 验证。

    python3 tools/calib_analyze.py <calib.json ...> --out artifacts/inloop/calib/ANALYSIS_LOBO

约定：bearing 右为正（与 observe().bearingDeg 同号）；distance 为车体中心到球心，cm。
误差 = 真值 − 读数。修正只能用运行时可得的 distanceCm 与 bearingDeg。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

D_BINS = [(40, 55), (55, 70), (70, 85), (85, 95.01)]
B_BINS = [(0, 12), (12, 24), (24, 35.01)]
POSE_TOL_CM = 0.5
POSE_TOL_DEG = 0.5
CAMERA_L_CM = 5.375
CAM_BEARING_TOL_DEG = 3.0


def load_rows(paths):
    rows, dropped = [], {"pose": 0, "assoc": 0, "domain": 0}
    for path in paths:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        layout = data.get("assignedMap") or Path(path).stem
        for r in data["rows"]:
            pc = r["poseCheck"]
            if abs(pc["dPosCm"]) > POSE_TOL_CM or abs(pc["dHeadingDeg"]) > POSE_TOL_DEG:
                dropped["pose"] += 1
                continue
            # 关联门：读数投影离真球足够近，且明显比第二近的同类球近（排除地图纹理伪检测）
            gate = max(20.0, 0.35 * r["truthDistanceCm"])
            second = r.get("secondProjErrCm")
            if r["projErrCm"] > gate or (second is not None and second < 2.0 * r["projErrCm"]):
                dropped["assoc"] += 1
                continue
            # 方位一致性：从相机（车体中心前方 CAMERA_L_CM，平台 cameraForwardOffset 0.43 单位）看真球的方位
            # 应与读数方位一致（正确关联时 RMSE 约 0.7°）。只用方位筛，不按距离误差挑样本。
            tb = math.radians(r["truthBearingDeg"])
            cam_b = math.degrees(math.atan2(r["truthDistanceCm"] * math.sin(tb), r["truthDistanceCm"] * math.cos(tb) - CAMERA_L_CM))
            if abs(cam_b - r["bearingDeg"]) > CAM_BEARING_TOL_DEG:
                dropped["assoc"] += 1
                continue
            if not (40 <= r["distanceCm"] <= 95 and abs(r["bearingDeg"]) <= 35):
                dropped["domain"] += 1
                continue
            rows.append({**r, "layout": layout, "group": f"{layout}:{r['station']}"})
    return rows, dropped


def split(rows):
    """按站点分组，每 3 个站点取 1 个做验证（同一站点的扫描不会跨集合）。"""
    groups = sorted({r["group"] for r in rows}, key=lambda g: (g.split(":")[0], int(g.split(":")[1])))
    val_groups = {g for i, g in enumerate(groups) if i % 3 == 2}
    train = [r for r in rows if r["group"] not in val_groups]
    val = [r for r in rows if r["group"] in val_groups]
    return train, val


def cell_of(r):
    di = next((i for i, (a, b) in enumerate(D_BINS) if a <= r["distanceCm"] < b), None)
    bi = next((i for i, (a, b) in enumerate(B_BINS) if a <= abs(r["bearingDeg"]) < b), None)
    return di, bi


def error_table(rows):
    lines = ["| 读数 cm \\ \\|方位\\| | " + " | ".join(f"{a}–{int(b)}°" for a, b in B_BINS) + " |",
             "|---|" + "---|" * len(B_BINS)]
    cells = {}
    for r in rows:
        cells.setdefault(cell_of(r), []).append(r)
    for di, (a, b) in enumerate(D_BINS):
        out = []
        for bi in range(len(B_BINS)):
            items = cells.get((di, bi), [])
            if not items:
                out.append("—")
                continue
            dd = np.array([x["truthDistanceCm"] - x["distanceCm"] for x in items])
            db = np.array([abs(x["truthBearingDeg"]) - abs(x["bearingDeg"]) for x in items])
            red = sum(1 for x in items if x["category"] == "target")
            out.append(f"n={len(items)} (红{red}/蓝{len(items) - red})<br>Δd {dd.mean():+.1f}±{dd.std():.1f}<br>Δ\\|β\\| {db.mean():+.1f}±{db.std():.1f}")
        lines.append(f"| {a}–{int(b)} | " + " | ".join(out) + " |")
    return "\n".join(lines), {f"{k[0]},{k[1]}": len(v) for k, v in cells.items()}


# ---- 候选修正形式：每个都只用 (d, β) ----

def feats(rows):
    d = np.array([r["distanceCm"] for r in rows], float)
    b = np.radians(np.array([r["bearingDeg"] for r in rows], float))
    return d, b


def truth(rows):
    td = np.array([r["truthDistanceCm"] for r in rows], float)
    tb = np.radians(np.array([r["truthBearingDeg"] for r in rows], float))
    return td, tb


def lstsq(X, y):
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    return coef


class Model:
    name = ""
    def fit(self, rows): ...
    def predict(self, d, b): ...


class NoCorrection(Model):
    name = "M0 不修正"
    params = {}
    def fit(self, rows): return self
    def predict(self, d, b): return d, b


class DistLinear(Model):
    name = "M1 d'=a+k·d（方位不修正）"
    def fit(self, rows):
        d, _ = feats(rows); td, _ = truth(rows)
        self.a, self.k = lstsq(np.c_[np.ones_like(d), d], td)
        self.params = {"a": self.a, "k": self.k}
        return self
    def predict(self, d, b): return self.a + self.k * d, b


class DistBearing(Model):
    name = "M2 d'=a+k·d+c·β²，β'=g·β"
    def fit(self, rows):
        d, b = feats(rows); td, tb = truth(rows)
        self.a, self.k, self.c = lstsq(np.c_[np.ones_like(d), d, b ** 2], td)
        (self.g,) = lstsq(b[:, None], tb)
        self.params = {"a": self.a, "k": self.k, "c_per_rad2": self.c, "g": self.g}
        return self
    def predict(self, d, b): return self.a + self.k * d + self.c * b ** 2, self.g * b


class CameraOffset(Model):
    """读数视为从车体中心前方 L 处的相机量得：相机距离 ρ=k·d+a、相机方位 β。
    车体系坐标 f = L + ρcosβ，r = ρsinβ。拟合 (a, k, L) 使车体系位置误差最小。"""
    name = "M3 相机前移 L：ρ=a+k·d，f=L+ρcosβ，r=ρsinβ"
    def fit(self, rows):
        d, b = feats(rows); td, tb = truth(rows)
        f_t, r_t = td * np.cos(tb), td * np.sin(tb)
        # 线性：f = L + a cosβ + k d cosβ ; r = a sinβ + k d sinβ  → 未知 (L, a, k)
        X = np.r_[np.c_[np.ones_like(d), np.cos(b), d * np.cos(b)], np.c_[np.zeros_like(d), np.sin(b), d * np.sin(b)]]
        y = np.r_[f_t, r_t]
        self.L, self.a, self.k = lstsq(X, y)
        self.params = {"L": self.L, "a": self.a, "k": self.k}
        return self
    def predict(self, d, b):
        rho = self.a + self.k * d
        f = self.L + rho * np.cos(b)
        r = rho * np.sin(b)
        return np.hypot(f, r), np.arctan2(r, f)


class CameraOffsetCos(Model):
    """M3 + 读数里的 1/cosβ 项：ρ = a + k·d + c·d·(1−cosβ)。"""
    name = "M4 M3 + c·d·(1−cosβ)"
    def fit(self, rows):
        d, b = feats(rows); td, tb = truth(rows)
        f_t, r_t = td * np.cos(tb), td * np.sin(tb)
        u = d * (1 - np.cos(b))
        X = np.r_[np.c_[np.ones_like(d), np.cos(b), d * np.cos(b), u * np.cos(b)],
                  np.c_[np.zeros_like(d), np.sin(b), d * np.sin(b), u * np.sin(b)]]
        self.L, self.a, self.k, self.c = lstsq(X, np.r_[f_t, r_t])
        self.params = {"L": self.L, "a": self.a, "k": self.k, "c": self.c}
        return self
    def predict(self, d, b):
        rho = self.a + self.k * d + self.c * d * (1 - np.cos(b))
        f = self.L + rho * np.cos(b)
        r = rho * np.sin(b)
        return np.hypot(f, r), np.arctan2(r, f)


class CameraOffsetSec(Model):
    """检测器用 W·F/w/cosα 估距，而离轴球的像宽约按 1/cos²α 放大，读数因此约短 cosβ 倍：
    ρ = a + k·d/cosβ（相机量程），f = L + ρcosβ，r = ρsinβ。对 (L, a, k) 线性。"""
    name = "M5 相机前移 L：ρ=a+k·d/cosβ，f=L+ρcosβ，r=ρsinβ"
    def fit(self, rows):
        d, b = feats(rows); td, tb = truth(rows)
        f_t, r_t = td * np.cos(tb), td * np.sin(tb)
        u = d / np.cos(b)
        X = np.r_[np.c_[np.ones_like(d), np.cos(b), u * np.cos(b)], np.c_[np.zeros_like(d), np.sin(b), u * np.sin(b)]]
        self.L, self.a, self.k = lstsq(X, np.r_[f_t, r_t])
        self.params = {"L": self.L, "a": self.a, "k": self.k}
        return self
    def predict(self, d, b):
        rho = self.a + self.k * d / np.cos(b)
        f = self.L + rho * np.cos(b)
        r = rho * np.sin(b)
        return np.hypot(f, r), np.arctan2(r, f)


class InverseRange(Model):
    """像素宽度常偏差：1/ρ_cam = α·cosβ/(d−L) + c，L 取平台相机前移 5.375cm（不拟合）。"""
    name = "M6 1/ρ=α·cosβ/(d−L)+c（L=5.375 固定）"
    def fit(self, rows):
        d, b = feats(rows); td, tb = truth(rows)
        rc = np.hypot(td * np.cos(tb) - CAMERA_L_CM, td * np.sin(tb))
        self.alpha, self.c = lstsq(np.c_[np.cos(b) / (d - CAMERA_L_CM), np.ones_like(d)], 1.0 / rc)
        self.params = {"alpha": self.alpha, "c": self.c}
        return self
    def predict(self, d, b):
        rho = 1.0 / (self.alpha * np.cos(b) / (d - CAMERA_L_CM) + self.c)
        f = CAMERA_L_CM + rho * np.cos(b)
        r = rho * np.sin(b)
        return np.hypot(f, r), np.arctan2(r, f)


def residuals(model, rows):
    d, b = feats(rows); td, tb = truth(rows)
    pd, pb = model.predict(d, b)
    pos = np.hypot(td * np.cos(tb) - pd * np.cos(pb), td * np.sin(tb) - pd * np.sin(pb))
    return {"n": len(rows), "dist_mean": float(np.mean(td - pd)), "dist_rmse": float(np.sqrt(np.mean((td - pd) ** 2))),
            "dist_maxabs": float(np.max(np.abs(td - pd))),
            "bear_rmse_deg": float(np.degrees(np.sqrt(np.mean((tb - pb) ** 2)))),
            "pos_rmse": float(np.sqrt(np.mean(pos ** 2))), "pos_p95": float(np.percentile(pos, 95)), "pos_max": float(np.max(pos))}


def fmt(res):
    return (f"n={res['n']} Δd 均值 {res['dist_mean']:+.2f} RMSE {res['dist_rmse']:.2f} max {res['dist_maxabs']:.1f} cm；"
            f"β RMSE {res['bear_rmse_deg']:.2f}°；位置 RMSE {res['pos_rmse']:.2f} p95 {res['pos_p95']:.2f} max {res['pos_max']:.2f} cm")


ADOPTED_M5 = {"L": 5.1557, "a": 1.6239, "k": 1.0187}  # v26 写进 RANGE_CAL 的常数（不改）
TRUTH_DIR = Path(__file__).resolve().parent.parent / "artifacts" / "truth" / "R2-GYI-MVP-02"


def dedupe(rows):
    """同一布局同一个球、读数与真值完全相同的样本（车回到同一站点重复观测）只留第一条。"""
    seen, kept, removed = set(), [], []
    for r in rows:
        key = (r["layout"], r["packageId"], r["distanceCm"], r["bearingDeg"], r["truthDistanceCm"], r["truthBearingDeg"])
        (removed if key in seen else kept).append(r)
        seen.add(key)
    return kept, removed


def attach_physical(rows):
    """guangyang-<role>-N 是真值文件里该类第 N 个物体；多个布局共用同一摆放位置时 physical 相同。"""
    cache = {}
    for r in rows:
        if r["layout"] not in cache:
            objs = json.loads((TRUTH_DIR / f"{r['layout']}.json").read_text(encoding="utf-8"))["objects"]
            by = {}
            for o in objs:
                by.setdefault(o["cls"], []).append(o["world"])
            cache[r["layout"]] = by
        role, idx = r["packageId"].rsplit("-", 2)[-2], int(r["packageId"].rsplit("-", 1)[-1])
        w = cache[r["layout"]][role][idx - 1]
        r["physical"] = f"{role}@{w[0]:.2f},{w[1]:.2f}"
    return rows


class FixedM5(CameraOffsetSec):
    name = "M5 采用常数（v26，不重拟合）"
    def fit(self, rows):
        self.L, self.a, self.k = ADOPTED_M5["L"], ADOPTED_M5["a"], ADOPTED_M5["k"]
        self.params = dict(ADOPTED_M5)
        return self


def per_ball(model_factory, rows, key):
    """按球留一：对每个球用其余球拟合，报告该球的留出偏差（真值−修正距离的均值）与位置误差。"""
    groups = {}
    for r in rows:
        groups.setdefault(r[key], []).append(r)
    out = []
    for g, held in sorted(groups.items()):
        rest = [r for r in rows if r[key] != g]
        m = model_factory().fit(rest)
        d, b = feats(held); td, tb = truth(held); pd, pb = m.predict(d, b)
        pos = np.hypot(td * np.cos(tb) - pd * np.cos(pb), td * np.sin(tb) - pd * np.sin(pb))
        out.append({"ball": g, "category": held[0]["category"], "n": len(held),
                    "layouts": sorted({r["layout"] for r in held}), "reading_range": [float(d.min()), float(d.max())],
                    "bias_cm": float(np.mean(td - pd)), "sd_cm": float(np.std(td - pd)),
                    "pos_rmse_cm": float(np.sqrt(np.mean(pos ** 2)))})
    return out


def lobo_section(title, rows, key, models):
    md = [f"### {title}", ""]
    result = {}
    for name, factory in models:
        balls = per_ball(factory, rows, key)
        result[name] = balls
        md += [f"**{name}**", "", "| 球 | 颜色 | n | 读数 cm | 留出偏差 cm | 球内 sd | 位置 RMSE |", "|---|---|---|---|---|---|---|"]
        for x in balls:
            md.append(f"| {x['ball']} | {'红' if x['category'] == 'target' else '蓝'} | {x['n']} | {x['reading_range'][0]:.0f}–{x['reading_range'][1]:.0f} "
                      f"| {x['bias_cm']:+.1f} | {x['sd_cm']:.1f} | {x['pos_rmse_cm']:.1f} |")
        for c, label in (("target", "红"), ("distractor", "蓝")):
            sub = [x for x in balls if x["category"] == c]
            ok = sum(1 for x in sub if abs(x["bias_cm"]) <= 5.0)
            if sub:
                md.append(f"- {label}球 |留出偏差| ≤5cm：{ok}/{len(sub)}；范围 {min(x['bias_cm'] for x in sub):+.1f} … {max(x['bias_cm'] for x in sub):+.1f} cm")
        allb = [x["bias_cm"] for x in balls]
        md += [f"- 全部球：范围 {min(allb):+.1f} … {max(allb):+.1f} cm，球间偏差 RMS {np.sqrt(np.mean(np.square(allb))):.1f} cm", ""]
    return md, result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    rows, dropped = load_rows(args.files)
    rows, removed = dedupe(rows)
    attach_physical(rows)
    table, counts = error_table(rows)
    report = {"files": args.files, "dropped": dropped, "duplicates_removed": [
                  {k: r[k] for k in ("layout", "packageId", "n", "tick", "distanceCm", "bearingDeg")} for r in removed],
              "n_total": len(rows), "layouts": sorted({r["layout"] for r in rows}), "cell_counts": counts}
    n_ball = len({(r["layout"], r["packageId"]) for r in rows})
    n_phys = len({r["physical"] for r in rows})
    md = ["# 测距标定分析（按球留一）", "",
          f"样本：{len(rows)}（布局 {', '.join(report['layouts'])}；红 {sum(r['category']=='target' for r in rows)} / 蓝 {sum(r['category']=='distractor' for r in rows)}；"
          f"球 {n_ball}（布局+包裹），物理摆放位置 {n_phys}）",
          f"剔除：位姿核对失败 {dropped['pose']}，关联失败/伪检测 {dropped['assoc']}，读数或方位超出 40–95cm×|β|≤35° {dropped['domain']}，"
          f"重复样本 {len(removed)}（" + "；".join(f"{r['layout']} {r['packageId']} tick {r['tick']}" for r in removed) + "）",
          "", "## 误差表（真值 − 读数）", "", table, "",
          "## 按球留一", "",
          "对每个球：用其余所有球拟合，预测该球全部样本；留出偏差 = 真值距离 − 修正后距离 的均值（正 = 修正后仍偏短）。", ""]
    models = [("M5 ρ=a+k·d/cosβ", CameraOffsetSec), ("M6 1/ρ=α·cosβ/(d−L)+c", InverseRange)]
    for r in rows:
        r["group_ball"] = f"{r['layout']}:{r['packageId'].replace('guangyang-', '')}"
    sec, res_a = lobo_section("A. 分组 = 布局 + packageId（按要求）", rows, "group_ball", models)
    md += sec
    # B：同一物理位置在多个布局出现时，A 会把同一个球同时放进训练和留出（4 条跨布局样本读数、真值完全相同）
    phys_rows, phys_removed = [], set()
    seen = set()
    for r in rows:
        key = (r["physical"], r["distanceCm"], r["bearingDeg"], r["truthDistanceCm"], r["truthBearingDeg"])
        if key in seen:
            phys_removed.add((r["layout"], r["packageId"], r["tick"]))
            continue
        seen.add(key)
        phys_rows.append(r)
    md += [f"B 组另去掉跨布局完全相同的样本 {len(phys_removed)} 条：" + "；".join(f"{a} {b} tick {c}" for a, b, c in sorted(phys_removed)), ""]
    sec, res_b = lobo_section("B. 分组 = 物理摆放位置（更严格）", phys_rows, "physical", models)
    md += sec
    # 采用常数（不重拟合）在每个球上的偏差，作为参考
    fixed = per_ball(FixedM5, rows, "group_ball")
    md += ["## 采用常数（v26 RANGE_CAL，不重拟合）每球偏差（参考，非留出）", "", "| 球 | n | 偏差 cm |", "|---|---|---|"]
    md += [f"| {x['ball']} | {x['n']} | {x['bias_cm']:+.1f} |" for x in fixed]
    report.update({"lobo_layout_package": res_a, "lobo_physical": res_b, "adopted_per_ball": fixed})
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    Path(str(out) + ".md").write_text("\n".join(md) + "\n", encoding="utf-8")
    Path(str(out) + ".json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    Path(str(out) + ".rows.json").write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    print("\n".join(md))


if __name__ == "__main__":
    main()
