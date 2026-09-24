import {
  clearTeamSessionCookie,
  hashCompetitionSessionToken,
  isCompetitionSessionToken,
  TEAM_SESSION_COOKIE,
} from "@/lib/competition/auth";
import { deleteCompetitionTeamSession } from "@/lib/competition/db";
import {
  jsonError,
  jsonResponse,
  readCookie,
  requireSameOrigin,
} from "@/lib/competition/http";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    const token = readCookie(request, TEAM_SESSION_COOKIE);
    if (token && isCompetitionSessionToken(token)) {
      await deleteCompetitionTeamSession(await hashCompetitionSessionToken(token));
    }
    const headers = new Headers();
    clearTeamSessionCookie(headers, request);
    return jsonResponse({ ok: true }, 200, headers);
  } catch (error) {
    return jsonError(error);
  }
}
