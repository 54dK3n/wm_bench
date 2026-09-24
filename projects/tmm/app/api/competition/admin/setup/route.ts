import {
  ADMIN_SESSION_TTL_MS,
  assertCompetitionPassword,
  createCompetitionSessionSecret,
  hashCompetitionPassword,
  setAdminSessionCookie,
  verifyCompetitionAdminSetupKey,
} from "@/lib/competition/auth";
import {
  getCompetitionEnv,
  isCompetitionAdminSetup,
  setupCompetitionAdminWithSession,
} from "@/lib/competition/db";
import {
  CompetitionHttpError,
  jsonError,
  jsonResponse,
  readJsonObject,
  requireSameOrigin,
  requireStringField,
} from "@/lib/competition/http";

export async function GET(): Promise<Response> {
  try {
    return jsonResponse({ configured: await isCompetitionAdminSetup() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    if (await isCompetitionAdminSetup()) {
      throw new CompetitionHttpError(409, "admin_already_setup", "管理员密码已经设置");
    }
    const payload = await readJsonObject(request);
    const setupKey = requireStringField(payload, "setupKey", 256);
    const configuredSetupKey = getCompetitionEnv().COMPETITION_ADMIN_SETUP_KEY;
    if (typeof configuredSetupKey !== "string" || configuredSetupKey.length < 16) {
      throw new CompetitionHttpError(
        503,
        "admin_setup_unavailable",
        "管理员初始化口令未配置，请先设置 COMPETITION_ADMIN_SETUP_KEY",
      );
    }
    if (!await verifyCompetitionAdminSetupKey(setupKey, configuredSetupKey)) {
      throw new CompetitionHttpError(403, "invalid_setup_key", "管理员初始化口令不正确");
    }
    const password = requireStringField(payload, "password", 128);
    assertCompetitionPassword(password, 12);
    const [passwordHash, secret] = await Promise.all([
      hashCompetitionPassword(password),
      createCompetitionSessionSecret(),
    ]);
    const createdAt = Date.now();
    const expiresAt = createdAt + ADMIN_SESSION_TTL_MS;
    const session = await setupCompetitionAdminWithSession(passwordHash, {
      tokenHash: secret.tokenHash,
      createdAt,
      expiresAt,
    });
    const headers = new Headers();
    setAdminSessionCookie(headers, request, secret.token);
    return jsonResponse({ configured: true, expiresAt: session.expiresAt }, 201, headers);
  } catch (error) {
    return jsonError(error);
  }
}
