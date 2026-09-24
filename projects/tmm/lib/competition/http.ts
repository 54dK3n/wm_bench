import type { CompetitionApiError } from "./types";

const DEFAULT_JSON_LIMIT_BYTES = 8 * 1024;

export class CompetitionHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CompetitionHttpError";
    this.status = status;
    this.code = code;
  }
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    throw new CompetitionHttpError(403, "invalid_origin", "请求来源无效");
  }
  if (!origin || origin === "null" || origin !== requestOrigin) {
    throw new CompetitionHttpError(403, "invalid_origin", "请求来源不受信任");
  }
}

export async function readJsonObject(
  request: Request,
  maxBytes = DEFAULT_JSON_LIMIT_BYTES,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new CompetitionHttpError(415, "unsupported_media_type", "请求必须使用 JSON");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      throw new CompetitionHttpError(413, "request_too_large", "请求内容过大");
    }
  }

  if (!request.body) {
    throw new CompetitionHttpError(400, "invalid_json", "缺少 JSON 请求内容");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new CompetitionHttpError(413, "request_too_large", "请求内容过大");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CompetitionHttpError(400, "invalid_json", "JSON 编码无效");
  }

  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    throw new CompetitionHttpError(400, "invalid_json", "JSON 格式无效");
  }
  if (!isRecord(value)) {
    throw new CompetitionHttpError(400, "invalid_json", "JSON 顶层必须是对象");
  }
  return value;
}

export async function readMultipartFormData(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new CompetitionHttpError(415, "unsupported_media_type", "请求必须使用 multipart/form-data");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      throw new CompetitionHttpError(413, "request_too_large", "上传内容过大");
    }
  }
  if (!request.body) throw new CompetitionHttpError(400, "invalid_multipart", "缺少上传内容");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new CompetitionHttpError(413, "request_too_large", "上传内容过大");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(bytes.buffer, {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch {
    throw new CompetitionHttpError(400, "invalid_multipart", "上传表单格式无效");
  }
}

export function requireStringField(
  payload: Record<string, unknown>,
  field: string,
  maxLength = 256,
): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new CompetitionHttpError(400, "invalid_request", `缺少字段：${field}`);
  }
  if (value.length > maxLength) {
    throw new CompetitionHttpError(400, "invalid_request", `字段过长：${field}`);
  }
  return value;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const encoded = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(encoded);
    } catch {
      return null;
    }
  }
  return null;
}

export interface CompetitionCookieOptions {
  maxAgeSeconds: number;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax";
}

export function appendCookie(
  headers: Headers,
  request: Request,
  name: string,
  value: string,
  options: CompetitionCookieOptions,
): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    `SameSite=${options.sameSite ?? "Strict"}`,
  ];
  if (options.httpOnly ?? true) parts.push("HttpOnly");
  if (new URL(request.url).protocol === "https:") parts.push("Secure");
  headers.append("Set-Cookie", parts.join("; "));
}

export function expireCookie(
  headers: Headers,
  request: Request,
  name: string,
): void {
  appendCookie(headers, request, name, "", { maxAgeSeconds: 0 });
}

export function jsonResponse<T>(body: T, status = 200, headersInit?: HeadersInit): Response {
  const headers = new Headers(headersInit);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}

export function jsonError(error: unknown): Response;
export function jsonError(status: number, code: string, message: string): Response;
export function jsonError(
  errorOrStatus: unknown,
  code?: string,
  message?: string,
): Response {
  if (typeof errorOrStatus === "number") {
    return errorPayload(errorOrStatus, code ?? "request_failed", message ?? "请求失败");
  }
  if (errorOrStatus instanceof CompetitionHttpError) {
    return errorPayload(errorOrStatus.status, errorOrStatus.code, errorOrStatus.message);
  }

  const conflictCode = readErrorCode(errorOrStatus);
  if (conflictCode === "team_name_taken") {
    return errorPayload(409, conflictCode, "该队伍名称已被注册");
  }
  if (conflictCode === "admin_already_setup") {
    return errorPayload(409, conflictCode, "管理员密码已经设置");
  }

  console.error("Competition API request failed", errorOrStatus);
  return errorPayload(500, "internal_error", "服务器暂时无法处理请求");
}

function errorPayload(status: number, code: string, message: string): Response {
  const payload: CompetitionApiError = { error: { code, message } };
  return jsonResponse(payload, status);
}

function readErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
