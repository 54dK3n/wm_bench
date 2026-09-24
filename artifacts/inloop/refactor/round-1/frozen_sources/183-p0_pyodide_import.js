"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const platformRoot = process.env.GUANGYANG_PLATFORM_ROOT
  || "/Users/ken/Desktop/robot_competition-main/projects/car-python";
const worldModelRoot = process.env.WORLD_MODEL_ROOT
  || path.join(process.env.HOME || "", "wm_kit");
const pyodideRoot = path.join(platformRoot, "vendor", "pyodide") + path.sep;
const { loadPyodide } = require(path.join(platformRoot, "vendor", "pyodide", "pyodide.js"));

function pythonFiles(root) {
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".py")) files.push(absolute);
    }
  };
  walk(root);
  return files;
}

async function main() {
  const pyodide = await loadPyodide({
    indexURL: pyodideRoot,
    stdLibURL: path.join(pyodideRoot, "python_stdlib.zip")
  });

  const packageRoot = path.join(worldModelRoot, "world_model");
  pyodide.FS.mkdirTree("/workspace/world_model");
  for (const file of pythonFiles(packageRoot)) {
    const relative = path.relative(worldModelRoot, file).split(path.sep).join("/");
    const target = `/workspace/${relative}`;
    pyodide.FS.mkdirTree(path.posix.dirname(target));
    pyodide.FS.writeFile(target, fs.readFileSync(file));
  }
  pyodide.runPython(`
import sys
sys.path.insert(0, "/workspace")
from world_model.core import WorldModel
from world_model.types import Detection, RobotPose
wm = WorldModel()
wm.update([Detection(class_name="target", x=1.25, z=2.5, confidence=0.91, radius_cm=22.0)], RobotPose(x=0.0, z=0.0, yaw_rad=0.0), now=1.0)
assert wm.get_scene()[0].name == "target"
print("P0.3_OK", wm.get_scene()[0].x, wm.get_scene()[0].z)
`);
}

main().then(() => {
  console.log("P0.3_PYODIDE_IMPORT_OK");
}).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
