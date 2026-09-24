(function publish(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CarStorageRegionPixels = api;
})(typeof globalThis === "object" ? globalThis : this, function createStorageRegionPixels() {
  "use strict";
  const VERSION = "chenlong.storage-ground-pixels/v1";
  const DEFINITION = Object.freeze({ width: 640, height: 480,
    source: "source-camera-rgba8", color: Object.freeze([0, 255, 0, 255]), connectivity: 4,
    bounds: "visible-component-inclusive-pixels", confidence: "exact-chroma-membership" });

  function detectStorageRegions(image) {
    if (image?.width !== DEFINITION.width || image?.height !== DEFINITION.height
      || !ArrayBuffer.isView(image.data) || image.data.BYTES_PER_ELEMENT !== 1
      || image.data.length !== DEFINITION.width * DEFINITION.height * 4) {
      throw new TypeError("Storage detection requires a 640x480 RGBA8 camera image");
    }
    const { width, height, data } = image;
    const total = width * height;
    const mask = new Uint8Array(total);
    // The ground uses an opaque unlit/unfogged #00ff00 material. Exact chroma
    // excludes the older #22c55e upright sign without geometry, a world pose,
    // zone coordinates, distance calibration or a fitted confidence threshold.
    // Other pixels of the same chroma remain sensor ambiguities; this is not
    // a truth classifier. Occlusion and clipping shrink the returned bounds.
    for (let pixel = 0; pixel < total; pixel += 1) {
      const offset = pixel * 4;
      mask[pixel] = data[offset] === 0 && data[offset + 1] === 255
        && data[offset + 2] === 0 && data[offset + 3] === 255 ? 1 : 0;
    }
    const queue = new Uint32Array(total);
    const regions = [];
    for (let start = 0; start < total; start += 1) {
      if (!mask[start]) continue;
      let head = 0, tail = 1;
      let minX = width, maxX = 0, minY = height, maxY = 0;
      queue[0] = start;
      mask[start] = 0;
      while (head < tail) {
        const pixel = queue[head++];
        const y = Math.floor(pixel / width), x = pixel - y * width;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (const next of [x > 0 ? pixel - 1 : -1, x + 1 < width ? pixel + 1 : -1,
          y > 0 ? pixel - width : -1, y + 1 < height ? pixel + width : -1]) {
          if (next >= 0 && mask[next]) {
            mask[next] = 0;
            queue[tail++] = next;
          }
        }
      }
      regions.push({ category: "storage-zone", confidence: 1,
        bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, pixelCount: tail });
    }
    regions.sort((a, b) => b.pixelCount - a.pixelCount || a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    return regions;
  }
  return Object.freeze({ VERSION, DEFINITION, detectStorageRegions });
});
