import { blobToDataUrl } from "./binary";
import { ensureFileExtension, sanitizeFilename } from "./download";
import type { SupportedImageSize } from "./types";
import { PROJECT_LIMITS, isSupportedImageSize } from "./validation";

export const MAX_SOURCE_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_SOURCE_IMAGE_PIXELS = 50_000_000;
export const ALLOWED_SOURCE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export interface ResizeImageOptions {
  size?: SupportedImageSize;
  quality?: number;
  maxSourceBytes?: number;
}

export interface ProcessedImage {
  dataUrl: string;
  name: string;
  width: SupportedImageSize;
  height: SupportedImageSize;
  byteLength: number;
  mimeType: "image/jpeg";
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

function assertImageSignature(bytes: Uint8Array, mimeType: string): void {
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  const isWebp =
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;

  if (
    (mimeType === "image/jpeg" && !isJpeg) ||
    (mimeType === "image/png" && !isPng) ||
    (mimeType === "image/webp" && !isWebp)
  ) {
    throw new TypeError("图片内容与文件类型不匹配");
  }
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }

  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new Error("当前环境不支持图片解码");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new TypeError("无法解码图片"));
      element.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("浏览器无法生成 JPEG 图片"));
        return;
      }
      resolve(blob);
    }, "image/jpeg", quality);
  });
}

export async function resizeImageFile(
  file: File,
  options: ResizeImageOptions = {},
): Promise<ProcessedImage> {
  const size = options.size ?? 224;
  const quality = options.quality ?? 0.9;
  const maxSourceBytes = options.maxSourceBytes ?? MAX_SOURCE_IMAGE_BYTES;

  if (typeof File === "undefined" || !(file instanceof File)) {
    throw new TypeError("请选择有效图片文件");
  }
  if (!isSupportedImageSize(size)) {
    throw new RangeError("输出尺寸仅支持 224 或 256");
  }
  if (!Number.isFinite(quality) || quality < 0.4 || quality > 1) {
    throw new RangeError("JPEG 质量必须在 0.4–1 之间");
  }
  if (!Number.isFinite(maxSourceBytes) || maxSourceBytes < 1 || maxSourceBytes > 100 * 1024 * 1024) {
    throw new RangeError("源图片大小限制无效");
  }
  if (file.size < 1 || file.size > maxSourceBytes) {
    throw new RangeError(`图片必须小于 ${Math.round(maxSourceBytes / 1024 / 1024)} MB`);
  }
  if (!(ALLOWED_SOURCE_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    throw new TypeError("仅支持 JPEG、PNG 或 WebP 图片");
  }

  const signature = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  assertImageSignature(signature, file.type);

  const decoded = await decodeImage(file);
  try {
    if (
      decoded.width < 1 ||
      decoded.height < 1 ||
      decoded.width * decoded.height > MAX_SOURCE_IMAGE_PIXELS
    ) {
      throw new RangeError("图片像素尺寸过大或无效");
    }
    if (typeof document === "undefined") {
      throw new Error("当前环境不支持 Canvas");
    }

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("无法创建 Canvas 2D 上下文");
    }

    const cropSize = Math.min(decoded.width, decoded.height);
    const sourceX = (decoded.width - cropSize) / 2;
    const sourceY = (decoded.height - cropSize) / 2;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size, size);
    context.drawImage(
      decoded.source,
      sourceX,
      sourceY,
      cropSize,
      cropSize,
      0,
      0,
      size,
      size,
    );

    const jpeg = await canvasToJpeg(canvas, quality);
    if (jpeg.size > PROJECT_LIMITS.maxSampleBytes) {
      throw new RangeError("处理后的图片超过 2 MB");
    }
    const dataUrl = await blobToDataUrl(jpeg);
    const baseName = sanitizeFilename(file.name, "sample").replace(/\.[^.]+$/, "");
    return {
      dataUrl,
      name: ensureFileExtension(baseName || "sample", ".jpg"),
      width: size,
      height: size,
      byteLength: jpeg.size,
      mimeType: "image/jpeg",
    };
  } finally {
    decoded.close();
  }
}

export async function imageFileToSquareJpegDataUrl(
  file: File,
  options?: ResizeImageOptions,
): Promise<string> {
  return (await resizeImageFile(file, options)).dataUrl;
}
