#!/usr/bin/env python3
"""Offline one-ball map-05 wiring demonstration; never stage-1 acceptance.

Uses the formal evaluator's same source, raw observation/command-chain, identity,
gripper, model done and budget checks. Only the explicitly named smoke goal is one
physical delivery; the original map retains both red targets.
"""
from evaluate_autonomous_brain import main


if __name__ == "__main__":
    raise SystemExit(main(one_ball_smoke=True))
