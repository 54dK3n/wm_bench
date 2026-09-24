import { CompetitionHttpError } from "./http";
import {
  assertPlatformSsoSecret,
  isPlatformSsoSecretConfigured,
  PLATFORM_PRINCIPAL_HEADER,
  type PlatformPrincipal,
  type PlatformPrincipalUser,
  verifyPlatformPrincipal,
} from "./platform-sso";
import type {
  CompetitionAdminSession,
  CompetitionTeam,
  CompetitionTeamSession,
} from "./types";

interface PlatformAuthenticationOptions {
  platformSsoSecret: unknown;
  now: number;
}

export interface PlatformTeamAuthenticationOptions extends PlatformAuthenticationOptions {
  upsertPlatformTeam: (
    user: PlatformPrincipalUser,
    now: number,
  ) => Promise<CompetitionTeam>;
  legacySession: () => Promise<CompetitionTeamSession | null>;
}

export interface PlatformAdminAuthenticationOptions extends PlatformAuthenticationOptions {
  legacySession: () => Promise<CompetitionAdminSession | null>;
}

export async function resolvePlatformAwareTeamSession(
  request: Request,
  options: PlatformTeamAuthenticationOptions,
): Promise<CompetitionTeamSession | null> {
  const principal = await platformPrincipalFromRequest(request, options);
  if (!principal) return options.legacySession();
  if (principal.user.role !== "user") return null;
  const team = await options.upsertPlatformTeam(principal.user, options.now);
  return Object.freeze({
    team,
    expiresAt: principal.expiresAt,
    platformUser: principal.user,
  });
}

export async function resolvePlatformAwareAdminSession(
  request: Request,
  options: PlatformAdminAuthenticationOptions,
): Promise<CompetitionAdminSession | null> {
  const principal = await platformPrincipalFromRequest(request, options);
  if (!principal) return options.legacySession();
  if (principal.user.role !== "admin") return null;
  return Object.freeze({
    adminId: 1,
    expiresAt: principal.expiresAt,
    platformUser: principal.user,
  });
}

async function platformPrincipalFromRequest(
  request: Request,
  options: PlatformAuthenticationOptions,
): Promise<PlatformPrincipal | null> {
  const header = request.headers.get(PLATFORM_PRINCIPAL_HEADER);
  if (!header) return null;
  if (!isPlatformSsoSecretConfigured(options.platformSsoSecret)) {
    throw new CompetitionHttpError(
      503,
      "platform_sso_unavailable",
      "统一平台登录校验暂不可用，请联系管理员",
    );
  }
  try {
    assertPlatformSsoSecret(options.platformSsoSecret);
  } catch {
    throw new CompetitionHttpError(
      503,
      "platform_sso_unavailable",
      "统一平台登录校验暂不可用，请联系管理员",
    );
  }
  try {
    return await verifyPlatformPrincipal(header, options.platformSsoSecret, options.now);
  } catch {
    throw new CompetitionHttpError(
      401,
      "invalid_platform_principal",
      "统一平台登录信息无效或已过期，请重新登录",
    );
  }
}
