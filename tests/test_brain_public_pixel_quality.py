"""Original public RGB -> production sensor contract -> real Perception/WM.

This selected window begins with empty memory. It is an integration
counterfactual, not a competition or a replay of the omitted observations.
"""
import copy
import json
import subprocess
from decimal import Decimal
from pathlib import Path

import pytest

from test_brain_perception import Perception


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = ROOT / "tests/fixtures/pixel_quality_public.json"
FIXTURE = json.loads(FIXTURE_PATH.read_text())


@pytest.fixture(scope="module")
def production_observations():
    # Recompute from the original PNG on every test invocation. The saved
    # quality declaration alone is not trusted as the source of the test.
    script = r"""
const fs = require('node:fs'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const base = './workspaces/guangyang-platform/projects/car-python/';
const core = require(base + 'vision-pixel-core.js');
const detector = require(base + 'robot-camera-detector.js');
const storage = require(base + 'storage-region-pixels.js');
const contract = require(base + 'robot-bridge-contract.js');
const { decodeStrictVisionPng } = require(base + 'backend/strict-png.js');
const fixture = JSON.parse(fs.readFileSync(process.argv[1]));
const result = [];
for (const row of fixture.frames) {
  const bytes = Buffer.from(row.pngBase64, 'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), row.pngSha256);
  const decoded = decodeStrictVisionPng(bytes);
  const pixels = { width: decoded.width, height: decoded.height, data: decoded.rgba };
  const frameId = row.raw_observation.frameId;
  const native = core.detectVirtualPixels(core.prepareVirtualFrame(pixels.data,
    { frameId, capturedAt: 0 }));
  const zones = storage.detectStorageRegions(pixels);
  assert.deepEqual(detector.detect(native, zones), row.raw_observation.detections);
  const detections = detector.detect(native, zones, { pixels, frameId });
  const observation = contract.sanitizeResponse('observe', { ...row.raw_observation, detections });
  assert.deepEqual(observation, row.quality_observation);
  result.push(observation);
}
process.stdout.write(JSON.stringify(result));
"""
    result = subprocess.run(["node", "-e", script, str(FIXTURE_PATH)], cwd=ROOT,
                            text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def test_original_public_window_keeps_pixels_boxes_scores_order_and_source_times(production_observations):
    assert [r["observation_index"] for r in FIXTURE["frames"]] == [248, 272, 318, 321, 325, 332]
    for row, observation in zip(FIXTURE["frames"], production_observations):
        restored = copy.deepcopy(observation)
        for detection in restored["detections"]:
            detection.pop("pixelQuality", None)
        assert restored == row["raw_observation"]
        assert observation["tick"] == row["odometry"]["tick"]
        assert Decimal(str(row["simulation_seconds"])) == Decimal(row["odometry"]["tick"]) * Decimal(".02")
        red = [d for d in observation["detections"] if d["category"] == "red-ball"]
        assert len(red) == 1
        quality = red[0]["pixelQuality"]
        assert quality["frameId"] == observation["frameId"]
        assert quality["status"] == ("unknown" if observation["frameId"] == 248 else "supported")
    quality = production_observations[0]["detections"][0]["pixelQuality"]
    assert (quality["componentPixels"], quality["redSectorPixels"]) == (186, 12)
    assert quality["reason"] == "red_sector_not_majority"


def test_public_mixed_component_cannot_birth_identity_then_native_independent_views_confirm(production_observations):
    perception = Perception(FIXTURE["camera"])
    object_id = None
    original_unknown = None
    for row, observation in zip(FIXTURE["frames"], production_observations):
        evidence = perception.update(observation, row["odometry"],
            simulation_time_s=row["simulation_seconds"], round_index=row["round"],
            observation_index=row["observation_index"])
        assert evidence["raw_observation"] == observation
        red = [d for d in evidence["detections"] if d["category"] == "red-ball"]
        targets = [o for o in perception.objects() if o["category"] == "red-ball"]
        frame = observation["frameId"]
        if frame in (248, 272):
            assert targets == []
            assert red[0]["fed_to_world_model"] is False
            assert red[0]["track_id"] is None
            assert not red[0].get("visibility_refresh_only", False)
            if frame == 248:
                assert red[0]["pixel_quality"]["status"] == "unknown"
                original_unknown = copy.deepcopy(perception.discovery_evidence()["records"][0])
                assert original_unknown["initial_object_id"] is None
                assert perception.discovery_target(original_unknown["id"])["reason"] == "pixel_geometry_support_unknown"
            else:
                # The independently supported near box is still outside the
                # unchanged confirmation window; it supplies no extra hit.
                assert red[0]["pixel_quality"]["status"] == "supported"
                assert red[0]["raw_distance_cm"] < 40
        else:
            assert len(targets) == 1
            object_id = object_id or targets[0]["id"]
            assert targets[0]["id"] == red[0]["track_id"] == object_id
            assert red[0]["fed_to_world_model"] is True
            assert targets[0]["hit_count"] == {318: 1, 321: 2, 325: 3, 332: 4}[frame]
            assert targets[0]["state"] == ("TENTATIVE" if frame in (318, 321) else "CONFIRMED")
    assert [p["frame_id"] for p in perception._accepted_poses[object_id]] == ["318", "321", "325", "332"]
    ledger = perception.discovery_evidence()
    assert ledger["records"][0] == original_unknown
    assert original_unknown in ledger["unresolved"]
    assert original_unknown["id"] not in perception._discovery_resolutions
    assert perception.discovery_target(original_unknown["id"])["sampling_allowed"] is False
    assert not perception._reacquisitions
    assert not perception._delivery_aliases
    assert not perception._action_evidence
