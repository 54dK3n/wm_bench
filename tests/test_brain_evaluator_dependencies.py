"""New formal provenance cannot omit or silently swap independent audits."""
import copy

import pytest

from test_brain_stage1_source_proof import formal_proof, verdict
from test_brain_evaluation import fixture_data


@pytest.fixture(params=["wm-autonomous-brain-driver/v8","wm-autonomous-brain-driver/v9"])
def v8_proof(formal_proof, request):
    data = formal_proof
    manifest = data["source_manifest"]
    manifest["version"] = request.param
    manifest["brain"]["autonomous_brain/road_evidence.py"] = "5" * 64
    data["summary"]["source_sha256"]["road_evidence.py"] = "5" * 64
    manifest["evaluatorDependencies"] = {
        "tools/brain_evidence_audit.py": "1" * 64,
        "tools/replay_brain_llm.py": "2" * 64,
        "tools/brain_topology_audit.py": "4" * 64,
    }
    data["driver_summary"]["schema"] = manifest["version"]
    data["driver_summary"]["sourceManifestAfterRun"] = copy.deepcopy(manifest)
    return data


def test_v8_requires_independent_evaluator_dependencies(v8_proof):
    assert verdict(v8_proof)["status"] == "verified"


@pytest.mark.parametrize("missing", [None, "tools/brain_evidence_audit.py", "tools/replay_brain_llm.py",
                                    "tools/brain_topology_audit.py"])
def test_missing_audit_hashes_fail_even_when_before_after_agree(v8_proof, missing):
    manifest = v8_proof["source_manifest"]
    if missing is None:
        manifest.pop("evaluatorDependencies")
    else:
        manifest["evaluatorDependencies"].pop(missing)
    v8_proof["driver_summary"]["sourceManifestAfterRun"] = copy.deepcopy(manifest)
    assert verdict(v8_proof)["status"] == "invalid"


def test_changed_audit_during_run_is_a_source_mismatch(v8_proof):
    v8_proof["driver_summary"]["sourceManifestAfterRun"]["evaluatorDependencies"][
        "tools/brain_evidence_audit.py"] = "3" * 64
    assert "source_proof_before_after_mismatch" in verdict(v8_proof)["failures"]


def test_v8_cannot_omit_semantic_road_memory_even_with_matching_export_hashes(v8_proof):
    manifest = v8_proof["source_manifest"]
    manifest["brain"].pop("autonomous_brain/road_evidence.py")
    v8_proof["summary"]["source_sha256"].pop("road_evidence.py")
    v8_proof["driver_summary"]["sourceManifestAfterRun"] = copy.deepcopy(manifest)
    assert verdict(v8_proof)["status"] == "invalid"


def test_v8_preserves_actual_dependency_and_configuration_checks(v8_proof):
    v8_proof["summary"]["formal_configuration"]["temperature"] = 0.6
    assert "source_proof_formal_configuration_mismatch" in verdict(v8_proof)["failures"]
