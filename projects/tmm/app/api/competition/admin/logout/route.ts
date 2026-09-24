import {
  ADMIN_SESSION_COOKIE,
  clearAdminSessionCookie,
  hashCompetitionSessionToken,
  isCompetitionSessionToken,
} from "@/lib/competition/auth";
import { deleteCompetitionAdminSession } from "@/lib/competition/db";
import {
  jsonError,
  jsonResponse,
  readCookie,
  requireSameOrigin,
} from "@/lib/competition/http";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    const token = readCookie(request, ADMIN_SESSION_COOKIE);
    if (token && isCompetitionSessionToken(token)) {
      await deleteCompetitionAdminSession(await hashCompetitionSessionToken(token));
    }
    const headers = new Headers();
    clearAdminSessionCookie(headers, request);
    return jsonResponse({ ok: true }, 200, headers);
  } catch (error) {
    return jsonError(error);
  }
}
