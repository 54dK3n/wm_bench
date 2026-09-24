import {
  createCompetitionAdminSession,
  createCompetitionTeamSession,
  findCompetitionAdminSession,
  findCompetitionTeamSession,
  getCompetitionEnv,
  type CreateCompetitionSessionInput,
  upsertPlatformCompetitionTeam,
} from "./db";
import {
  appendCookie,
  CompetitionHttpError,
  expireCookie,
  readCookie,
} from "./http";
import {
  PLATFORM_PRINCIPAL_HEADER,
  type PlatformPrincipalUser,
} from "./platform-sso";
import {
  resolvePlatformAwareAdminSession,
  resolvePlatformAwareTeamSession,
} from "./platform-authentication";
import type {
  CompetitionAdminSession,
  CompetitionSessionSecret,
  CompetitionTeam,
  CompetitionTeamSession,
} from "./types";

export const TEAM_SESSION_COOKIE = "competition_team_session";
export const ADMIN_SESSION_COOKIE = "competition_admin_session";
export const TEAM_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

const PASSWORD_ALGORITHM = "pbkdf2-sha256";
const PASSWORD_ITERATIONS = 600_000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;
const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DUMMY_PASSWORD_HASH =
  "pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const encoder = new TextEncoder();

interface ParsedPasswordHash {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

interface TimingSafeSubtleCrypto extends SubtleCrypto {
  timingSafeEqual?: (
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ) => boolean;
}

export interface CompetitionAuthenticationOptions {
  now?: number;
  platformSsoSecret?: unknown;
  upsertPlatformTeam?: (
    user: PlatformPrincipalUser,
    now: number,
  ) => Promise<CompetitionTeam>;
  findLegacyTeamSession?: (
    tokenHash: string,
    now?: number,
  ) => Promise<CompetitionTeamSession | null>;
  findLegacyAdminSession?: (
    tokenHash: string,
    now?: number,
  ) => Promise<CompetitionAdminSession | null>;
}

export function normalizeCompetitionTeamName(value: string): {
  teamName: string;
  teamNameKey: string;
} {
  const teamName = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const characters = Array.from(teamName);
  if (characters.length < 2 || characters.length > 40) {
    throw new CompetitionHttpError(400, "invalid_team_name", "队伍名称需为 2 至 40 个字符");
  }
  if (/[\p{Cc}\p{Cf}]/u.test(teamName)) {
    throw new CompetitionHttpError(400, "invalid_team_name", "队伍名称包含不可用字符");
  }
  return {
    teamName,
    teamNameKey: teamName.toLowerCase(),
  };
}

export function assertCompetitionPassword(
  password: string,
  minimumLength = 8,
): void {
  const length = Array.from(password).length;
  if (length < minimumLength || length > 128 || encoder.encode(password).byteLength > 256) {
    throw new CompetitionHttpError(
      400,
      "invalid_password",
      `密码需为 ${minimumLength} 至 128 个字符`,
    );
  }
}

export async function hashCompetitionPassword(password: string): Promise<string> {
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return [
    PASSWORD_ALGORITHM,
    String(PASSWORD_ITERATIONS),
    bytesToBase64Url(salt),
    bytesToBase64Url(hash),
  ].join("$");
}

export async function verifyCompetitionPassword(
  password: string,
  encodedHash: string | null | undefined,
): Promise<boolean> {
  const parsed = parsePasswordHash(encodedHash) ?? parsePasswordHash(DUMMY_PASSWORD_HASH);
  if (!parsed) throw new Error("内置密码校验参数无效");
  const actual = await derivePassword(password, parsed.salt, parsed.iterations);
  return encodedHash !== null && encodedHash !== undefined && safeEqual(actual, parsed.hash);
}

export async function verifyCompetitionAdminSetupKey(
  supplied: string,
  configured: unknown,
): Promise<boolean> {
  if (
    typeof configured !== "string"
    || configured.length < 16
    || configured.length > 256
    || supplied.length > 256
  ) return false;
  const [suppliedDigest, configuredDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);
  return safeEqual(new Uint8Array(suppliedDigest), new Uint8Array(configuredDigest));
}

export function competitionPasswordNeedsRehash(encodedHash: string): boolean {
  const parsed = parsePasswordHash(encodedHash);
  return parsed === null || parsed.iterations !== PASSWORD_ITERATIONS;
}

export async function createCompetitionSessionSecret(): Promise<CompetitionSessionSecret> {
  const token = bytesToBase64Url(randomBytes(SESSION_TOKEN_BYTES));
  return { token, tokenHash: await hashCompetitionSessionToken(token) };
}

export async function hashCompetitionSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function isCompetitionSessionToken(token: string): boolean {
  return SESSION_TOKEN_PATTERN.test(token);
}

export async function issueCompetitionTeamSession(
  teamId: string,
  now = Date.now(),
): Promise<{ secret: CompetitionSessionSecret; expiresAt: number }> {
  const secret = await createCompetitionSessionSecret();
  const expiresAt = now + TEAM_SESSION_TTL_MS;
  await createCompetitionTeamSession(teamId, sessionInput(secret, now, expiresAt));
  return { secret, expiresAt };
}

export async function issueCompetitionAdminSession(
  now = Date.now(),
): Promise<{ session: CompetitionAdminSession; secret: CompetitionSessionSecret }> {
  const secret = await createCompetitionSessionSecret();
  const expiresAt = now + ADMIN_SESSION_TTL_MS;
  const session = await createCompetitionAdminSession(sessionInput(secret, now, expiresAt));
  return { session, secret };
}

export async function getTeamSession(
  request: Request,
  options: CompetitionAuthenticationOptions = {},
): Promise<CompetitionTeamSession | null> {
  const now = options.now ?? Date.now();
  const headerPresent = request.headers.has(PLATFORM_PRINCIPAL_HEADER);
  const secret = Object.hasOwn(options, "platformSsoSecret")
    ? options.platformSsoSecret
    : headerPresent ? getCompetitionEnv().PLATFORM_SSO_SECRET : undefined;
  return resolvePlatformAwareTeamSession(request, {
    platformSsoSecret: secret,
    now,
    upsertPlatformTeam: options.upsertPlatformTeam ?? upsertPlatformCompetitionTeam,
    legacySession: async () => {
      const token = readCookie(request, TEAM_SESSION_COOKIE);
      if (!token || !isCompetitionSessionToken(token)) return null;
      return (options.findLegacyTeamSession ?? findCompetitionTeamSession)(
        await hashCompetitionSessionToken(token),
        now,
      );
    },
  });
}

export async function requireTeamSession(request: Request): Promise<CompetitionTeamSession> {
  const session = await getTeamSession(request);
  if (!session) {
    throw new CompetitionHttpError(401, "team_auth_required", "请先登录队伍账号");
  }
  return session;
}

export async function getAdminSession(
  request: Request,
  options: CompetitionAuthenticationOptions = {},
): Promise<CompetitionAdminSession | null> {
  const now = options.now ?? Date.now();
  const headerPresent = request.headers.has(PLATFORM_PRINCIPAL_HEADER);
  const secret = Object.hasOwn(options, "platformSsoSecret")
    ? options.platformSsoSecret
    : headerPresent ? getCompetitionEnv().PLATFORM_SSO_SECRET : undefined;
  return resolvePlatformAwareAdminSession(request, {
    platformSsoSecret: secret,
    now,
    legacySession: async () => {
      const token = readCookie(request, ADMIN_SESSION_COOKIE);
      if (!token || !isCompetitionSessionToken(token)) return null;
      return (options.findLegacyAdminSession ?? findCompetitionAdminSession)(
        await hashCompetitionSessionToken(token),
        now,
      );
    },
  });
}

export async function requireAdminSession(request: Request): Promise<CompetitionAdminSession> {
  const session = await getAdminSession(request);
  if (!session) {
    throw new CompetitionHttpError(401, "admin_auth_required", "请先登录管理员账号");
  }
  return session;
}

export function setTeamSessionCookie(
  headers: Headers,
  request: Request,
  token: string,
): void {
  appendCookie(headers, request, TEAM_SESSION_COOKIE, token, {
    maxAgeSeconds: TEAM_SESSION_TTL_MS / 1_000,
  });
}

export function clearTeamSessionCookie(headers: Headers, request: Request): void {
  expireCookie(headers, request, TEAM_SESSION_COOKIE);
}

export function setAdminSessionCookie(
  headers: Headers,
  request: Request,
  token: string,
): void {
  appendCookie(headers, request, ADMIN_SESSION_COOKIE, token, {
    maxAgeSeconds: ADMIN_SESSION_TTL_MS / 1_000,
  });
}

export function clearAdminSessionCookie(headers: Headers, request: Request): void {
  expireCookie(headers, request, ADMIN_SESSION_COOKIE);
}

function sessionInput(
  secret: CompetitionSessionSecret,
  createdAt: number,
  expiresAt: number,
): CreateCompetitionSessionInput {
  return { tokenHash: secret.tokenHash, createdAt, expiresAt };
}

async function derivePassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: copyArrayBuffer(salt), iterations },
    key,
    PASSWORD_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function parsePasswordHash(value: string | null | undefined): ParsedPasswordHash | null {
  if (!value) return null;
  const [algorithm, iterationText, saltText, hashText, extra] = value.split("$");
  const iterations = Number(iterationText);
  if (
    algorithm !== PASSWORD_ALGORITHM ||
    extra !== undefined ||
    !Number.isInteger(iterations) ||
    iterations < 100_000 ||
    iterations > 2_000_000
  ) return null;
  const salt = base64UrlToBytes(saltText);
  const hash = base64UrlToBytes(hashText);
  if (!salt || !hash || salt.byteLength < 16 || salt.byteLength > 64 || hash.byteLength !== 32) {
    return null;
  }
  return { iterations, salt, hash };
}

function randomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  crypto.getRandomValues(value);
  return value;
}

function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
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

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const subtle = crypto.subtle as TimingSafeSubtleCrypto;
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(left, right);
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
