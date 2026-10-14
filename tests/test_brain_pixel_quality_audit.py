"""Independent public quality joins; synthetic traces are not competition runs."""
import copy

import pytest

from brain_evidence_fixtures import task_fixture
from test_brain_discovery_lifecycle_audit import observed_trace
from test_brain_pending_grasp_audit import chain
from test_brain_perception import CAMERA, ball
from test_brain_recovery_discovery import publish, runtime
from tools.brain_evidence_audit import audit_observed_ledger, audit_unknown_discoveries


def quality(frame, supported=True):
    return {"schema": "red-component-quality/v1", "frameId": int(frame),
            "componentPixels": 100, "redSectorPixels": 90 if supported else 12,
            "status": "supported" if supported else "unknown",
            "reason": "red_sector_majority" if supported else "red_sector_not_majority"}


@pytest.fixture
def action_trace():
    r = chain(False)
    return ({"runtime_version": "autonomous-brain-runtime/v19",
             "action_evidence": r.perception.action_evidence(), "final_objects": r.perception.objects()},
            r.observations, r.rounds, r.bridge_records, r.records)


def synchronize_action_sources(data):
    summary, observations, rounds, bridge, _ = data
    by_frame = {str(row["observation"]["frameId"]): row for row in observations}
    for call in bridge:
        if call["request"]["method"] == "observe":
            fid = str(call["terminal"]["result"]["frameId"])
            call["terminal"]["result"] = copy.deepcopy(by_frame[fid]["observation"])
    # Keep repeated claims identical so mutations must fail the original-source
    # check, rather than merely disagreeing with another copy of the claim.
    for event in summary["action_evidence"]:
        chain_proof = event.get("evidence", {}).get("grasp_chain")
        if not chain_proof:
            continue
        source = observations[chain_proof["grab"]["before_observation"] - 1]
        chain_proof["grab"]["authorization"]["detections"] = copy.deepcopy(source["perception"]["detections"])
        for decision in rounds:
            evidence = decision["result"]["evidence"]
            if "grasp_confirmation" in evidence:
                evidence["grasp_confirmation"] = copy.deepcopy(chain_proof)


def set_quality(row, index=0, *, supported=True):
    q = quality(row["observation"]["frameId"], supported)
    row["observation"]["detections"][index]["pixelQuality"] = copy.deepcopy(q)
    row["perception"]["detections"][index]["pixel_quality"] = copy.deepcopy(q)


def grab_source(data):
    proof = data[0]["action_evidence"][0]["evidence"]["grasp_chain"]
    return data[1][proof["grab"]["before_observation"] - 1]


def place_source(data):
    place = next(event for event in data[0]["action_evidence"] if event["action"] == "place")
    return data[1][place["evidence"]["post_observation"] - 1]


def test_supported_quality_keeps_existing_authorized_grab_and_delivery_contract(action_trace):
    set_quality(grab_source(action_trace))
    set_quality(place_source(action_trace))
    synchronize_action_sources(action_trace)
    audit = audit_observed_ledger(*action_trace)
    assert audit["failures"] == []
    assert audit["runtime_evidence_capability"]["contract"] == "authorized_command_chain"
    assert audit["picks"][0]["verified"] and audit["deliveries"][0]["verified"]


@pytest.mark.parametrize("fault", ["wrong-frame", "bool-count", "too-many", "minority-supported",
    "unknown-schema", "extra-key", "missing-count", "supported-clipped", "false-clipped", "measured-unavailable"])
def test_raw_quality_arithmetic_frame_and_schema_cannot_authorize_grab(action_trace, fault):
    source = grab_source(action_trace)
    set_quality(source)
    raw = source["observation"]["detections"][0]
    q = raw["pixelQuality"]
    if fault == "wrong-frame": q["frameId"] += 1
    elif fault == "bool-count": q["redSectorPixels"] = True
    elif fault == "too-many": q.update(componentPixels=76801, redSectorPixels=76801)
    elif fault == "minority-supported": q["redSectorPixels"] = 40
    elif fault == "unknown-schema": q["schema"] = "red-component-quality/v999"
    elif fault == "extra-key": q["physicalId"] = "not-allowed"
    elif fault == "missing-count": q["componentPixels"] = None
    elif fault == "supported-clipped": raw["bbox"]["x"] = 0
    elif fault == "false-clipped": q.update(status="unknown", reason="source_bbox_touches_boundary")
    else: q.update(status="unknown", reason="pixel_frame_unavailable")
    source["perception"]["detections"][0]["pixel_quality"] = copy.deepcopy(q)
    synchronize_action_sources(action_trace)
    audit = audit_observed_ledger(*action_trace)
    assert "pixel_quality_original_evidence_invalid" in audit["failures"]
    assert not audit["picks"][0]["verified"]


@pytest.mark.parametrize("fault", ["stripped", "changed", "invented"])
def test_conversion_cannot_strip_replace_or_invent_quality(action_trace, fault):
    source = grab_source(action_trace)
    set_quality(source)
    item = source["perception"]["detections"][0]
    if fault == "stripped": item.pop("pixel_quality")
    elif fault == "changed": item["pixel_quality"]["redSectorPixels"] = 99
    else: source["observation"]["detections"][0].pop("pixelQuality")
    synchronize_action_sources(action_trace)
    audit = audit_observed_ledger(*action_trace)
    assert "pixel_quality_conversion_not_preserved" in audit["failures"]
    assert not audit["picks"][0]["verified"]


def test_current_unknown_cannot_authorize_actual_grab_even_with_consistent_claims(action_trace):
    source = grab_source(action_trace)
    set_quality(source, supported=False)
    synchronize_action_sources(action_trace)
    audit = audit_observed_ledger(*action_trace)
    assert "pixel_quality_unknown_positive_identity" in audit["failures"]
    assert not audit["picks"][0]["verified"]
    assert not audit["deliveries"][0]["verified"]


def test_sole_unknown_release_box_remains_candidate_but_cannot_witness_delivery(action_trace):
    source = place_source(action_trace)
    set_quality(source, supported=False)
    item = source["perception"]["detections"][0]
    item.update(track_id=None, fed_to_world_model=False)
    synchronize_action_sources(action_trace)
    audit = audit_observed_ledger(*action_trace)
    assert audit["picks"][0]["verified"]
    assert audit["deliveries"][0]["geometric_candidates"] == 1
    assert not audit["deliveries"][0]["verified"]


@pytest.mark.parametrize("fake_old_label", [False, True])
def test_unknown_competitor_cannot_be_filtered_from_release_uniqueness(action_trace, fake_old_label):
    source = place_source(action_trace)
    raw = copy.deepcopy(source["observation"]["detections"][0])
    item = copy.deepcopy(source["perception"]["detections"][0])
    raw["bbox"]["x"] += 1
    item["bbox"] = copy.deepcopy(raw["bbox"])
    raw["pixelQuality"] = quality(source["observation"]["frameId"], False)
    item.update(pixel_quality=copy.deepcopy(raw["pixelQuality"]), track_id=None, fed_to_world_model=False)
    if fake_old_label: item["known_delivered_object_id"] = "fabricated-old-object"
    source["observation"]["detections"].append(raw)
    source["perception"]["detections"].append(item)
    synchronize_action_sources(action_trace)
    audit = audit_observed_ledger(*action_trace)
    assert audit["deliveries"][0]["geometric_candidates"] == 2
    assert not audit["deliveries"][0]["verified"]


def annotate_discovery_frame(data, fid, *, supported=True):
    summary, observations, _, _ = data
    source = next(row for row in observations if str(row["observation"]["frameId"]) == str(fid))
    set_quality(source, supported=supported)
    for ledger in [summary["discovery_evidence"]] + [row["discovery_evidence"] for row in observations]:
        for record in ledger["records"]:
            if record["frame_id"] == str(fid):
                record["pixel_quality"] = quality(fid, supported)


def test_supported_discovery_extension_preserves_independent_resolution():
    data = observed_trace()
    for row in data[1]: annotate_discovery_frame(data, row["observation"]["frameId"])
    assert audit_unknown_discoveries(*data)["failures"] == []


@pytest.mark.parametrize("role", ["source", "support"])
def test_unknown_discovery_cannot_be_used_as_resolution_source_or_support(role):
    data = observed_trace()
    resolution = data[0]["discovery_evidence"]["resolutions"][0]
    ref = resolution["source_ref"] if role == "source" else resolution["support_refs"][0]
    record = next(r for r in data[0]["discovery_evidence"]["records"] if r["id"] == ref)
    annotate_discovery_frame(data, record["frame_id"], supported=False)
    audit = audit_unknown_discoveries(*data)
    assert "discovery_resolution_not_independently_verified" in audit["failures"]
    assert "discovery_hypothesis_association_invalid" in audit["failures"]
    assert audit["evidence"]["resolutions"] == []


def test_discovery_record_cannot_strip_original_quality():
    data = observed_trace()
    annotate_discovery_frame(data, 1)
    data[0]["discovery_evidence"]["records"][0].pop("pixel_quality")
    assert "discovery_v2_original_record_mismatch" in audit_unknown_discoveries(*data)["failures"]


def test_real_unknown_discovery_is_preserved_unassociated_and_unresolved():
    r = runtime()
    d = ball(95); d["pixelQuality"] = quality(1, False)
    publish(r, items=[d])
    for frame, forward in ((2, 16), (3, 32), (4, 48)):
        d = ball(95-forward); d["pixelQuality"] = quality(frame)
        publish(r, items=[d], forward=forward)
    summary = {"runtime_version": "autonomous-brain-runtime/v19", "action_evidence": [],
               "final_objects": r.perception.objects(), "discovery_evidence": r.perception.discovery_evidence()}
    bridge = [{"request": {"method": "camera_parameters"}, "terminal": {"status": "completed", "result": CAMERA}}]
    audit = audit_unknown_discoveries(summary, r.trace, bridge, [])
    assert audit["failures"] == ["discovery_historical_obligations_unresolved"]
    assert len(audit["evidence"]["unresolved"]) == 1
    assert audit["evidence"]["unresolved"][0]["pixel_quality"]["status"] == "unknown"
    assert not audit["evidence"]["resolutions"]
    assert not summary["discovery_evidence"]["associations"]


def test_unknown_same_frame_competitor_cannot_be_removed_from_resolution_matrix():
    r = runtime()
    good, unknown = ball(95), ball(95)
    good["pixelQuality"], unknown["pixelQuality"] = quality(1), quality(1, False)
    unknown["bbox"]["x"] += 30
    publish(r, items=[good, unknown])
    for frame, forward in ((2, 16), (3, 32), (4, 48)):
        d = ball(95-forward); d["pixelQuality"] = quality(frame)
        publish(r, items=[d], forward=forward)
    summary = {"runtime_version": "autonomous-brain-runtime/v19", "action_evidence": [],
               "final_objects": r.perception.objects(), "discovery_evidence": r.perception.discovery_evidence()}
    bridge = [{"request": {"method": "camera_parameters"}, "terminal": {"status": "completed", "result": CAMERA}}]
    control = audit_unknown_discoveries(summary, r.trace, bridge, [])
    assert control["failures"] == ["discovery_historical_obligations_unresolved"]
    assert len(control["evidence"]["unresolved"]) == 2
    forged = copy.deepcopy(observed_trace()[0]["discovery_evidence"]["resolutions"][0])
    forged["support_refs"] = ["red-discovery-" + str(int(ref.rsplit("-", 1)[1]) + 1)
                              for ref in forged["support_refs"]]
    forged["opposing_refs"] = ["red-discovery-2"]
    forged["candidate_matrix"]["red-discovery-2"] = []
    for ledger in (summary["discovery_evidence"], r.trace[-1]["discovery_evidence"]):
        ledger["resolutions"] = [copy.deepcopy(forged)]
        ledger["unresolved"] = [record for record in ledger["unresolved"] if record["id"] != "red-discovery-1"]
    audit = audit_unknown_discoveries(summary, r.trace, bridge, [])
    assert "discovery_resolution_not_independently_verified" in audit["failures"]
    assert audit["evidence"]["resolutions"] == []


def test_unknown_after_two_deliveries_does_not_invalidate_independent_delivery_evidence():
    summary, observations, rounds, _, bridge, motions = task_fixture()
    source = observations[-1]
    raw = ball(80); raw["pixelQuality"] = quality(source["observation"]["frameId"], False)
    item = {"category": "red-ball", "bbox": copy.deepcopy(raw["bbox"]), "position_m": {"x": 0, "z": .8},
            "frame_id": str(source["observation"]["frameId"]), "track_id": None, "fed_to_world_model": False,
            "pixel_quality": copy.deepcopy(raw["pixelQuality"])}
    source["observation"]["detections"].append(raw)
    source["perception"]["detections"].append(item)
    data = summary, observations, rounds, bridge, motions
    synchronize_action_sources(data)
    audit = audit_observed_ledger(*data)
    assert audit["failures"] == []
    assert len(audit["deliveries"]) == 2 and all(row["verified"] for row in audit["deliveries"])
