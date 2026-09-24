"""Counterexamples for precise distance attribution in optimization reporting."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from opt_report import odometer_at


def entry(seq, tick, distance):
    return {"method": "odometry", "seq": seq, "tick": tick, "result": {"distanceCm": distance}}


def test_exact_sample_selected_over_nearby_motion():
    assert odometer_at([entry(1, 10, 2), entry(2, 11, 3), entry(3, 12, 4)], 11)["value_cm"] == 3


def test_motion_bracket_never_interpolated_or_called_exact():
    assert odometer_at([entry(1, 10, 2), entry(2, 12, 4)], 11)["value_cm"] is None


def test_stationary_cumulative_distance_carries_provenance():
    value = odometer_at([entry(1, 10, 2), entry(2, 12, 2)], 11)
    assert value["value_cm"] == 2
    assert value["basis"] == "identical_cumulative_distance_brackets"
    assert value["bracket_ticks"] == [10, 12]


def test_one_sided_pose_does_not_prove_event_distance():
    assert odometer_at([entry(1, 10, 2)], 11)["value_cm"] is None
