import type { ImageInput } from "./types";

export const IMAGE_INPUT_SIZE = 224;

type DrawableImageInput = Exclude<ImageInput, string>;

interface DrawableSource {
  source: CanvasImageSource;
  width: number;
  height: number;
}

export function assertBrowser(): void {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof Image === "undefined"
  ) {
    throw new Error("Image model operations are only available in a browser.");
  }
}

export function createAbortError(message = "The operation was cancelled."): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException(message, "AbortError");
  }

  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export function isImageDataUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(value);
}

function hasObjectTag(value: unknown, tag: string): boolean {
  return Object.prototype.toString.call(value) === `[object ${tag}]`;
}

function isHtmlImageElement(value: unknown): value is HTMLImageElement {
  return (
    (typeof HTMLImageElement !== "undefined" && value instanceof HTMLImageElement) ||
    hasObjectTag(value, "HTMLImageElement")
  );
}

function isHtmlCanvasElement(value: unknown): value is HTMLCanvasElement {
  return (
    (typeof HTMLCanvasElement !== "undefined" && value instanceof HTMLCanvasElement) ||
    hasObjectTag(value, "HTMLCanvasElement")
  );
}

function isHtmlVideoElement(value: unknown): value is HTMLVideoElement {
  return (
    (typeof HTMLVideoElement !== "undefined" && value instanceof HTMLVideoElement) ||
    hasObjectTag(value, "HTMLVideoElement")
  );
}

function isImageData(value: unknown): value is ImageData {
  return (
    (typeof ImageData !== "undefined" && value instanceof ImageData) ||
    hasObjectTag(value, "ImageData")
  );
}

function assertDrawableDimensions(width: number, height: number, sourceName: string): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error(`${sourceName} is not ready or has no drawable pixels.`);
  }
}

function imageDataToCanvas(imageData: ImageData): HTMLCanvasElement {
  assertDrawableDimensions(imageData.width, imageData.height, "ImageData");
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("A Canvas 2D context could not be created for ImageData.");
  }
  context.putImageData(imageData, 0, 0);
  return canvas;
}

function resolveDrawableSource(input: DrawableImageInput): DrawableSource {
  if (isHtmlImageElement(input)) {
    const width = input.naturalWidth;
    const height = input.naturalHeight;
    if (!input.complete || width < 1 || height < 1) {
      throw new Error("The image is not ready or could not be decoded.");
    }
    return { source: input, width, height };
  }

  if (isHtmlVideoElement(input)) {
    const width = input.videoWidth;
    const height = input.videoHeight;
    const haveCurrentData =
      typeof HTMLMediaElement === "undefined" ? 2 : HTMLMediaElement.HAVE_CURRENT_DATA;
    if (input.readyState < haveCurrentData || width < 1 || height < 1) {
      throw new Error("The video does not have a frame ready for processing.");
    }
    return { source: input, width, height };
  }

  if (isHtmlCanvasElement(input)) {
    assertDrawableDimensions(input.width, input.height, "Canvas");
    return { source: input, width: input.width, height: input.height };
  }

  if (isImageData(input)) {
    const canvas = imageDataToCanvas(input);
    return { source: canvas, width: input.width, height: input.height };
  }

  throw new TypeError("Unsupported image input.");
}

/**
 * Produce the exact square frame consumed by MobileNet.
 *
 * The shortest source edge is used as the crop size, so the image is never
 * stretched. The returned canvas is always 224 by 224 pixels.
 */
export function centerCropImage(
  input: DrawableImageInput,
  signal?: AbortSignal,
): HTMLCanvasElement {
  assertBrowser();
  throwIfAborted(signal);

  const { source, width, height } = resolveDrawableSource(input);
  throwIfAborted(signal);

  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_INPUT_SIZE;
  canvas.height = IMAGE_INPUT_SIZE;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("A Canvas 2D context could not be created for image preprocessing.");
  }

  const cropSize = Math.min(width, height);
  const sourceX = (width - cropSize) / 2;
  const sourceY = (height - cropSize) / 2;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, IMAGE_INPUT_SIZE, IMAGE_INPUT_SIZE);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    source,
    sourceX,
    sourceY,
    cropSize,
    cropSize,
    0,
    0,
    IMAGE_INPUT_SIZE,
    IMAGE_INPUT_SIZE,
  );

  throwIfAborted(signal);
  return canvas;
}

/** Convert an image data URL into a decoded HTMLImageElement. */
export function dataUrlToImage(
  dataUrl: string,
  signal?: AbortSignal,
): Promise<HTMLImageElement> {
  assertBrowser();
  throwIfAborted(signal);

  if (!isImageDataUrl(dataUrl)) {
    return Promise.reject(new TypeError("Expected an image data URL."));
  }

  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();

    const cleanUp = (): void => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = (): void => {
      cleanUp();
      image.src = "";
      reject(createAbortError());
    };

    image.onload = () => {
      cleanUp();
      resolve(image);
    };
    image.onerror = () => {
      cleanUp();
      reject(new Error("The image data URL could not be decoded."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    image.decoding = "async";
    image.src = dataUrl;
  });
}

export async function resolveImageInput(
  input: ImageInput,
  signal?: AbortSignal,
): Promise<HTMLCanvasElement> {
  assertBrowser();
  throwIfAborted(signal);

  const decoded = typeof input === "string" ? await dataUrlToImage(input, signal) : input;
  throwIfAborted(signal);
  return centerCropImage(decoded, signal);
}
