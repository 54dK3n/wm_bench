import {
  assertCompetitionPassword,
  createCompetitionSessionSecret,
  hashCompetitionPassword,
  normalizeCompetitionTeamName,
  setTeamSessionCookie,
  TEAM_SESSION_TTL_MS,
} from "@/lib/competition/auth";
import { createCompetitionTeamWithSession } from "@/lib/competition/db";
import {
  CompetitionHttpError,
  jsonError,
  jsonResponse,
  readJsonObject,
  requireSameOrigin,
  requireStringField,
} from "@/lib/competition/http";
import { isCompetitionDivision } from "@/lib/competition/types";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    const payload = await readJsonObject(request);
    const rawTeamName = requireStringField(payload, "teamName", 80);
    const password = requireStringField(payload, "password", 128);
    const division = payload.division;
    if (!isCompetitionDivision(division)) {
      throw new CompetitionHttpError(400, "invalid_division", "请选择有效的参赛组别");
    }
    const { teamName, teamNameKey } = normalizeCompetitionTeamName(rawTeamName);
    assertCompetitionPassword(password);

    const [passwordHash, secret] = await Promise.all([
      hashCompetitionPassword(password),
      createCompetitionSessionSecret(),
    ]);
    const createdAt = Date.now();
    const expiresAt = createdAt + TEAM_SESSION_TTL_MS;
    const team = await createCompetitionTeamWithSession({
      id: crypto.randomUUID(),
      teamName,
      teamNameKey,
      division,
      passwordHash,
      tokenHash: secret.tokenHash,
      createdAt,
      expiresAt,
    });

    const headers = new Headers();
    setTeamSessionCookie(headers, request, secret.token);
    return jsonResponse({ team, latestSubmission: null, expiresAt }, 201, headers);
  } catch (error) {
    return jsonError(error);
  }
}
