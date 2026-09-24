const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*]/g;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function replaceControlCharacters(input: string): string {
  return Array.from(input, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? "-" : character;
  }).join("");
}

export function sanitizeFilename(value: string, fallback = "download"): string {
  const fallbackCandidate = replaceControlCharacters(fallback.normalize("NFKC"))
    .replace(INVALID_FILENAME_CHARACTERS, "-")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const safeFallback = !fallbackCandidate || WINDOWS_RESERVED_NAME.test(fallbackCandidate)
    ? "download"
    : fallbackCandidate.slice(0, 120);
  const sanitized = replaceControlCharacters(value.normalize("NFKC"))
    .replace(INVALID_FILENAME_CHARACTERS, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120)
    .replace(/[.\s]+$/g, "");

  if (!sanitized || sanitized === "." || sanitized === ".." || WINDOWS_RESERVED_NAME.test(sanitized)) {
    return safeFallback;
  }
  return sanitized;
}

export function ensureFileExtension(fileName: string, extension: string): string {
  const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const safeExtension = normalizedExtension.toLowerCase().replace(/[^.a-z0-9]/g, "");
  if (safeExtension.length < 2) {
    throw new TypeError("文件扩展名无效");
  }

  const sanitized = sanitizeFilename(fileName);
  if (sanitized.toLowerCase().endsWith(safeExtension)) {
    return sanitized;
  }
  return `${sanitized}${safeExtension}`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") {
    throw new Error("当前环境不支持浏览器下载");
  }
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new TypeError("下载内容不能为空");
  }

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = sanitizeFilename(fileName);
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  // Firefox needs the URL to remain valid until the synthetic click is handled.
  globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}
