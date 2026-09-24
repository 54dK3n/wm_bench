"use strict";

const { inflateSync } = require("node:zlib");

const VISION_PNG_WIDTH = 640;
const VISION_PNG_HEIGHT = 480;
const VISION_PNG_BIT_DEPTH = 8;
const VISION_PNG_COLOR_TYPE = 6;
const VISION_PNG_BYTES_PER_PIXEL = 4;
const MAX_PNG_CHUNKS = 128;
const MAX_IDAT_BYTES = 2 * 1024 * 1024;
const EXPECTED_RGBA_BYTES = VISION_PNG_WIDTH * VISION_PNG_HEIGHT * VISION_PNG_BYTES_PER_PIXEL;
const EXPECTED_SCANLINE_BYTES = (VISION_PNG_WIDTH * VISION_PNG_BYTES_PER_PIXEL + 1) * VISION_PNG_HEIGHT;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_, value) => {
  let entry = value;
  for (let bit = 0; bit < 8; bit += 1) {
    entry = (entry >>> 1) ^ (entry & 1 ? 0xedb88320 : 0);
  }
  return entry >>> 0;
}));

function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function parseStrictChunks(png) {
  if (png.length < PNG_SIGNATURE.length
    || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new TypeError("vision PNG has an invalid signature");
  }

  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  let idatBytes = 0;
  const idatChunks = [];

  while (offset < png.length) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS) {
      throw new RangeError(`vision PNG exceeds the ${MAX_PNG_CHUNKS} chunk limit`);
    }
    if (offset + 12 > png.length) throw new TypeError("vision PNG chunk is truncated");

    const length = png.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > png.length) {
      throw new TypeError("vision PNG chunk length exceeds the payload");
    }
    const type = png.toString("ascii", typeStart, dataStart);

    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13 || chunkCount !== 1) {
        throw new TypeError("vision PNG must start with exactly one 13-byte IHDR chunk");
      }
    } else if (type === "IHDR") {
      throw new TypeError("vision PNG contains a duplicate or misplaced IHDR chunk");
    } else if (type === "IDAT") {
      if (sawEnd) throw new TypeError("vision PNG contains IDAT after IEND");
      idatBytes += length;
      if (idatBytes > MAX_IDAT_BYTES) {
        throw new RangeError(`vision PNG IDAT data exceeds the ${MAX_IDAT_BYTES} byte limit`);
      }
    } else if (type === "IEND") {
      if (!sawImageData) throw new TypeError("vision PNG IEND must follow at least one IDAT chunk");
      if (length !== 0) throw new TypeError("vision PNG IEND chunk must be empty");
    } else {
      throw new TypeError(`vision PNG contains unsupported chunk ${JSON.stringify(type)}`);
    }

    const expectedCrc = png.readUInt32BE(dataEnd) >>> 0;
    const actualCrc = crc32(png, typeStart, dataEnd);
    if (expectedCrc !== actualCrc) {
      throw new TypeError(`vision PNG chunk ${type} has an invalid CRC`);
    }

    if (type === "IHDR") {
      const width = png.readUInt32BE(dataStart);
      const height = png.readUInt32BE(dataStart + 4);
      const bitDepth = png[dataStart + 8];
      const colorType = png[dataStart + 9];
      const compressionMethod = png[dataStart + 10];
      const filterMethod = png[dataStart + 11];
      const interlaceMethod = png[dataStart + 12];
      if (width !== VISION_PNG_WIDTH || height !== VISION_PNG_HEIGHT) {
        throw new RangeError(`vision PNG dimensions must be ${VISION_PNG_WIDTH}x${VISION_PNG_HEIGHT}`);
      }
      if (bitDepth !== VISION_PNG_BIT_DEPTH) {
        throw new TypeError(`vision PNG bit depth must be ${VISION_PNG_BIT_DEPTH}`);
      }
      if (colorType !== VISION_PNG_COLOR_TYPE) {
        throw new TypeError(`vision PNG color type must be ${VISION_PNG_COLOR_TYPE} (RGBA)`);
      }
      if (compressionMethod !== 0) throw new TypeError("vision PNG compression method must be 0");
      if (filterMethod !== 0) throw new TypeError("vision PNG filter method must be 0");
      if (interlaceMethod !== 0) throw new TypeError("vision PNG must not be interlaced");
      sawHeader = true;
    } else if (type === "IDAT") {
      sawImageData = true;
      idatChunks.push(png.subarray(dataStart, dataEnd));
    } else {
      sawEnd = true;
      offset = chunkEnd;
      if (offset !== png.length) throw new TypeError("vision PNG has trailing data after IEND");
      break;
    }

    offset = chunkEnd;
  }

  if (!sawHeader || !sawImageData || !sawEnd || offset !== png.length) {
    throw new TypeError("vision PNG must contain IHDR, contiguous IDAT, and terminal IEND chunks");
  }
  if (idatBytes === 0) throw new TypeError("vision PNG IDAT stream must not be empty");
  return Buffer.concat(idatChunks, idatBytes);
}

function inflateStrictScanlines(compressed) {
  let result;
  try {
    result = inflateSync(compressed, {
      info: true,
      maxOutputLength: EXPECTED_SCANLINE_BYTES
    });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new RangeError(`vision PNG decompressed data exceeds the ${EXPECTED_SCANLINE_BYTES} byte limit`);
    }
    throw new TypeError(`vision PNG IDAT zlib stream is invalid: ${error?.message || error}`);
  }
  if (!result || !Buffer.isBuffer(result.buffer)) {
    throw new TypeError("vision PNG IDAT zlib stream did not produce a byte buffer");
  }
  if (result.engine?.bytesWritten !== compressed.length) {
    throw new TypeError("vision PNG IDAT contains trailing or concatenated zlib data");
  }
  if (result.buffer.length !== EXPECTED_SCANLINE_BYTES) {
    throw new TypeError(
      `vision PNG decompressed data must contain exactly ${EXPECTED_SCANLINE_BYTES} scanline bytes`
    );
  }
  return result.buffer;
}

function unfilterRgba(scanlines) {
  const rowBytes = VISION_PNG_WIDTH * VISION_PNG_BYTES_PER_PIXEL;
  const rgba = Buffer.allocUnsafe(EXPECTED_RGBA_BYTES);
  let sourceOffset = 0;
  for (let row = 0; row < VISION_PNG_HEIGHT; row += 1) {
    const filterType = scanlines[sourceOffset];
    sourceOffset += 1;
    if (filterType > 4) throw new TypeError(`vision PNG scanline ${row} has unsupported filter ${filterType}`);
    const rowStart = row * rowBytes;
    for (let columnByte = 0; columnByte < rowBytes; columnByte += 1) {
      const outputOffset = rowStart + columnByte;
      const encoded = scanlines[sourceOffset + columnByte];
      const left = columnByte >= VISION_PNG_BYTES_PER_PIXEL
        ? rgba[outputOffset - VISION_PNG_BYTES_PER_PIXEL]
        : 0;
      const above = row > 0 ? rgba[outputOffset - rowBytes] : 0;
      const upperLeft = row > 0 && columnByte >= VISION_PNG_BYTES_PER_PIXEL
        ? rgba[outputOffset - rowBytes - VISION_PNG_BYTES_PER_PIXEL]
        : 0;
      let predictor = 0;
      if (filterType === 1) predictor = left;
      else if (filterType === 2) predictor = above;
      else if (filterType === 3) predictor = Math.floor((left + above) / 2);
      else if (filterType === 4) predictor = paethPredictor(left, above, upperLeft);
      rgba[outputOffset] = (encoded + predictor) & 0xff;
    }
    sourceOffset += rowBytes;
  }
  return rgba;
}

function decodeStrictVisionPng(png) {
  if (!Buffer.isBuffer(png)) throw new TypeError("vision PNG input must be a Buffer");
  const compressed = parseStrictChunks(png);
  const scanlines = inflateStrictScanlines(compressed);
  return {
    width: VISION_PNG_WIDTH,
    height: VISION_PNG_HEIGHT,
    rgba: unfilterRgba(scanlines)
  };
}

module.exports = {
  VISION_PNG_WIDTH,
  VISION_PNG_HEIGHT,
  VISION_PNG_BIT_DEPTH,
  VISION_PNG_COLOR_TYPE,
  VISION_PNG_BYTES_PER_PIXEL,
  MAX_PNG_CHUNKS,
  MAX_IDAT_BYTES,
  EXPECTED_RGBA_BYTES,
  EXPECTED_SCANLINE_BYTES,
  decodeStrictVisionPng
};
