"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { deflateSync } = require("node:zlib");
const {
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
} = require("../backend/strict-png.js");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let entry = value;
  for (let bit = 0; bit < 8; bit += 1) entry = (entry >>> 1) ^ (entry & 1 ? 0xedb88320 : 0);
  return entry >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return output;
}

function ihdr(overrides = {}) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(overrides.width ?? VISION_PNG_WIDTH, 0);
  data.writeUInt32BE(overrides.height ?? VISION_PNG_HEIGHT, 4);
  data[8] = overrides.bitDepth ?? VISION_PNG_BIT_DEPTH;
  data[9] = overrides.colorType ?? VISION_PNG_COLOR_TYPE;
  data[10] = overrides.compression ?? 0;
  data[11] = overrides.filter ?? 0;
  data[12] = overrides.interlace ?? 0;
  return chunk("IHDR", data);
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

function makeRgba() {
  const rgba = Buffer.allocUnsafe(EXPECTED_RGBA_BYTES);
  for (let y = 0; y < VISION_PNG_HEIGHT; y += 1) {
    for (let x = 0; x < VISION_PNG_WIDTH; x += 1) {
      const offset = (y * VISION_PNG_WIDTH + x) * 4;
      rgba[offset] = (x * 7 + y * 11) & 0xff;
      rgba[offset + 1] = (x * 3 + y * 17 + 61) & 0xff;
      rgba[offset + 2] = (x * 13 + y * 5 + 127) & 0xff;
      rgba[offset + 3] = (x * 19 + y * 23 + 191) & 0xff;
    }
  }
  return rgba;
}

function filteredScanlines(rgba, filterForRow = () => 0) {
  const rowBytes = VISION_PNG_WIDTH * VISION_PNG_BYTES_PER_PIXEL;
  const scanlines = Buffer.allocUnsafe(EXPECTED_SCANLINE_BYTES);
  let outputOffset = 0;
  for (let row = 0; row < VISION_PNG_HEIGHT; row += 1) {
    const filterType = filterForRow(row);
    scanlines[outputOffset++] = filterType;
    const rowStart = row * rowBytes;
    for (let columnByte = 0; columnByte < rowBytes; columnByte += 1) {
      const sourceOffset = rowStart + columnByte;
      const current = rgba[sourceOffset];
      const left = columnByte >= VISION_PNG_BYTES_PER_PIXEL
        ? rgba[sourceOffset - VISION_PNG_BYTES_PER_PIXEL]
        : 0;
      const above = row > 0 ? rgba[sourceOffset - rowBytes] : 0;
      const upperLeft = row > 0 && columnByte >= VISION_PNG_BYTES_PER_PIXEL
        ? rgba[sourceOffset - rowBytes - VISION_PNG_BYTES_PER_PIXEL]
        : 0;
      let predictor = 0;
      if (filterType === 1) predictor = left;
      else if (filterType === 2) predictor = above;
      else if (filterType === 3) predictor = Math.floor((left + above) / 2);
      else if (filterType === 4) predictor = paethPredictor(left, above, upperLeft);
      scanlines[outputOffset++] = (current - predictor) & 0xff;
    }
  }
  return scanlines;
}

function pngWithCompressed(compressed, options = {}) {
  const splitAt = options.splitAt || compressed.length;
  const idat = [];
  for (let offset = 0; offset < compressed.length; offset += splitAt) {
    idat.push(chunk("IDAT", compressed.subarray(offset, Math.min(compressed.length, offset + splitAt))));
  }
  return Buffer.concat([PNG_SIGNATURE, options.header || ihdr(), ...idat, chunk("IEND")]);
}

function validPng(rgba = makeRgba(), filterForRow = row => row % 5) {
  return pngWithCompressed(deflateSync(filteredScanlines(rgba, filterForRow)), { splitAt: 4096 });
}

test("strict PNG decoder exports the frozen camera profile", () => {
  assert.deepEqual({
    width: VISION_PNG_WIDTH,
    height: VISION_PNG_HEIGHT,
    bitDepth: VISION_PNG_BIT_DEPTH,
    colorType: VISION_PNG_COLOR_TYPE,
    bytesPerPixel: VISION_PNG_BYTES_PER_PIXEL,
    rgbaBytes: EXPECTED_RGBA_BYTES,
    scanlineBytes: EXPECTED_SCANLINE_BYTES
  }, {
    width: 640,
    height: 480,
    bitDepth: 8,
    colorType: 6,
    bytesPerPixel: 4,
    rgbaBytes: 1_228_800,
    scanlineBytes: 1_229_280
  });
});

test("strict PNG decoder reverses scanline filters 0 through 4", () => {
  const expected = makeRgba();
  const decoded = decodeStrictVisionPng(validPng(expected, row => row % 5));
  assert.equal(decoded.width, 640);
  assert.equal(decoded.height, 480);
  assert.ok(Buffer.isBuffer(decoded.rgba));
  assert.deepEqual(decoded.rgba, expected);
});

test("strict PNG decoder rejects a non-Buffer and invalid signature", () => {
  assert.throws(() => decodeStrictVisionPng(new Uint8Array()), /must be a Buffer/);
  assert.throws(() => decodeStrictVisionPng(Buffer.alloc(64)), /invalid signature/);
});

test("strict PNG decoder verifies every chunk CRC", () => {
  const png = validPng(Buffer.alloc(EXPECTED_RGBA_BYTES), () => 0);
  const tampered = Buffer.from(png);
  const firstIdatData = PNG_SIGNATURE.length + ihdr().length + 8;
  tampered[firstIdatData] ^= 0x01;
  assert.throws(() => decodeStrictVisionPng(tampered), /IDAT has an invalid CRC/);
});

test("strict PNG decoder enforces IHDR-IDAT-IEND order and rejects unknown chunks", () => {
  const compressed = deflateSync(Buffer.alloc(EXPECTED_SCANLINE_BYTES));
  assert.throws(() => decodeStrictVisionPng(Buffer.concat([
    PNG_SIGNATURE, chunk("IDAT", compressed), ihdr(), chunk("IEND")
  ])), /must start/);
  assert.throws(() => decodeStrictVisionPng(Buffer.concat([
    PNG_SIGNATURE, ihdr(), chunk("IEND")
  ])), /must follow at least one IDAT/);
  assert.throws(() => decodeStrictVisionPng(Buffer.concat([
    PNG_SIGNATURE, ihdr(), chunk("tEXt", Buffer.from("x")), chunk("IDAT", compressed), chunk("IEND")
  ])), /unsupported chunk/);
  assert.throws(() => decodeStrictVisionPng(Buffer.concat([
    PNG_SIGNATURE, ihdr(), chunk("IDAT", compressed), ihdr(), chunk("IEND")
  ])), /duplicate or misplaced IHDR/);
});

test("strict PNG decoder requires the frozen dimensions and IHDR encoding", () => {
  const compressed = deflateSync(Buffer.alloc(EXPECTED_SCANLINE_BYTES));
  for (const [header, message] of [
    [ihdr({ width: 639 }), /dimensions must be 640x480/],
    [ihdr({ height: 481 }), /dimensions must be 640x480/],
    [ihdr({ bitDepth: 16 }), /bit depth must be 8/],
    [ihdr({ colorType: 2 }), /color type must be 6/],
    [ihdr({ compression: 1 }), /compression method must be 0/],
    [ihdr({ filter: 1 }), /filter method must be 0/],
    [ihdr({ interlace: 1 }), /must not be interlaced/]
  ]) {
    assert.throws(() => decodeStrictVisionPng(Buffer.concat([
      PNG_SIGNATURE, header, chunk("IDAT", compressed), chunk("IEND")
    ])), message);
  }
});

test("strict PNG decoder rejects invalid scanline filters", () => {
  const scanlines = Buffer.alloc(EXPECTED_SCANLINE_BYTES);
  scanlines[0] = 5;
  assert.throws(() => decodeStrictVisionPng(pngWithCompressed(deflateSync(scanlines))), /unsupported filter 5/);
});

test("strict PNG decoder caps decompression and rejects zlib bombs", () => {
  const bomb = deflateSync(Buffer.alloc(EXPECTED_SCANLINE_BYTES + 1));
  assert.throws(() => decodeStrictVisionPng(pngWithCompressed(bomb)), /decompressed data exceeds/);
});

test("strict PNG decoder requires exact decompressed length and one complete zlib stream", () => {
  const short = deflateSync(Buffer.alloc(EXPECTED_SCANLINE_BYTES - 1));
  assert.throws(() => decodeStrictVisionPng(pngWithCompressed(short)), /exactly 1229280/);

  const valid = deflateSync(Buffer.alloc(EXPECTED_SCANLINE_BYTES));
  assert.throws(() => decodeStrictVisionPng(pngWithCompressed(Buffer.concat([valid, Buffer.from([1, 2, 3])]))),
    /trailing or concatenated zlib data/);
});

test("strict PNG decoder rejects data after IEND", () => {
  assert.throws(() => decodeStrictVisionPng(Buffer.concat([
    validPng(Buffer.alloc(EXPECTED_RGBA_BYTES), () => 0), Buffer.from([0])
  ])), /trailing data/);
});

test("strict PNG decoder enforces compressed-IDAT and chunk-count budgets", () => {
  const oversizedIdat = Buffer.alloc(MAX_IDAT_BYTES + 1);
  assert.throws(() => decodeStrictVisionPng(Buffer.concat([
    PNG_SIGNATURE, ihdr(), chunk("IDAT", oversizedIdat), chunk("IEND")
  ])), new RegExp(`exceeds the ${MAX_IDAT_BYTES} byte limit`));

  const compressed = deflateSync(Buffer.alloc(EXPECTED_SCANLINE_BYTES));
  const chunks = [PNG_SIGNATURE, ihdr(), chunk("IDAT", compressed)];
  for (let index = 0; index < MAX_PNG_CHUNKS - 2; index += 1) chunks.push(chunk("IDAT"));
  chunks.push(chunk("IEND"));
  assert.throws(() => decodeStrictVisionPng(Buffer.concat(chunks)),
    new RegExp(`exceeds the ${MAX_PNG_CHUNKS} chunk limit`));
});
