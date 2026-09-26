import copy

from tools.brain_evidence_audit import audit_unknown_discoveries


def discovery_fixture():
    bbox={"x":1,"y":2,"w":3,"h":4}
    ambiguity={"reason":"joint_identity_candidates_not_unique","candidate_ids":["old","new"]}
    det={"category":"red-ball","bbox":bbox,"track_id":None,"fed_to_world_model":False,
         "identity_ambiguity":ambiguity,"reason":"range_too_close"}
    evidence={"id":"display-id","category":"red-ball","frame_id":"first","observation_index":1,
        "tick":10,"round":1,"simulation_time_s":.2,"detection_index":0,"bbox":copy.deepcopy(bbox),
        "candidate_ids":["old","new"],"identity_ambiguity":copy.deepcopy(ambiguity),
        "reason":"joint_identity_candidates_not_unique","admission_reason":"range_too_close"}
    ledger={"schema":"brain-discovery-evidence/v1","unresolved":[evidence]}
    observations=[{"observation_index":1,"round":1,"simulation_seconds":.2,
        "observation":{"frameId":"first","tick":10,"detections":[{"category":"red-ball","bbox":copy.deepcopy(bbox)}]},
        "perception":{"detections":[det]},"discovery_evidence":copy.deepcopy(ledger)},
        {"observation_index":2,"round":2,"simulation_seconds":.4,
         "observation":{"frameId":"empty","tick":20,"detections":[]},"perception":{"detections":[]},
         "discovery_evidence":copy.deepcopy(ledger)}]
    return {"discovery_evidence":copy.deepcopy(ledger)},observations


def test_empty_current_view_does_not_erase_prior_untracked_ambiguity():
    s,o=discovery_fixture()
    r=audit_unknown_discoveries(s,o)
    assert r["failures"]==["discovery_historical_ambiguities_unresolved"]
    assert len(r["evidence"]["unresolved"])==1


def test_empty_discovery_history_is_a_positive_control():
    s,o=discovery_fixture()
    s["discovery_evidence"]["unresolved"]=[]
    for row in o:
        row["observation"]["detections"]=[];row["perception"]["detections"]=[]
        row["discovery_evidence"]["unresolved"]=[]
    assert audit_unknown_discoveries(s,o)["failures"]==[]


def test_current_and_summary_empty_ledgers_cannot_drop_original_conflict():
    s,o=discovery_fixture()
    s["discovery_evidence"]["unresolved"]=[]
    o[-1]["discovery_evidence"]["unresolved"]=[]
    failures=audit_unknown_discoveries(s,o)["failures"]
    assert "discovery_final_ledger_mismatch" in failures
    assert "discovery_observation_ledger_mismatch" in failures


def test_deleted_conversion_cannot_remove_raw_original_red_box():
    s,o=discovery_fixture()
    o[0]["perception"]["detections"]=[]
    assert "discovery_raw_red_detection_not_corroborated" in audit_unknown_discoveries(s,o)["failures"]


def test_fed_flag_and_display_id_cannot_remove_untracked_conflict():
    s,o=discovery_fixture()
    o[0]["perception"]["detections"][0]["fed_to_world_model"]=True
    s["discovery_evidence"]["unresolved"][0]["id"]="renamed"
    assert audit_unknown_discoveries(s,o)["failures"]==["discovery_historical_ambiguities_unresolved"]


def test_changed_bbox_or_duplicate_original_key_is_rejected():
    s,o=discovery_fixture()
    s["discovery_evidence"]["unresolved"].append(copy.deepcopy(s["discovery_evidence"]["unresolved"][0]))
    assert "discovery_final_ledger_mismatch" in audit_unknown_discoveries(s,o)["failures"]
    s,o=discovery_fixture()
    s["discovery_evidence"]["unresolved"][0]["bbox"]["x"]+=1
    assert "discovery_final_ledger_mismatch" in audit_unknown_discoveries(s,o)["failures"]
