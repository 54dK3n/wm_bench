import type { CompetitionDivision } from "./types";

export const PLATFORM_PRINCIPAL_HEADER = "x-chenlong-platform-principal";
export const PLATFORM_PRINCIPAL_SCHEMA_VERSION = "chenlong.platform-principal/v1";
export const PLATFORM_PRINCIPAL_AUDIENCE = "workshop";

const PLATFORM_SIGNATURE_VERSION = "v1";
const PLATFORM_MAX_HEADER_LENGTH = 24_000;
const PLATFORM_MAX_TTL_MS = 60_000;
const PLATFORM_CLOCK_SKEW_MS = 5_000;
const encoder = new TextEncoder();

export const PLATFORM_GROUP_DIVISIONS = Object.freeze({
  primary: "primary",
  junior: "junior",
  high: "senior",
} satisfies Record<string, CompetitionDivision>);

export type PlatformCompetitionGroup = keyof typeof PLATFORM_GROUP_DIVISIONS;

const LEGACY_PLATFORM_GROUPS = Object.freeze({
  primary_low: "primary",
  primary_high: "primary",
  primary: "primary",
  primary_school: "primary",
  "小学组": "primary",
  "小学组（1-3年级）": "primary",
  "小学组(1-3年级)": "primary",
  "小学组（4-6年级）": "primary",
  "小学组(4-6年级)": "primary",
  middle_school: "junior",
  junior: "junior",
  "初中组": "junior",
  high_school: "high",
  senior: "high",
  high: "high",
  "高中组": "high",
} satisfies Record<string, PlatformCompetitionGroup>);

export interface PlatformPrincipalUser {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  teamId: string | null;
  teamName: string | null;
  group: PlatformCompetitionGroup | null;
  createdAt: string;
}

export interface PlatformPrincipal {
  schemaVersion: typeof PLATFORM_PRINCIPAL_SCHEMA_VERSION;
  audience: typeof PLATFORM_PRINCIPAL_AUDIENCE;
  issuedAt: number;
  expiresAt: number;
  user: PlatformPrincipalUser;
}

export function divisionForPlatformGroup(group: PlatformCompetitionGroup): CompetitionDivision {
  return PLATFORM_GROUP_DIVISIONS[group];
}

export function isPlatformSsoSecretConfigured(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function assertPlatformSsoSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || encoder.encode(secret).byteLength < 32) {
    throw new TypeError("platform SSO secret must contain at least 32 UTF-8 bytes");
  }
}

export async function verifyPlatformPrincipal(
  value: string,
  secret: string,
  now = Date.now(),
): Promise<PlatformPrincipal> {
  assertPlatformSsoSecret(secret);
  if (typeof value !== "string" || value.length > PLATFORM_MAX_HEADER_LENGTH) {
    throw new TypeError("signed platform header is invalid");
  }

  const parts = value.split(".");
  if (
    parts.length !== 3
    || parts[0] !== PLATFORM_SIGNATURE_VERSION
    || !parts[1]
    || !parts[2]
  ) {
    throw new TypeError("signed platform header is invalid");
  }

  const signature = base64UrlToBytes(parts[2]);
  if (!signature) throw new TypeError("signed platform header signature is invalid");
  const signedPart = `${parts[0]}.${parts[1]}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureValid = await crypto.subtle.verify(
    "HMAC",
    key,
    copyArrayBuffer(signature),
    encoder.encode(signedPart),
  );
  if (!signatureValid) throw new TypeError("signed platform header signature is invalid");

  const payloadBytes = base64UrlToBytes(parts[1]);
  if (!payloadBytes) throw new TypeError("signed platform header payload is invalid");
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    throw new TypeError("signed platform header payload is invalid");
  }

  const normalizedNow = Number(now);
  if (!isRecord(payload)) throw new TypeError("signed platform header claims are invalid or expired");
  const issuedAt = payload.issuedAt;
  const expiresAt = payload.expiresAt;
  if (
    payload.schemaVersion !== PLATFORM_PRINCIPAL_SCHEMA_VERSION
    || payload.audience !== PLATFORM_PRINCIPAL_AUDIENCE
    || !Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(expiresAt)
    || typeof issuedAt !== "number"
    || typeof expiresAt !== "number"
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > PLATFORM_MAX_TTL_MS
    || normalizedNow < issuedAt - PLATFORM_CLOCK_SKEW_MS
    || normalizedNow >= expiresAt
  ) {
    throw new TypeError("signed platform header claims are invalid or expired");
  }

  return Object.freeze({
    schemaVersion: PLATFORM_PRINCIPAL_SCHEMA_VERSION,
    audience: PLATFORM_PRINCIPAL_AUDIENCE,
    issuedAt,
    expiresAt,
    user: normalizePlatformUser(payload.user),
  });
}

function normalizePlatformUser(value: unknown): PlatformPrincipalUser {
  if (!isRecord(value)) throw new TypeError("platform user is required");
  const role = value.role === "admin" ? "admin" : "user";
  const user: PlatformPrincipalUser = {
    id: String(value.id || ""),
    username: String(value.username || ""),
    displayName: String(value.displayName || value.username || ""),
    role,
    teamId: role === "admin" ? null : String(value.teamId || ""),
    teamName: role === "admin" ? null : String(value.teamName || ""),
    group: role === "admin" ? null : canonicalPlatformGroup(value.group),
    createdAt: String(value.createdAt || new Date(0).toISOString()),
  };
  if (
    !/^usr_[a-f0-9]{32}$/u.test(user.id)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/u.test(user.username)
    || !user.displayName
    || !Number.isFinite(Date.parse(user.createdAt))
  ) {
    throw new TypeError("platform user identity is invalid");
  }
  if (
    role !== "admin"
    && (
      !user.teamId
      || !/^tea_[a-f0-9]{32}$/u.test(user.teamId)
      || !user.teamName
      || !user.group
      || !Object.hasOwn(PLATFORM_GROUP_DIVISIONS, user.group)
    )
  ) {
    throw new TypeError("platform participant team identity is invalid");
  }
  return Object.freeze(user);
}

function canonicalPlatformGroup(value: unknown): PlatformCompetitionGroup | null {
  if (typeof value !== "string") return null;
  const key = value.normalize("NFKC").trim().toLowerCase();
  return Object.hasOwn(LEGACY_PLATFORM_GROUPS, key)
    ? LEGACY_PLATFORM_GROUPS[key as keyof typeof LEGACY_PLATFORM_GROUPS]
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
