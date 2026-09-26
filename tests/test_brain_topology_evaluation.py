"""Independent stage-two acceptance; all inputs are fixed synthetic logs."""
import copy

import pytest

from brain_topology_fixtures import line_fixture, recorroborate, use_real_brain_evidence, triangle_fixture, nonroad_return_fixture
from tools.brain_topology_audit import audit_topology, truth_graph, native_context, js_round


def run(data):
    return audit_topology(*data)


@pytest.mark.parametrize("one_way", [False, True])
def test_actual_complete_directed_traversals_pass_including_terminal_without_exits(one_way):
    r=run(line_fixture(one_way))
    assert r["complete"], r
    assert (r["brain_node_count"],r["true_node_count"],r["node_ratio"]) == (2,2,1)
    assert r["verified_traversal_count"] == (1 if one_way else 2)


def test_real_brain_semantic_evidence_is_independently_checkable():
    r=run(use_real_brain_evidence(line_fixture()))
    assert r["complete"],r


def test_real_brain_three_road_ring_returns_via_different_exit_and_covers_whole_graph():
    r=run(triangle_fixture())
    assert r["complete"],r
    assert r["brain_node_count"]==r["true_node_count"]==3
    assert r["verified_traversal_count"]==3


def test_observed_nonroad_return_resolves_identity_gap_without_adding_road_edge():
    r=run(nonroad_return_fixture())
    assert r["complete"],r
    assert r["verified_traversal_count"]==2


def test_forged_nonroad_return_cannot_use_accepted_backward_with_wrong_distance():
    data=nonroad_return_fixture()
    data[2][-2]["params"]["distanceCm"]=5
    recorroborate(data)
    r=run(data)
    assert not r["complete"] and "topology_alias_merge_evidence_invalid" in r["failures"]


def test_same_endpoint_different_parking_position_needs_actual_known_route_revisit():
    data=line_fixture()
    for index in (5,6):
        data[1][index]["odometry"].update(forwardCm=4,distanceCm=196)
        data[3]["native"]["samples"][index]["z"]=-.04
        data[5][index]["robotWorldPose"]["z"]=-.04
    recorroborate(data)
    use_real_brain_evidence(data)
    r=run(data)
    assert r["complete"],r
    assert any(p["kind"]=="route_endpoint_revisit" for n in data[0]["road_evidence"]["nodes"] for p in n["merge_evidence_refs"])
    # Removing the old completed route's support must preserve the hypothesis.
    for n in data[0]["road_evidence"]["nodes"]:
        for p in n["merge_evidence_refs"]:
            if p["kind"]=="route_endpoint_revisit": p["traversal_ids"]=[]
    assert "topology_alias_merge_evidence_invalid" in run(data)["failures"]


@pytest.mark.parametrize("state",["unexplored","exploring","blocked","unresolved"])
def test_pending_states_cannot_be_hidden_by_complete_true(state):
    data=line_fixture()
    data[0]["road_evidence"]["exits"][0]["state"]=state
    r=run(data)
    assert not r["complete"] and "topology_exit_pending" in r["failures"]


def test_complete_bool_and_zeroed_counters_are_not_traversal_evidence():
    data=line_fixture()
    data[0]["road_evidence"]["traversals"]=[]
    r=run(data)
    assert "topology_native_directed_exits_unexplored" in r["failures"]


def test_actual_turn_angle_is_checked_even_with_forged_bridge_outcome():
    data=line_fixture()
    data[2][2]["params"]["angleDeg"]=90
    recorroborate(data)
    r=run(data)
    assert "topology_alias_merge_evidence_invalid" in r["failures"]


def test_forward_command_that_only_moved_sideways_is_not_connection():
    data=line_fixture()
    data[2][1].update(method="forward",params={"distanceCm":5},actuator_result={"completed":True})
    recorroborate(data)
    r=run(data)
    assert "topology_basic_translation_effect_not_observed" in r["failures"]


@pytest.mark.parametrize("reason",["collision","front_clearance","wrong_way","off_road"])
def test_blocked_movement_is_not_a_completed_connection(reason):
    data=line_fixture()
    data[2][0]["actuator_result"]["stoppedBy"]=reason
    recorroborate(data)
    assert "topology_actuator_outcome_invalid" in run(data)["failures"]


def test_accepted_command_without_actual_travel_cannot_complete():
    data=line_fixture()
    data[1][1]["odometry"]=copy.deepcopy(data[1][0]["odometry"])
    data[1][1]["odometry"]["tick"]=2
    recorroborate(data)
    assert "topology_translation_not_observed" in run(data)["failures"]


def test_motion_bridge_tampering_is_rejected():
    data=line_fixture()
    data[2][0]["params"]["angleDeg"]=90
    assert "topology_motion_not_corroborated_by_bridge" in run(data)["failures"]


def test_wrong_fresh_exit_even_when_bridge_also_forged_is_rejected():
    data=line_fixture()
    data[2][0]["params"]["angleDeg"]=90
    recorroborate(data)
    assert "topology_fresh_departure_selection_missing" in run(data)["failures"]


def test_reverse_availability_never_counts_as_actual_reverse_traversal():
    data=line_fixture()
    data[0]["road_evidence"]["traversals"][1]["reverse_availability_only"]=True
    assert "topology_traversal_does_not_cover_selected_road" in run(data)["failures"]


@pytest.mark.parametrize("field",["observation_index","frame"])
def test_duplicate_observation_or_frame_rejected(field):
    data=line_fixture()
    if field=="observation_index": data[1][1][field]=1
    else: data[1][1]["observation"]["frameId"]=data[1][0]["observation"]["frameId"]
    assert not run(data)["complete"]


def test_missing_middle_observation_rejected():
    data=line_fixture()
    del data[1][1]
    r=run(data)
    assert "topology_observation_sequence_incomplete" in r["failures"]


def test_missing_motion_reference_cannot_be_replaced_by_good_endpoints():
    data=line_fixture()
    data[0]["road_evidence"]["traversals"][0]["motion_refs"].pop()
    assert "topology_motion_references_mismatch" in run(data)["failures"]


def test_sparse_native_samples_are_allowed_with_exact_capture_poses():
    data=line_fixture()
    data[3]["native"]["samples"].pop(1)
    assert run(data)["complete"]


@pytest.mark.parametrize("fault",["missing","duplicate","tick","pose","origin"])
def test_capture_frame_pose_join_rejects_missing_duplicate_conflicting_sources(fault):
    data=line_fixture()
    if fault=="missing": data[5].pop(1)
    if fault=="duplicate": data[5].append(copy.deepcopy(data[5][1]))
    if fault=="tick": data[5][1]["tick"]+=1
    if fault=="pose": data[5][1]["robotWorldPose"]["x"]+=1
    if fault=="origin": data[5][1]["odometryOrigin"]["x"]+=1
    assert not run(data)["complete"]


def test_exact_capture_boundary_does_not_inherit_rounded_sample_error():
    data=line_fixture(True)
    # The full precision point is within the native 10 cm endpoint radius.
    # Its rounded sample lies 0.0000004 world units farther out.
    data[5][0]["robotWorldPose"]["z"]=-.0999996
    data[5][0]["odometryOrigin"]["z"]=-.0999996
    for c in data[5][1:]: c["odometryOrigin"]["z"]=-.0999996
    data[3]["native"]["samples"][0]["z"]=-.1
    for index,o in enumerate(data[1]):
        o["odometry"]["forwardCm"]=[0,40,90][index]
    for a in data[0]["road_evidence"]["anchors"]:
        a["position_m"]=[0,data[1][a["observation_index"]-1]["odometry"]["forwardCm"]/100]
    recorroborate(data)
    assert run(data)["complete"]


def test_interior_native_path_leaves_road_despite_valid_endpoint_observations():
    data=line_fixture()
    data[3]["native"]["samples"].append({"tick":1.5,"x":2,"z":-.3,"heading":0})
    assert "topology_traversal_left_selected_native_road" in run(data)["failures"]


def test_conflicting_native_pose_at_same_tick_rejected():
    data=line_fixture()
    data[3]["native"]["samples"].append({"tick":2,"x":2,"z":-.5,"heading":0})
    assert "topology_native_sample_capture_pose_conflict" in run(data)["failures"]


def test_unvisited_disconnected_roads_are_in_whole_map_denominator_and_fail_coverage():
    data=line_fixture()
    data[3]["native"]["ruleDefinition"]["roads"].append({"id":"hidden","points":[[10,0],[10,-1]],"width":.2})
    r=run(data)
    assert r["node_ratio"]==.5 and r["true_node_count"]==4
    assert len(r["missing_nodes"])==2 and not r["complete"]


def test_false_merge_cannot_pass_by_lowering_ratio():
    data=line_fixture()
    ev=data[0]["road_evidence"]
    ev["nodes"][1]["canonical_id"]="A"
    ev["nodes"][1]["status"]="alias"
    r=run(data)
    assert "topology_false_node_merge" in r["failures"] and not r["complete"]


def test_nearby_different_true_nodes_are_not_merged_by_radius():
    data=line_fixture()
    data[3]["native"]["ruleDefinition"]["roads"].append({"id":"nearby","points":[[.001,0],[.001,-1]],"width":.0001})
    r=run(data)
    assert len(r["missing_nodes"])==2 and not r["complete"]


def test_unproved_alias_is_counted_and_fails():
    data=line_fixture()
    data[0]["road_evidence"]["nodes"][2]["merge_evidence_refs"]=[]
    r=run(data)
    assert r["brain_node_count"]==3 and r["node_ratio"]==1.5
    assert "topology_alias_merge_evidence_invalid" in r["failures"]


def test_changed_anchor_pose_or_exit_refs_fail_public_join():
    data=line_fixture()
    data[0]["road_evidence"]["anchors"][0]["position_m"]=[9,9]
    data[0]["road_evidence"]["exits"][0]["observation_refs"]=[]
    r=run(data)
    assert "topology_anchor_pose_not_corroborated" in r["failures"]
    assert "topology_exit_observation_references_invalid" in r["failures"]


def test_resolved_history_is_retained_but_requires_actual_resolution_reference():
    data=line_fixture()
    history={"id":"old-attempt","kind":"connection","resolved":True,"exit_id":"A-exit","resolution_traversal_id":"T1"}
    data[0]["road_evidence"]["unresolved"]=[history]
    assert run(data)["complete"]
    history["resolution_traversal_id"]="nonexistent"
    assert "topology_unresolved_claims_remain" in run(data)["failures"]


def test_all_endpoint_degrees_count_curved_interior_points_do_not():
    data=line_fixture()
    roads=data[3]["native"]["ruleDefinition"]["roads"]
    roads[0]["points"]=[[0,0],[.3,-.2],[.2,-.7],[0,-1]]
    roads.extend([{"id":"next","points":[[0,-1],[0,-2]],"width":.2},
                  {"id":"branch","points":[[0,-1],[1,-1]],"width":.2}])
    graph=truth_graph(data[3]["native"])
    assert len(graph["nodes"])==4
    assert sorted(len(n["endpoints"]) for n in graph["nodes"].values())==[1,1,1,3]
    roads.pop()
    graph=truth_graph(data[3]["native"])
    assert len(graph["nodes"])==3
    assert sorted(len(n["endpoints"]) for n in graph["nodes"].values())==[1,1,2]


def test_js_rounding_differs_from_bankers_rounding_and_preserves_whole_graph():
    assert js_round(-.0000005)==0 and js_round(.0000005)==.000001
    data=line_fixture()
    data[3]["native"]["ruleDefinition"]["roads"].append({"id":"next","points":[[0,-1.00000049],[0,-2]],"width":.2})
    assert len(truth_graph(data[3]["native"])["nodes"])==3


@pytest.mark.parametrize("mutation",["unsupported","selfloop","missing-road-evidence","malformed"])
def test_unsupported_or_missing_sources_fail_explicitly(mutation):
    data=line_fixture()
    if mutation=="unsupported": data[3]["native"]["navigationDefinition"]["schemaVersion"]="new-contract"
    if mutation=="selfloop": data[3]["native"]["ruleDefinition"]["roads"][0]["points"]=[[0,0],[1,1],[0,0]]
    if mutation=="missing-road-evidence": del data[0]["road_evidence"]
    if mutation=="malformed": data[0]["road_evidence"]["nodes"]=None
    r=run(data)
    assert not r["complete"] and r["failures"]
