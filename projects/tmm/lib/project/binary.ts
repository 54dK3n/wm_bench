import { PROJECT_LIMITS, validateJpegDataUrl } from "./validation";

export function assertBrowserApi(api: unknown, name: string): void {
  if (api === undefined || api === null) {
    throw new Error(`当前浏览器不支持 ${name}`);
  }
}

export function jpegDataUrlToUint8Array(
  dataUrl: string,
  maxBytes = PROJECT_LIMITS.maxSampleBytes,
): Uint8Array {
  validateJpegDataUrl(dataUrl, "dataUrl", maxBytes);
  assertBrowserApi(globalThis.atob, "base64 解码");
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  let decoded: string;
  try {
    decoded = globalThis.atob(encoded);
  } catch (error) {
    throw new TypeError("图片 base64 数据无效", { cause: error });
  }
  if (decoded.length > maxBytes) {
    throw new RangeError("图片数据超过大小限制");
  }

  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  assertJpegBytes(bytes);
  return bytes;
}

export function assertJpegBytes(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff ||
    bytes[bytes.byteLength - 2] !== 0xff ||
    bytes[bytes.byteLength - 1] !== 0xd9
  ) {
    throw new TypeError("文件内容不是有效 JPEG 图片");
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  assertBrowserApi(globalThis.FileReader, "FileReader");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("读取图片失败"));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}

export function uint8ArrayToJpegDataUrl(bytes: Uint8Array): string {
  assertJpegBytes(bytes);
  assertBrowserApi(globalThis.btoa, "base64 编码");
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    binary += String.fromCharCode(...chunk);
  }
  return `data:image/jpeg;base64,${globalThis.btoa(binary)}`;
}

export function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function concatenateArrayBuffers(buffers: readonly ArrayBuffer[]): ArrayBuffer {
  const totalBytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const buffer of buffers) {
    const bytes = new Uint8Array(buffer);
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return output.buffer;
}

export function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).byteLength;
  }
  return value.length * 3;
}
