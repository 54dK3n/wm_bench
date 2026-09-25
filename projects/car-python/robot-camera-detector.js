(function publish(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RobotCameraDetector = api;
})(typeof globalThis === "object" ? globalThis : this, function createRobotCameraDetector() {
  "use strict";
  const VERSION = "chenlong.robot-camera-detector/v1";

  // These virtual classes are the frozen detector's red/blue pixel classifiers,
  // not scene-object roles. Never infer appearance from a mission or object ID.
  function appearanceCategory(item) {
    if (item.source === "virtual-cv") {
      return item.category === "target" ? "red-ball" : item.category === "distractor" ? "blue-ball"
        : item.category === "obstacle" ? "obstacle" : null;
    }
    if (item.source === "yolo") {
      return item.colorClass === "red" ? "red-ball" : item.colorClass === "blue" ? "blue-ball"
        : item.category === "obstacle" ? "obstacle" : null;
    }
    return null;
  }

  function detect(visionDetections, storageDetections) {
    const detections = [];
    for (const item of visionDetections) {
      const category = appearanceCategory(item);
      if (!category || !item.box) continue;
      // Both vision backends report the fixed 640-square detector letterbox.
      // Preserve scores and order; only remove padding and clip to source pixels.
      const x = Math.max(0, item.box.x), y = Math.max(0, item.box.y - 80);
      const right = Math.min(640, item.box.x + item.box.width);
      const bottom = Math.min(480, item.box.y + item.box.height - 80);
      if (right <= x || bottom <= y) continue;
      detections.push({ category, confidence: item.confidence,
        bbox: { x, y, w: right - x, h: bottom - y }, source: item.source });
    }
    // The old upright storage/cleanup signs above are not ground-region pixels.
    // Only this separate pixel detector supplies the storage-zone class.
    for (const item of storageDetections) {
      if (item.category !== "storage-zone" || item.source !== "storage-ground-pixels") continue;
      detections.push({ category: item.category, confidence: item.confidence,
        bbox: { x: item.bbox.x, y: item.bbox.y, w: item.bbox.w, h: item.bbox.h }, source: item.source });
    }
    return detections;
  }

  return Object.freeze({ VERSION, detect });
});
