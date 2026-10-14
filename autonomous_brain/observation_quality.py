"""Same-frame pixel support, separate from a physical identity or range model."""
from __future__ import annotations

import copy
from collections.abc import Mapping

SCHEMA = "red-component-quality/v1"
UNKNOWN_REASONS = {"red_sector_not_majority", "source_bbox_touches_boundary",
                   "component_not_uniquely_matched", "pixel_frame_unavailable",
                   "detection_frame_mismatch"}


def pixel_quality(item, frame_id):
    """Validate the optional public sensor extension; old sources stay old.

    The platform audit independently recomputes these counts from the bound
    original pixels. This validation cannot itself certify their provenance.
    """
    if "pixelQuality" not in item:
        return None
    q = item["pixelQuality"]
    if (item.get("category") != "red-ball" or item.get("source") != "virtual-cv"
            or not isinstance(q, Mapping)
            or set(q) != {"schema", "frameId", "componentPixels", "redSectorPixels", "status", "reason"}
            or q["schema"] != SCHEMA or type(q["frameId"]) is not int
            or q["frameId"] < 0 or str(q["frameId"]) != str(frame_id)):
        raise ValueError("pixel quality must be bound to this original red frame")
    total, red = q["componentPixels"], q["redSectorPixels"]
    measured = type(total) is int and type(red) is int and 0 <= red <= total <= 76800 and total > 0
    absent = total is None and red is None
    if not (measured or absent):
        raise ValueError("invalid pixel quality counts")
    box = item["bbox"]
    clipped = (box["x"] <= 0 or box["y"] <= 0 or box["x"] + box["w"] >= 640
               or box["y"] + box["h"] >= 480)
    if q["status"] == "supported":
        valid = measured and red * 2 > total and q["reason"] == "red_sector_majority" and not clipped
    elif q["status"] == "unknown":
        valid = q["reason"] in UNKNOWN_REASONS
        if q["reason"] == "red_sector_not_majority":
            valid = valid and measured and red * 2 <= total
        elif q["reason"] == "source_bbox_touches_boundary":
            valid = valid and measured and clipped
        else:
            valid = valid and absent
    else:
        valid = False
    if not valid:
        raise ValueError("pixel quality status conflicts with its evidence")
    return copy.deepcopy(dict(q))


def positive_pixel_support(item):
    """Unknown boxes remain competitors, but never positive witnesses."""
    if not isinstance(item, Mapping):
        return False
    key = "pixel_quality" if "pixel_quality" in item else "pixelQuality"
    if key not in item:
        return True  # Historical observations retain their original contract.
    q = item[key]
    return isinstance(q, Mapping) and q.get("schema") == SCHEMA and q.get("status") == "supported"
