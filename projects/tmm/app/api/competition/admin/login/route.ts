import {
  issueCompetitionAdminSession,
  setAdminSessionCookie,
  verifyCompetitionPassword,
} from "@/lib/competition/auth";
import { findCompetitionAdminCredential } from "@/lib/competition/db";
import {
  CompetitionHttpError,
  jsonError,
  jsonResponse,
  readJsonObject,
  requireSameOrigin,
  requireStringField,
} from "@/lib/competition/http";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    const payload = await readJsonObject(request);
    const password = requireStringField(payload, "password", 128);
    const credential = await findCompetitionAdminCredential();
    const valid = await verifyCompetitionPassword(password, credential?.passwordHash);
    if (!credential || !valid) {
      throw new CompetitionHttpError(401, "invalid_credentials", "管理员密码错误");
    }
    const { session, secret } = await issueCompetitionAdminSession();
    const headers = new Headers();
    setAdminSessionCookie(headers, request, secret.token);
    return jsonResponse({ authenticated: true, expiresAt: session.expiresAt }, 200, headers);
  } catch (error) {
    return jsonError(error);
  }
}
