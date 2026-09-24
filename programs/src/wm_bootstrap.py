WM_EMBED_SHA256 = hashlib.sha256(_WM_ZIP_BYTES).hexdigest()
with zipfile.ZipFile(io.BytesIO(_WM_ZIP_BYTES)) as _wm_zip:
    _wm_zip.extractall("/tmp/wm_models")
sys.path.insert(0, "/tmp/wm_models")
from world_model.core import WorldModel
from world_model.association import associate
from world_model.decay import DecayConfig, FovConfig
from world_model.providers.guangyang import (
    guangyang_static_world_model,
    observation_to_detection,
    odometry_to_pose,
)
from world_model.types import ObjectState

print("GY " + json.dumps({
    "event": "program_version",
    "version": PROGRAM_VERSION,
    "file_sha256": PROGRAM_SHA256,
    "wm_kit_commit": WM_KIT_COMMIT,
    "wm_embed_sha256": WM_EMBED_SHA256,
    "turn_cost_k": TURN_COST_K,
    "turn_calibration_sha256": TURN_CALIBRATION_SHA256,
    "log_conventions": {"pose": "[x_m 右, z_m 前, headingDeg 左转为正 = odometry.headingDeg]",
                        "bearingDeg": "右为正（observe / WM 方位同号）"},
}, ensure_ascii=False))

# ---- WorldModel target search / delivery flow ----
wm = guangyang_static_world_model(max_range_m=0.9)
