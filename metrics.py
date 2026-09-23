"""离线与在环共用的统计聚合函数。

本模块只使用标准库，百分位实现与 numpy.percentile 默认 ``linear`` 插值一致。
所有聚合函数显式接收 confirmed / matched 两套数组，避免调用方靠变量名就近取值。
"""
from __future__ import annotations

import math
import statistics
from typing import Iterable, List, Optional, Sequence


def percentile_linear(values: Iterable[float], q: float) -> Optional[float]:
    """返回百分位，n=0 返回 None，n>=1 使用 linear 插值。

    q 使用 0-100 语义，例如 q=90 表示 P90。
    """
    if q < 0.0 or q > 100.0:
        raise ValueError("q must be in [0, 100]")
    ordered = sorted(float(v) for v in values if v is not None and math.isfinite(float(v)))
    n = len(ordered)
    if n == 0:
        return None
    if n == 1:
        return float(ordered[0])
    k = (n - 1) * (q / 100.0)
    lower = int(math.floor(k))
    upper = int(math.ceil(k))
    if lower == upper:
        return float(ordered[lower])
    result = ordered[lower] + (ordered[upper] - ordered[lower]) * (k - lower)
    if not math.isfinite(result):
        raise ValueError("percentile result is not finite")
    return float(result)


def _assert_invariants(label: str, values: Sequence[float], median: Optional[float], p90: Optional[float]) -> None:
    if not values:
        return
    maximum = max(values)
    minimum = min(values)
    if median is None or p90 is None:
        raise AssertionError(f"{label}: median/p90 must not be None for n>0")
    if not (minimum <= median <= p90 <= maximum):
        raise AssertionError(
            f"{label}: invariant min <= median <= p90 <= max violated: "
            f"min={minimum}, median={median}, p90={p90}, max={maximum}"
        )


def summarize_errors(label: str, errors: Iterable[float]) -> dict:
    """对一组误差数组返回 median/p90/n；n=0 时三项均为 None。"""
    values: List[float] = [
        float(v) for v in errors
        if v is not None and math.isfinite(float(v)) and float(v) >= 0.0
    ]
    if not values:
        return {"n": 0, "median": None, "p90": None}
    median = float(statistics.median(values))
    p90 = percentile_linear(values, 90.0)
    _assert_invariants(label, values, median, p90)
    return {"n": len(values), "median": median, "p90": p90}


def summarize_localization(confirmed_errors: Iterable[float], matched_errors: Iterable[float]) -> dict:
    """分别聚合全体 confirmed 与 matched 轨迹误差，并做不变量断言。"""
    confirmed = summarize_errors("confirmed", confirmed_errors)
    matched = summarize_errors("matched", matched_errors)
    return {
        "n_confirmed_tracks": confirmed["n"],
        "median_cm": confirmed["median"],
        "p90_cm": confirmed["p90"],
        "matched_tracks": matched["n"],
        "matched_median_cm": matched["median"],
        "matched_p90_cm": matched["p90"],
    }


__all__ = ["percentile_linear", "summarize_errors", "summarize_localization"]
