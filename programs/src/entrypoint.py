try:
    run_target_flow()
except MissionFailure as failure:
    _finish_flow(False, "constraint", str(failure))
