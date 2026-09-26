"""New formal proof must include actual sources, fixed settings, and limits."""
import copy
import hashlib
import json

import pytest

from test_brain_evaluation import evaluation, fixture_data


@pytest.fixture
def formal_proof(fixture_data):
    data = fixture_data
    manifest = data["source_manifest"]
    manifest["version"] = "wm-autonomous-brain-driver/v7"
    manifest["brain"] = {"autonomous_brain/" + name + ".py": "a" * 64 for name in (
        "__init__", "run", "actions", "bridge", "llm", "navigation", "navigation_progress",
        "perception", "task", "provenance")}
    data["summary"]["source_sha256"] = {key.split("/")[-1]: val for key, val in manifest["brain"].items()}
    files = {"world_model/__init__.py": "e" * 64}
    wm = {"schema": "autonomous-brain-world-model-provenance/v1",
          "configured_root": "/synthetic/worldmodel", "loaded_package": "/synthetic/worldmodel/world_model",
          "declared_version": None, "version_basis": "actual_source_tree_sha256", "files": files,
          "selection": "WORLD_MODEL_ROOT",
          "source_tree_sha256": hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
          "loaded_modules": {"world_model": {"path": "/synthetic/worldmodel/world_model/__init__.py", "sha256": "e" * 64}},
          "python": {"executable": "/synthetic/python", "version": "test"}}
    manifest.update(worldModel=wm, platformRoot="/synthetic/platform",
        platformRuntimeSources={name: "c" * 64 for name in (
            "competition-core.js", "server.js", "index.html", "app.js", "robot-bridge-contract.js",
            "robot-backend-runtime.js", "robot-camera-detector.js", "backend/robot-bridge.js",
            "vision-pixel-core.js", "vendor/three/three.min.js")},
        runtime={"node": "synthetic-node", "nodeExecutable": "/synthetic/node"},
        dependencyLock={"file": "vendor/worldmodel.lock.json", "sha256": "f" * 64},
        evaluator={"file": "tools/evaluate_autonomous_brain.py", "sha256": "f" * 64},
        modelConfiguration={"model": "deepseek-flash", "temperature": 0, "thinking": "disabled",
            "stream": True, "response_format": {"type": "json_object"}, "formal_run": True},
        runConfiguration={"task": "把两个红球送到绿色存放区", "maxRounds": 200,
            "maxSimulationSeconds": 1200, "wallTimeoutSeconds": 0})
    data["summary"].update(world_model={key: value for key, value in wm.items() if key != "selection"},
        formal_configuration={**manifest["modelConfiguration"], "mode": "live"},
        task=manifest["runConfiguration"]["task"], limits={"max_rounds": 200, "max_simulation_seconds": 1200})
    data["driver_summary"].update(schema=manifest["version"], **manifest["runConfiguration"])
    data["driver_summary"]["sourceManifestAfterRun"] = copy.deepcopy(manifest)
    return data


def verdict(data):
    return evaluation.evaluate_source_proof(data["source_manifest"], data["driver_summary"], data["summary"])


def test_complete_new_proof_matches_without_consulting_current_sources(formal_proof):
    assert verdict(formal_proof)["status"] == "verified"


@pytest.mark.parametrize("field", ["worldModel", "modelConfiguration", "runConfiguration",
    "platformRuntimeSources", "platformRoot", "runtime", "dependencyLock", "evaluator"])
def test_missing_new_manifest_field_rejected_even_when_before_after_agree(formal_proof, field):
    formal_proof["source_manifest"].pop(field)
    formal_proof["driver_summary"]["sourceManifestAfterRun"].pop(field)
    assert verdict(formal_proof)["status"] == "invalid"


@pytest.mark.parametrize("target,field,value", [
    ("summary", "task", "把地图上的红球都送到绿色存放区"),
    ("summary", "limits", {"max_rounds": 201, "max_simulation_seconds": 1200}),
    ("driver_summary", "maxRounds", 201),
    ("driver_summary", "maxSimulationSeconds", 1201),
    ("driver_summary", "wallTimeoutSeconds", 7200),
])
def test_task_and_limits_must_match_actual_child_and_driver(formal_proof, target, field, value):
    formal_proof[target][field] = value
    assert "source_proof_task_or_limits_mismatch" in verdict(formal_proof)["failures"]


@pytest.mark.parametrize("field,value", [("model", "historical-model"), ("temperature", .1),
    ("thinking", "enabled"), ("mode", "replay"), ("stream", False)])
def test_formal_configuration_must_match_child(formal_proof, field, value):
    formal_proof["summary"]["formal_configuration"][field] = value
    assert "source_proof_formal_configuration_mismatch" in verdict(formal_proof)["failures"]


@pytest.mark.parametrize("mutation", ["tree_hash", "outside_module", "module_hash", "wrong_package", "platform_hash"])
def test_dependency_internal_integrity_cannot_be_faked_by_matching_copies(formal_proof, mutation):
    manifest = formal_proof["source_manifest"]
    wm = manifest["worldModel"]
    if mutation == "tree_hash":
        wm["files"]["world_model/__init__.py"] = "0" * 64
    elif mutation == "outside_module":
        wm["loaded_modules"]["world_model"]["path"] = "/somewhere/else/__init__.py"
    elif mutation == "module_hash":
        wm["loaded_modules"]["world_model"]["sha256"] = "0" * 64
    elif mutation == "wrong_package":
        wm["loaded_package"] = "/another/world_model"
    else:
        manifest["platformRuntimeSources"]["competition-core.js"] = "0" * 64
    formal_proof["driver_summary"]["sourceManifestAfterRun"] = copy.deepcopy(manifest)
    assert verdict(formal_proof)["status"] == "invalid"


@pytest.mark.parametrize("holding", ["truth-blue-ball", "unknown", False])
def test_native_gripper_must_be_empty_even_if_sensor_says_empty(fixture_data, holding):
    fixture_data["record"]["native"]["samples"][-1]["holding"] = holding
    result = evaluation.evaluate_delivery(fixture_data["record"], fixture_data["rounds"],
        fixture_data["summary"], fixture_data["metadata"], fixture_data["observations"])
    assert "final_truth_gripper_not_empty_or_unknown" in result["failures"]


def test_missing_native_gripper_is_not_empty(fixture_data):
    fixture_data["record"]["native"]["samples"][-1].pop("holding")
    result = evaluation.evaluate_delivery(fixture_data["record"], fixture_data["rounds"],
        fixture_data["summary"], fixture_data["metadata"], fixture_data["observations"])
    assert "final_truth_gripper_not_empty_or_unknown" in result["failures"]


@pytest.mark.parametrize("version", range(1, 7))
def test_legacy_proof_does_not_require_new_fields(fixture_data, version):
    fixture_data["source_manifest"]["version"] = f"wm-autonomous-brain-driver/v{version}"
    fixture_data["driver_summary"]["schema"] = fixture_data["source_manifest"]["version"]
    fixture_data["driver_summary"]["sourceManifestAfterRun"] = copy.deepcopy(fixture_data["source_manifest"])
    assert verdict(fixture_data)["status"] == "verified"


def test_incomplete_brain_coverage_is_not_a_valid_new_proof(formal_proof):
    formal_proof['source_manifest']['brain'].pop('autonomous_brain/actions.py')
    formal_proof['summary']['source_sha256'].pop('actions.py')
    formal_proof['driver_summary']['sourceManifestAfterRun'] = copy.deepcopy(formal_proof['source_manifest'])
    assert verdict(formal_proof)['status'] == 'invalid'
